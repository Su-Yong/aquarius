import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";

import * as antigravityProcess from "../src/process";
import { mockTest, prepareFixture } from "./fixtures";

mockTest("sends one wrapped prompt, closes stdin, and reads structured output", async () => {
  const fixture = await prepareFixture({
    action: `result({ status: "SUCCESS", structured_output: { source: "structured" }, response: '{"source":"text"}' });`,
  });
  const session = await fixture.createSession();
  const progress: string[] = [];
  const request = fixture.request({ onProgress: (message) => progress.push(message) });

  await expect(session.execute(request)).resolves.toEqual({ source: "structured" });
  const [{ args, schema, schemaPath, stdin }] = await fixture.invocations();
  expect(args).toEqual([
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--json-schema",
    schemaPath,
    "--disable-slash-commands",
    "--sandbox",
  ]);
  expect(schema).toEqual(request.outputSchema);
  expect(stdin.split("\n")).toHaveLength(2);
  expect(stdin.endsWith("\n")).toBe(true);
  const frame = JSON.parse(stdin);
  expect(frame).toEqual({
    event: "user",
    message: { content: expect.stringContaining("read-only snapshot") },
  });
  expect(frame.message.content).toContain(request.prompt);
  expect(frame.message.content).toMatch(/does not support provisional analysis updates/iu);
  expect(progress[0]).toBe("Starting Antigravity analysis");
  expect(progress.at(-1)).toBe("Reading Antigravity response");
});

mockTest(
  "passes explicit cli options and exposes only selected settings in session info",
  async () => {
    const fixture = await prepareFixture({
      options: {
        model: "example-model",
        effort: "high",
        agent: "local-reader",
        mode: "plan",
        sandbox: false,
      },
      action: `result({ status: "SUCCESS", response: "[1,true]" });`,
    });
    const session = await fixture.createSession();
    await expect(session.execute(fixture.request())).resolves.toEqual([1, true]);
    expect(session.info).toEqual({
      adapter: "antigravity",
      model: "example-model",
      details: { effort: "high", agent: "local-reader", mode: "plan", sandbox: "false" },
    });
    const [{ args }] = await fixture.invocations();
    for (const [flag, value] of Object.entries({
      "--model": "example-model",
      "--effort": "high",
      "--agent": "local-reader",
      "--mode": "plan",
    })) {
      expect(args.slice(args.indexOf(flag), args.indexOf(flag) + 2)).toEqual([flag, value]);
    }
    expect(args).not.toContain("--sandbox");
  },
);

test.skipIf(process.platform !== "win32")(
  "runs a Windows batch launcher with safely quoted arguments",
  async () => {
    const agent = "local reader & viewer";
    const fixture = await prepareFixture({ options: { agent } });
    const session = await fixture.createSession();
    await expect(session.execute(fixture.request())).resolves.toEqual({ ok: true });
    const [{ args }] = await fixture.invocations();
    expect(args[args.indexOf("--agent") + 1]).toBe(agent);

    const unsafeFixture = await prepareFixture({ options: { agent: "%USERNAME%" } });
    const unsafeSession = await unsafeFixture.createSession();
    await expect(unsafeSession.execute(unsafeFixture.request())).rejects.toMatchObject({
      code: "ANTIGRAVITY_EXECUTION_FAILED",
      message: expect.stringContaining("cannot be passed safely"),
    });
    expect(await unsafeFixture.invocations()).toEqual([]);
  },
);

mockTest.each([null, false, 0, ""])("accepts %j as a valid structured value", async (value) => {
  const fixture = await prepareFixture({
    action: `result({ status: "SUCCESS", structured_output: ${JSON.stringify(value)}, response: "{}" });`,
  });
  const session = await fixture.createSession();
  await expect(session.execute(fixture.request())).resolves.toBe(value);
});

