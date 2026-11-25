import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createReadonlySnapshot } from "@aquarius/core/adapter";
import { runExec } from "../src/exec";
import { codexOptionsSchema } from "../src/options";
import type { AdapterExecuteRequest } from "@aquarius/core/adapter";

test.skipIf(process.platform === "win32")(
  "reports referenced files and rules without revealing commands or reasoning text",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aquarius-progress-test-"));
    const executable = join(root, "codex");
    const resultPath = join(root, "result.json");
    const detailsPath = ".aquarius-rules-fixture/rule.json";
    const messages: string[] = [];
    const ruleCommand = `cat '${detailsPath}'`;
    const firstCommand = "printf secret-command-value; cat src/main.tsx";
    const secondCommand = `cat '${root}/src/with space.ts'`;
    const commandEvent = (type: string, id: string, command: string) => ({
      type,
      item: { type: "command_execution", id, command },
    });
    const events = [
      { type: "turn.started" },
      commandEvent("item.started", "rule", ruleCommand),
      commandEvent("item.completed", "rule", ruleCommand),
      commandEvent("item.started", "first", firstCommand),
      commandEvent("item.started", "second", secondCommand),
      commandEvent("item.completed", "first", firstCommand),
      commandEvent("item.completed", "second", secondCommand),
      { type: "item.completed", item: { type: "reasoning", text: "private-reasoning-text" } },
      { type: "item.completed", item: { type: "agent_message", text: "private-output-text" } },
      { type: "turn.completed" },
    ];

    try {
      await writeFile(
        executable,
        `#!${process.execPath}\n` +
          'const fs = require("node:fs");\n' +
          'process.stdin.on("data", () => {});\n' +
          'process.stdin.on("end", () => {\n' +
          `  fs.writeFileSync(${JSON.stringify(resultPath)}, "{}");\n` +
          `  for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n` +
          "});\n",
        { mode: 0o755 },
      );
      const input: AdapterExecuteRequest = {
        projectRoot: root,
        readableFiles: ["src/main.ts", "src/main.tsx", "src/with space.ts"],
        prompt: "Inspect the fixture.",
        ruleResources: [
          {
            ruleId: "fixture/check",
            scope: "file",
            applicability: "Source files",
            detailsPath,
            content: "{}",
            contentHash: "a".repeat(64),
          },
        ],
        outputSchema: { type: "object" },
        options: {},
        signal: new AbortController().signal,
        onProgress: (message) => messages.push(message),
      };
      await expect(
        runExec(executable, input, {}, root, root, join(root, "schema.json"), resultPath, []),
      ).resolves.toEqual({});

      expect(messages).toContain("Inspecting rule fixture/check");
      expect(messages).toContain("Inspecting src/main.tsx");
      expect(messages).not.toContain("Inspecting src/main.ts");
      expect(messages.filter((message) => message === "Inspecting src/with space.ts")).toHaveLength(
        2,
      );
      expect(messages).toContain("AI analyzing; last referenced: src/with space.ts");
      expect(messages.at(-1)).toBe("Reading Codex response");
      const output = messages.join("\n");
      expect(output).not.toContain("secret-command-value");
      expect(output).not.toContain("private-reasoning-text");
      expect(output).not.toContain("private-output-text");
      expect(output).not.toContain(root);
      expect(output).not.toContain(detailsPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("snapshot preparation reports copied file paths and counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "aquarius-snapshot-progress-"));
  const project = join(root, "source");
  const view = join(root, "view");
  const messages: string[] = [];
  try {
    await mkdir(project);
    await mkdir(view);
    await writeFile(join(project, "first.ts"), "first\n");
    await writeFile(join(project, "second.ts"), "second\n");
    await createReadonlySnapshot(
      project,
      ["first.ts", "second.ts"],
      view,
      new AbortController().signal,
      (message) => messages.push(message),
    );
    expect(messages).toEqual([
      "Preparing snapshot 1/2: first.ts",
      "Preparing snapshot 2/2: second.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32").each([
  { ephemeral: undefined, expectEphemeral: true },
  { ephemeral: false, expectEphemeral: false },
  { ephemeral: true, expectEphemeral: true },
])(
  "controls session persistence with ephemeral=$ephemeral",
  async ({ ephemeral, expectEphemeral }) => {
    const root = await mkdtemp(join(tmpdir(), "aquarius-persistence-test-"));
    const executable = join(root, "codex");
    const argumentsPath = join(root, "arguments.json");
    const resultPath = join(root, "result.json");
    try {
      await writeFile(
        executable,
        `#!${process.execPath}\n` +
          'const fs = require("node:fs");\n' +
          'process.stdin.on("data", () => {});\n' +
          'process.stdin.on("end", () => {\n' +
          `  fs.writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));\n` +
          `  fs.writeFileSync(${JSON.stringify(resultPath)}, "{}");\n` +
          "});\n",
        { mode: 0o755 },
      );
      await runExec(
        executable,
        {
          projectRoot: root,
          readableFiles: [],
          prompt: "Inspect the fixture.",
          ruleResources: [],
          outputSchema: { type: "object" },
          options: {},
          signal: new AbortController().signal,
        },
        { ephemeral },
        root,
        root,
        join(root, "schema.json"),
        resultPath,
        [],
      );
      const args = JSON.parse(await readFile(argumentsPath, "utf8"));
      expect(args.includes("--ephemeral")).toBe(expectEphemeral);
      expect(args).toContain("--ignore-user-config");
      expect(args).toContain("--ignore-rules");
      expect(args).toContain("--strict-config");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("validates the new persistence option and defaults to ephemeral sessions", () => {
  expect(codexOptionsSchema.parse({})).toEqual({ ephemeral: true });
  expect(codexOptionsSchema.parse({ model: "  model  " }).model).toBe("model");
  expect(codexOptionsSchema.safeParse({ ephemeral: "true" }).success).toBe(false);
  expect(codexOptionsSchema.safeParse({ noEphemeral: true }).success).toBe(false);
});
