import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { AdapterSessionContext } from "@aquarius/core/adapter";
import { codexAdapter, codexOptionsSchema, type CodexOptions } from "../src/index";
import { ruleResource } from "./fixtures";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface Invocation {
  kind: "app-server" | "sandbox" | "exec" | "observed";
  viewRoot: string;
  args: string[];
  group?: string;
  schemaPath?: string;
  resultPath?: string;
  schemas?: string[];
}

interface FixtureOptions {
  options?: CodexOptions;
  effectiveConfig?: Record<string, unknown>;
  origins?: Record<string, unknown>;
  probeFailure?: "rpc" | "stderr";
}

const prepareFixture = async (fixture: FixtureOptions = {}) => {
  const root = await mkdtemp(join(tmpdir(), "aquarius-session-test-"));
  temporaryDirectories.push(root);
  const executable = join(root, "mock-codex");
  const invocationsPath = join(root, "invocations.jsonl");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  await writeFile(join(projectRoot, "allowed.txt"), "snapshot input");
  await writeFile(join(projectRoot, "unselected.txt"), "outside the snapshot");
  const rule = ruleResource();
  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const viewRoot = process.cwd();
const invocationsPath = ${JSON.stringify(invocationsPath)};
const record = (kind, data = {}) => fs.appendFileSync(invocationsPath, JSON.stringify({ kind, viewRoot, args, ...data }) + "\\n");
const invocations = () => fs.readFileSync(invocationsPath, "utf8").trim().split("\\n").map(JSON.parse);
const waitFor = async (condition) => {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the concurrent request.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

if (args[0] === "app-server") {
  record("app-server");
  const probeFailure = ${JSON.stringify(fixture.probeFailure)};
  const probeMessage = "Invalid config key demo_setting at " + viewRoot + " (run " + path.dirname(viewRoot) + ")";
  if (probeFailure === "stderr") {
    fs.writeSync(2, probeMessage);
    process.exit(1);
  }
  const features = Object.fromEntries(args.flatMap((arg, index) => arg === "--disable" ? [[args[index + 1], false]] : []));
  const effectiveConfig = ${JSON.stringify(fixture.effectiveConfig ?? {})};
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const { id } = JSON.parse(line);
    if (id === 0) console.log(JSON.stringify({ id, result: {} }));
    if (id !== 2) return;
    if (probeFailure === "rpc") {
      console.log(JSON.stringify({ id, error: { code: -32602, message: probeMessage } }));
      return;
    }
    console.log(JSON.stringify({ id, result: { config: {
      defaultPermissions: "aquarius-read",
      permissions: { "aquarius-read": { filesystem: { ":root": "read", glob_scan_max_depth: null } } },
      projectDocMaxBytes: 0,
      webSearch: "disabled",
      ...effectiveConfig,
      features: { ...features, ...effectiveConfig.features },
    }, origins: ${JSON.stringify(fixture.origins ?? {})} } }));
  });
} else if (args[0] === "sandbox") {
  record("sandbox");
  process.exitCode = args.at(-1) === viewRoot ? 0 : 1;
} else if (args[0] === "exec") {
  const schemaPath = args[args.indexOf("--output-schema") + 1];
  const resultPath = args[args.indexOf("--output-last-message") + 1];
  const group = JSON.parse(fs.readFileSync(schemaPath, "utf8")).title;
  record("exec", { group, schemaPath, resultPath });
  process.stdin.resume();
  process.stdin.on("end", async () => {
    if (group === "turn-failed") {
      const message = "Unsupported service_tier for this model at " + viewRoot + " (run " + path.dirname(resultPath) + ")";
      console.log(JSON.stringify({ type: "turn.failed", error: { message } }));
      process.exitCode = 1;
      return;
    }
    if (group === "strict-config") {
      process.stderr.write("Error loading config: unknown field demo_setting in " + viewRoot + " (run " + path.dirname(resultPath) + ")");
      process.exitCode = 1;
      return;
    }
    if (group === "hold") {
      setInterval(() => {}, 1000);
      return;
    }
    if (group.startsWith("concurrent-")) {
      const count = (kind) => invocations().filter((item) => item.kind === kind && item.group?.startsWith("concurrent-")).length;
      await waitFor(() => count("exec") === 2);
      record("observed", { group, schemas: fs.readdirSync(path.dirname(schemaPath)).filter((name) => name.startsWith("schema-")) });
      await waitFor(() => count("observed") === 2);
    }
    const input = fs.readFileSync(path.join(viewRoot, "allowed.txt"), "utf8");
    const ruleContent = fs.readFileSync(path.join(viewRoot, ${JSON.stringify(rule.detailsPath)}), "utf8");
    let result = { group, input, ruleContent, unselected: fs.existsSync(path.join(viewRoot, "unselected.txt")) };
    if (group === "leak-run-root") result = { nested: [path.dirname(resultPath)] };
    if (group === "leak-view-key") result = { [viewRoot]: true };
    fs.writeFileSync(resultPath, JSON.stringify(result));
    if (group === "leak-update") {
      const text = JSON.stringify({ type: "aquarius.analysis_update", revision: 1, path: viewRoot });
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
    }
  });
}
`;
  await writeFile(executable, script, { mode: 0o755 });
  const context: AdapterSessionContext<ReturnType<typeof codexOptionsSchema.parse>> = {
    projectRoot,
    readableFiles: ["allowed.txt"],
    ruleResources: [rule],
    options: codexOptionsSchema.parse({ ...fixture.options, executable }),
    signal: new AbortController().signal,
  };
  const invocations = async (): Promise<Invocation[]> =>
    (await readFile(invocationsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Invocation);
  const request = (group: string) => ({
    ...context,
    prompt: "Inspect the approved input and rule.",
    outputSchema: { title: group, type: "object" },
  });
  return { context, invocations, projectRoot, request, rule };
};

test.skipIf(process.platform === "win32")(
  "probes once and shares the snapshot while concurrent requests isolate their files",
  async () => {
    const { context, invocations, projectRoot, request, rule } = await prepareFixture();
    const session = await codexAdapter.createSession(context);
    const viewRoot = (await invocations())[0]!.viewRoot;
    const runRoot = dirname(viewRoot);
    try {
      await writeFile(join(projectRoot, "allowed.txt"), "changed after preparing the session");
      await expect(
        Promise.all([
          session.execute(request("concurrent-one")),
          session.execute(request("concurrent-two")),
        ]),
      ).resolves.toEqual(
        ["concurrent-one", "concurrent-two"].map((group) => ({
          group,
          input: "snapshot input",
          ruleContent: rule.content,
          unselected: false,
        })),
      );

      const entries = await invocations();
      expect(entries.filter(({ kind }) => kind === "app-server")).toHaveLength(1);
      expect(entries.filter(({ kind }) => kind === "sandbox")).toHaveLength(2);
      expect(new Set(entries.map((entry) => entry.viewRoot))).toEqual(new Set([viewRoot]));
      const execs = entries.filter(({ kind }) => kind === "exec");
      expect(execs).toHaveLength(2);
      const schemaNames = execs.map(({ schemaPath }) => basename(schemaPath!)).sort();
      expect(new Set(schemaNames).size).toBe(2);
      for (const entry of entries.filter(({ kind }) => kind === "observed")) {
        expect(entry.schemas?.sort()).toEqual(schemaNames);
      }
      const resultPaths = execs.map(({ resultPath }) => resultPath!);
      expect(new Set(resultPaths).size).toBe(2);
      expect(
        resultPaths.every(
          (file) => dirname(file) === runRoot && basename(file).startsWith("result-"),
        ),
      ).toBe(true);
      expect(await readdir(runRoot)).toEqual([basename(viewRoot)]);
    } finally {
      await session.dispose();
    }
    await expect(access(runRoot)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.skipIf(process.platform === "win32")(
  "rejects internal paths in final responses and updates and cleans each request",
  async () => {
    const { context, invocations, request } = await prepareFixture();
    const session = await codexAdapter.createSession(context);
    const viewRoot = (await invocations())[0]!.viewRoot;
    try {
      for (const group of ["leak-run-root", "leak-view-key", "leak-update"]) {
        const updates: unknown[] = [];
        await expect(
          session.execute({
            ...request(group),
            onAnalysisUpdate: (update) => updates.push(update),
          }),
        ).rejects.toMatchObject({ code: "CODEX_RESPONSE_INVALID" });
        expect(updates).toEqual([]);
        expect(await readdir(dirname(viewRoot))).toEqual([basename(viewRoot)]);
      }
    } finally {
      await session.dispose();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "disposes an active request before removing its run directory",
  async () => {
    const { context, invocations, request } = await prepareFixture();
    const session = await codexAdapter.createSession(context);
    const viewRoot = (await invocations())[0]!.viewRoot;
    const rejected = expect(session.execute(request("hold"))).rejects.toMatchObject({
      code: "CODEX_ABORTED",
    });
    try {
      await expect
        .poll(async () => (await invocations()).some(({ group }) => group === "hold"))
        .toBe(true);
    } finally {
      await session.dispose();
    }
    await rejected;
    await expect(access(dirname(viewRoot))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(session.dispose()).resolves.toBeUndefined();
  },
);

const localConfigCamelCase = {
  model: "local-model",
  serviceTier: "fast",
  modelVerbosity: "medium",
  modelReasoningEffort: "high",
  modelReasoningSummary: "concise",
  modelContextWindow: 90_000,
  modelAutoCompactTokenLimit: 60_000,
  modelAutoCompactTokenLimitScope: "total",
};

const localConfigSnakeCase = {
  model: "local-model",
  service_tier: "fast",
  model_verbosity: "medium",
  model_reasoning_effort: "high",
  model_reasoning_summary: "concise",
  model_context_window: 90_000,
  model_auto_compact_token_limit: 60_000,
  model_auto_compact_token_limit_scope: "total",
};

const explicitOptions = {
  ephemeral: false,
  model: "  explicit-model  ",
  serviceTier: "ultrafast",
  verbosity: "low",
  reasoning: { effort: "minimal", summary: "detailed" },
  context: {
    window: 45_000,
    autoCompactTokenLimit: 40_000,
    autoCompactTokenLimitScope: "body_after_prefix",
  },
} satisfies CodexOptions;

const clearedOptions = {
  model: null,
  serviceTier: null,
  verbosity: null,
  reasoning: { effort: null, summary: null },
  context: { window: null, autoCompactTokenLimit: null, autoCompactTokenLimitScope: null },
} satisfies CodexOptions;

const pairs = (args: readonly string[], flag: string): string[] =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1]!] : []));

const firstClassConfig = (args: readonly string[]): string[] =>
  pairs(args, "-c")
    .filter((arg) => Object.hasOwn(localConfigSnakeCase, arg.split("=", 1)[0]!))
    .sort();

test.skipIf(process.platform === "win32").each([
  { label: "camelCase", effectiveConfig: localConfigCamelCase },
  { label: "snake_case", effectiveConfig: localConfigSnakeCase },
])("inherits every local option with $label keys", async ({ effectiveConfig }) => {
  const { context, request, invocations } = await prepareFixture({ effectiveConfig });
  const session = await codexAdapter.createSession(context);
  try {
    expect(session.info).toEqual({
      adapter: "codex",
      model: "local-model",
      details: {
        serviceTier: "fast",
        "reasoning.effort": "high",
        "reasoning.summary": "concise",
        verbosity: "medium",
        "context.window": "90000",
      },
    });
    await session.execute(request("inherit"));
    const { args } = (await invocations()).find(({ kind }) => kind === "exec")!;
    expect(pairs(args, "--model")).toEqual(["local-model"]);
    expect(firstClassConfig(args)).toEqual([
      "model_auto_compact_token_limit=60000",
      'model_auto_compact_token_limit_scope="total"',
      "model_context_window=90000",
      'model_reasoning_effort="high"',
      'model_reasoning_summary="concise"',
      'model_verbosity="medium"',
      'service_tier="fast"',
    ]);
    expect(args).toContain("--ephemeral");
    expect(pairs(args, "--enable")).toEqual([]);
  } finally {
    await session.dispose();
  }
});

test.skipIf(process.platform === "win32")(
  "uses explicit settings and passes extension options to both Codex processes",
  async () => {
    const { context, request, invocations } = await prepareFixture({
      effectiveConfig: localConfigSnakeCase,
      options: {
        ...explicitOptions,
        features: { enable_request_compression: true, shell_snapshot: false },
        config: { file_opener: "none", "tui.keymap": { global: { help: ["ctrl-h"] } } },
      },
    });
    const session = await codexAdapter.createSession(context);
    try {
      expect(session.info).toEqual({
        adapter: "codex",
        model: "explicit-model",
        details: {
          serviceTier: "ultrafast",
          "reasoning.effort": "minimal",
          "reasoning.summary": "detailed",
          verbosity: "low",
          "context.window": "45000",
        },
      });
      await session.execute(request("override"));
      const entries = await invocations();
      const probeArgs = entries.find(({ kind }) => kind === "app-server")!.args;
      const execArgs = entries.find(({ kind }) => kind === "exec")!.args;
      for (const args of [probeArgs, execArgs]) {
        expect(pairs(args, "--enable")).toEqual(["enable_request_compression"]);
        expect(pairs(args, "--disable")).toEqual(
          expect.arrayContaining(["hooks", "shell_snapshot"]),
        );
        expect(pairs(args, "-c")).toContain('file_opener="none"');
        expect(pairs(args, "-c")).toContainEqual(
          expect.stringMatching(
            /^tui\.keymap=\{\s*"?global"?\s*=\s*\{\s*"?help"?\s*=\s*\["ctrl-h"\]\s*\}\s*\}$/u,
          ),
        );
      }
      expect(pairs(execArgs, "--model")).toEqual(["explicit-model"]);
      expect(firstClassConfig(execArgs)).toEqual([
        "model_auto_compact_token_limit=40000",
        'model_auto_compact_token_limit_scope="body_after_prefix"',
        "model_context_window=45000",
        'model_reasoning_effort="minimal"',
        'model_reasoning_summary="detailed"',
        'model_verbosity="low"',
        'service_tier="ultrafast"',
      ]);
      expect(execArgs).not.toContain("--ephemeral");
    } finally {
      await session.dispose();
    }
  },
);

test.skipIf(process.platform === "win32")("clears every inherited option with null", async () => {
  const { context, request, invocations } = await prepareFixture({
    effectiveConfig: localConfigCamelCase,
    options: clearedOptions,
  });
  const session = await codexAdapter.createSession(context);
  try {
    expect(session.info).toEqual({ adapter: "codex" });
    await session.execute(request("cleared"));
    const { args } = (await invocations()).find(({ kind }) => kind === "exec")!;
    expect(firstClassConfig(args)).toEqual([]);
    expect(pairs(args, "--model")).toEqual([]);
    expect(args).toContain("--ignore-user-config");
  } finally {
    await session.dispose();
  }
});

test.skipIf(process.platform === "win32").each([
  {
    effectiveConfig: { defaultPermissions: "different-profile" },
    code: "CODEX_POLICY_UNVERIFIED",
  },
  {
    effectiveConfig: {
      permissions: { "aquarius-read": { filesystem: { ":root": "read", "/elsewhere": "write" } } },
    },
    code: "CODEX_POLICY_UNVERIFIED",
  },
  {
    effectiveConfig: {
      permissions: {
        "aquarius-read": { filesystem: { ":root": "read" }, network: { enabled: true } },
      },
    },
    code: "CODEX_POLICY_UNVERIFIED",
  },
  { effectiveConfig: { webSearch: "live" }, code: "CODEX_POLICY_UNVERIFIED" },
  { effectiveConfig: { features: { hooks: true } }, code: "CODEX_POLICY_UNVERIFIED" },
  { effectiveConfig: { model_provider: "custom" }, code: "CODEX_PROVIDER_UNSUPPORTED" },
  {
    origins: { "mcp_servers.fixture.command": { name: { type: "project" } } },
    code: "CODEX_MCP_ACTIVE",
  },
  {
    effectiveConfig: { mcp_servers: { fixture: { command: "fixture" } } },
    code: "CODEX_MCP_ACTIVE",
  },
  {
    origins: { sandbox_mode: { name: { type: "project" } } },
    code: "CODEX_LEGACY_SANDBOX_ACTIVE",
  },
])(
  "rejects an unsafe effective probe result ($code)",
  async ({ effectiveConfig, origins, code }) => {
    const { context, invocations } = await prepareFixture({
      effectiveConfig,
      origins,
      options: { features: { hooks: false }, config: { file_opener: "none" } },
    });
    await expect(codexAdapter.createSession(context)).rejects.toMatchObject({ code });
    const entries = await invocations();
    expect(entries.map(({ kind }) => kind)).toEqual(["app-server"]);
    expect(pairs(entries[0]!.args, "-c")).toContain('file_opener="none"');
    await expect(access(dirname(entries[0]!.viewRoot))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.skipIf(process.platform === "win32").each(["rpc", "stderr"] as const)(
  "reports the %s probe failure without private paths",
  async (probeFailure) => {
    const { context, invocations } = await prepareFixture({ probeFailure });
    const failure = codexAdapter.createSession(context);
    await expect(failure).rejects.toMatchObject({
      code: "CODEX_CONFIG_PROBE_FAILED",
      message: expect.stringContaining("Invalid config key demo_setting"),
    });
    const [{ viewRoot }] = await invocations();
    await expect(failure).rejects.not.toMatchObject({
      message: expect.stringContaining(dirname(viewRoot)),
    });
  },
);

test.skipIf(process.platform === "win32").each([
  ["turn-failed", "Unsupported service_tier for this model"],
  ["strict-config", "unknown field demo_setting"],
])("reports a %s error without private paths", async (group, diagnostic) => {
  const { context, request, invocations } = await prepareFixture();
  const session = await codexAdapter.createSession(context);
  try {
    const failure = session.execute(request(group));
    await expect(failure).rejects.toMatchObject({
      code: "CODEX_EXECUTION_FAILED",
      message: expect.stringContaining(diagnostic),
    });
    const [{ viewRoot }] = await invocations();
    await expect(failure).rejects.not.toMatchObject({
      message: expect.stringContaining(dirname(viewRoot)),
    });
  } finally {
    await session.dispose();
  }
});