mockTest("reports only approved paths and tracks concurrent tool progress", async () => {
  const fixture = await prepareFixture({
    action: `
emit({ event: "init", init: { cwd: viewRoot, tools: ["run_command", "write_to_file"] } });
const tool = (step_index, state, tool_name, parameters) => step({
  step_type: "tool", step_index, state, tool_name, tool_info: { name: tool_name, parameters },
});
tool(4, "ACTIVE", "run_command", { CommandLine: 'grep -n example allowed.txt notes.txt one.txt two.txt' });
tool(5, "ACTIVE", "view_file", { TargetFile: path.join(viewRoot, rulePath) });
tool(4, "DONE", "run_command");
tool(5, "DONE", "view_file");
tool(6, "ACTIVE", "grep_search", { SearchPath: "ignored/secret.txt", Query: "something" });
tool(6, "DONE", "grep_search");
result({ status: "SUCCESS", structured_output: {} });
`,
  });
  const extraFiles = ["notes.txt", "one.txt", "two.txt"];
  await Promise.all(extraFiles.map((file) => writeFile(join(fixture.projectRoot, file), "note")));
  const readableFiles = [...fixture.context.readableFiles, ...extraFiles];
  const session = await fixture.createSession({ readableFiles });
  const progress: string[] = [];

  await expect(
    session.execute(fixture.request({ onProgress: (message) => progress.push(message) })),
  ).resolves.toEqual({});
  expect(progress).toContain("Inspecting allowed.txt, notes.txt, one.txt (+1 more)");
  const ruleInspection = progress.indexOf("Inspecting rule fixture/check");
  const finishedTools = progress.indexOf("AI analyzing; last referenced: rule fixture/check");
  expect(ruleInspection).toBeGreaterThan(0);
  expect(finishedTools).toBeGreaterThan(ruleInspection);
  expect(progress).toContain("Inspecting project");
  expect(progress.join("\n")).not.toContain("ignored/secret.txt");
});

mockTest("disables provisional updates in the prompt and ignores intermediate frames", async () => {
  const update = { type: "aquarius.analysis_update", revision: 1, files: ["allowed.txt"] };
  const fixture = await prepareFixture({
    action: `
const frame = ${JSON.stringify(JSON.stringify(update))};
const response = (step_index, state, text_delta) => step({ step_type: "agent_response", step_index, state, text_delta });
response(8, "ACTIVE", frame.slice(0, 10));
response(8, "DONE", frame.slice(10));
result({ status: "SUCCESS", structured_output: { ok: true } });
`,
  });
  const session = await fixture.createSession();
  const updates: unknown[] = [];
  const request = fixture.request({ onAnalysisUpdate: (update) => updates.push(update) });

  await expect(session.execute(request)).resolves.toEqual({ ok: true });
  expect(updates).toEqual([]);
  const [{ stdin }] = await fixture.invocations();
  expect(JSON.parse(stdin).message.content).toMatch(
    /does not support provisional analysis updates/iu,
  );
});

mockTest.each([
  { state: "ACTIVE", tool_name: "write_to_file" },
  { state: "DONE", tool_name: "write_to_file" },
  { state: "ACTIVE", tool_name: "sed_file" },
  { state: "ACTIVE", tool_name: "notebook_edit" },
  { state: "ACTIVE", tool_name: "notebook_execution" },
  { state: "ACTIVE", tool_name: "delete_knowledge" },
  { state: "ACTIVE", tool_info: { name: "delete_file" } },
  { state: "DONE", tool_info: { name: "delete_file" } },
  { state: "ACTIVE", tool_name: "view_file", tool_info: { name: "edit_file" } },
  { state: "ACTIVE", tool_name: "search_web" },
  { state: "ACTIVE", tool_name: "browser_open" },
  { state: "ACTIVE", tool_name: "open_browser_url" },
  { state: "ACTIVE", tool_name: "capture_browser_screenshot" },
  { state: "ACTIVE", tool_name: "execute_browser_javascript" },
  { state: "ACTIVE", tool_name: "call_mcp_tool" },
  { state: "ACTIVE", tool_name: "read_resource" },
  { state: "ACTIVE", tool_name: "list_resources" },
  { state: "ACTIVE", tool_name: "list_plugin_accounts" },
  { state: "ACTIVE", tool_name: "search_marketplace" },
  { state: "ACTIVE", tool_name: "manage_inbox" },
  { state: "ACTIVE", tool_name: "run_workflow" },
  { state: "ACTIVE", tool_name: "generate_image" },
  { state: "ACTIVE", tool_name: "mcp_server_query" },
  { state: "ACTIVE", tool_name: "mcp/server/query" },
  { state: "ACTIVE", tool_name: "server/mcp:tool" },
  { state: "DONE", step_type: "custom", tool_name: "write_to_file" },
  { state: "ACTIVE", step_type: "checkpoint", subagent_info: { subagents: [] } },
  { state: "DONE", step_type: "checkpoint", subagent_info: { subagents: [] } },
])("terminates a process emitting a forbidden tool or subagent event (%j)", async (tool) => {
  const fixture = await prepareFixture({
    action: `step({ step_index: 1, step_type: "tool", ...${JSON.stringify(tool)} }); hold();`,
  });
  const session = await fixture.createSession();
  await expect(session.execute(fixture.request())).rejects.toMatchObject({
    code: "ANTIGRAVITY_TOOL_VIOLATION",
  });
});

mockTest("ignores null subagent_info fields on normal steps", async () => {
  const fixture = await prepareFixture({
    action: `
step({ step_index: 1, step_type: "checkpoint", state: "DONE", subagent_info: null });
result({ status: "SUCCESS", structured_output: { ok: true } });
`,
  });
  const session = await fixture.createSession();
  await expect(session.execute(fixture.request())).resolves.toEqual({ ok: true });
});

mockTest("reports result status when a failed result omits error and stderr", async () => {
  const fixture = await prepareFixture({
    action: `result({ status: "CANCELED" });`,
  });
  const session = await fixture.createSession();
  await expect(session.execute(fixture.request())).rejects.toMatchObject({
    code: "ANTIGRAVITY_EXECUTION_FAILED",
    message: expect.stringContaining("status=CANCELED"),
  });
});

mockTest.each(["not JSON\n", "[]\n", "null\n", "42\n"])(
  "terminates on an invalid NDJSON record (%j)",
  async (message) => {
    const fixture = await prepareFixture({ action: `stdout(${JSON.stringify(message)}); hold();` });
    const session = await fixture.createSession();
    await expect(session.execute(fixture.request())).rejects.toMatchObject({
      code: "ANTIGRAVITY_EVENT_INVALID",
    });
  },
);

mockTest.each([
  { action: "", code: "RESPONSE_INVALID" },
  { action: `result({ status: "SUCCESS", response: "not JSON" });`, code: "RESPONSE_INVALID" },
  { action: `result({ status: "SUCCESS" });`, code: "RESPONSE_INVALID" },
  { action: "process.exitCode = 16;", code: "EXECUTION_FAILED" },
  {
    action: `result({ status: "SUCCESS", structured_output: {} }); process.exitCode = 16;`,
    code: "EXECUTION_FAILED",
  },
])("validates terminal protocol and process exit ($action)", async ({ action, code }) => {
  const fixture = await prepareFixture({ action });
  const session = await fixture.createSession();
  await expect(session.execute(fixture.request())).rejects.toMatchObject({
    code: `ANTIGRAVITY_${code}`,
  });
});

mockTest(
  "redacts snapshot, project and executable paths while retaining result and stderr errors",
  async () => {
    const fixture = await prepareFixture({
      action: `
result({ status: "ERROR", error: "Authentication required at " + viewRoot + "\\n" + executable });
stderr("Unknown model configured for " + projectRoot + " in " + runRoot);
`,
    });
    const session = await fixture.createSession();
    const execution = session.execute(fixture.request());
    await expect(execution).rejects.toMatchObject({ code: "ANTIGRAVITY_EXECUTION_FAILED" });
    await expect(execution).rejects.toThrow(/Authentication required.*Unknown model/iu);
    await expect(execution).rejects.toThrow("[redacted path]");
    const [{ viewRoot }] = await fixture.invocations();
    for (const path of [fixture.projectRoot, fixture.executable, viewRoot, dirname(viewRoot)]) {
      await expect(execution).rejects.not.toThrow(path);
    }
  },
);

mockTest("reports the early child failure when the stdin pipe closes", async () => {
  const fixture = await prepareFixture({
    beforeReadingStdin: `fs.closeSync(0); stderr("Authentication required"); process.exit(16);`,
  });
  const session = await fixture.createSession();
  const execution = session.execute(fixture.request({ prompt: "prompt ".repeat(200_000) }));
  await expect(execution).rejects.toMatchObject({ code: "ANTIGRAVITY_EXECUTION_FAILED" });
  await expect(execution).rejects.toThrow("Authentication required");
  expect(await fixture.invocations()).toEqual([]);
});

mockTest("reports other stdin write failures while the child is still running", async () => {
  const fixture = await prepareFixture({ action: "hold();" });
  const session = await fixture.createSession();
  const spawn = antigravityProcess.spawnAntigravity;
  const launcher = vi
    .spyOn(antigravityProcess, "spawnAntigravity")
    .mockImplementation((...args) => {
      const running = spawn(...args);
      const error = Object.assign(new Error("Mock stdin write failed."), { code: "EIO" });
      queueMicrotask(() => running.child.stdin.destroy(error));
      return running;
    });

  try {
    const request = fixture.request({ signal: AbortSignal.timeout(1_000) });
    await expect(session.execute(request)).rejects.toMatchObject({
      code: "ANTIGRAVITY_EXECUTION_FAILED",
      message: expect.stringContaining("Mock stdin write failed."),
    });
  } finally {
    launcher.mockRestore();
  }
});

mockTest.each([
  `result({ status: "SUCCESS", structured_output: { nested: [runRoot] } });`,
  `result({ status: "SUCCESS", response: JSON.stringify({ [viewRoot]: true }) });`,
])("rejects internal paths in results (%s)", async (action) => {
  const fixture = await prepareFixture({ action });
  const session = await fixture.createSession();
  await expect(session.execute(fixture.request())).rejects.toMatchObject({
    code: "ANTIGRAVITY_RESPONSE_INVALID",
  });
});
