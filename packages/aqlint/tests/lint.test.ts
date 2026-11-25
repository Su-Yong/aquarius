import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RulePlugin } from "@aqtools/core";
import type { AdapterExecuteRequest, StandaloneAdapter } from "@aqtools/core/runtime";
import builtinRules from "@aqtools/rules";
import { runCli } from "../src/cli/run";
import { executeLint } from "../src/lint/execute";
import type { LintResult } from "../src/lint/types";

const roots: string[] = [];
const source = "first line\nsecond line\n";
const plugin: RulePlugin = {
  namespace: "fixture",
  lintRules: ["first", "second"].map((id) => ({
    id,
    description: id,
    scope: "file" as const,
    buildPrompt: () => ({
      applicability: "fixture",
      criteria: "fixture",
      evidenceRequirements: ["source"],
    }),
  })),
  presets: {
    all: { "fixture/first": "error", "fixture/second": "error" },
  },
};

const createProject = async (extra: Record<string, unknown> = {}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "aqlint-test-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "sample.any"), source);
  await writeFile(
    join(root, ".aqlintrc.jsonc"),
    JSON.stringify({
      files: ["src/**"],
      plugins: ["fixture"],
      rules: { "fixture/first": "error", "fixture/second": "off" },
      ...extra,
    }),
  );
  return root;
};

const lintReply = (ruleIds = ["fixture/first"], paths = ["src/sample.any"]) => ({
  completedRuleIds: ruleIds,
  skippedRules: [],
  diagnostics: [],
  errors: [],
  fileResults: paths.map((path) => ({ path, status: "completed", reason: "" })),
});

const adapter = (result: unknown) => ({
  id: "fixture",
  run: vi.fn(async (_input: AdapterExecuteRequest) => result),
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const candidate = resolve(root);
    if (
      dirname(candidate) !== resolve(tmpdir()) ||
      !basename(candidate).startsWith("aqlint-test-")
    ) {
      throw new Error("Unexpected cleanup path.");
    }
    await rm(candidate, { recursive: true, force: true });
  }
});

describe("lint execution", () => {
  test("passes a compact rule index and in-memory rule details without creating project files", async () => {
    const root = await createProject();
    const ai = {
      id: "resources",
      run: async (input) => {
        expect(input.ruleResources).toHaveLength(1);
        const reference = input.ruleResources[0]!;
        const detail = JSON.parse(reference.content);
        expect(detail).toEqual({
          ruleId: "fixture/first",
          scope: "file",
          instructions: {
            applicability: "fixture",
            criteria: "fixture",
            evidenceRequirements: ["source"],
          },
        });
        const task = JSON.parse(input.prompt.split("\n\n").at(-1)!);
        expect(task.rules).toEqual([
          {
            ruleId: "fixture/first",
            scope: "file",
            applicability: "fixture",
            detailsPath: reference.detailsPath,
          },
        ]);
        expect(input.prompt).not.toContain('"criteria"');
        expect(input.prompt).not.toContain('"evidenceRequirements"');
        expect(input.readableFiles).not.toContain(reference.detailsPath);
        return lintReply();
      },
    } satisfies StandaloneAdapter;
    const run = await executeLint({ cwd: root, plugins: { fixture: plugin }, adapter: ai });
    expect(run.exitCode).toBe(0);
    await expect(access(join(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("requires an explicit AI adapter when active rules need analysis", async () => {
    const root = await createProject({ ai: { fileBatchSize: 2 } });
    const run = await executeLint({ cwd: root, plugins: { fixture: plugin } });
    expect(run.exitCode).toBe(2);
    expect(run.result.errors).toEqual([
      expect.objectContaining({
        code: "AI_ADAPTER_REQUIRED",
        message: expect.stringContaining("ai.adapter"),
      }),
    ]);
    expect(run.result.summary).toMatchObject({ totalFiles: 1, successFiles: 0, failedFiles: 1 });
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(source);
  });

  test("reports actual analysis stages", async () => {
    const root = await createProject();
    const onProgress = vi.fn();
    const run = await executeLint({
      cwd: root,
      onProgress,
      plugins: { fixture: plugin },
      adapter: {
        id: "progress",
        run: async (input) => {
          input.onProgress?.("Inspecting src/sample.any");
          return lintReply();
        },
      },
    });
    expect(run.exitCode).toBe(0);
    expect(onProgress.mock.calls.map(([stage]) => stage)).toEqual([
      "Preparing rules",
      "Selecting files",
      "Analyzing files with AI",
      "Inspecting src/sample.any",
      "Checking results",
    ]);
  });

  test("context outside configured targets may provide evidence but not primary locations", async () => {
    const root = await createProject();
    await writeFile(join(root, "README.md"), "Existing project contract\n");
    const diagnostic = {
      ruleIds: ["fixture/first"],
      message: "Scoped issue",
      locations: [{ path: "src/sample.any", line: 1, column: 1 }],
      evidence: [{ path: "README.md", line: 1, message: "Contract evidence" }],
    };
    const valid = await executeLint({
      cwd: root,
      paths: ["src/sample.any"],
      plugins: { fixture: plugin },
      adapter: adapter({
        ...lintReply(),
        diagnostics: [diagnostic],
      }),
    });
    expect(valid.result.diagnostics).toHaveLength(1);

    const invalid = await executeLint({
      cwd: root,
      paths: ["src/sample.any"],
      plugins: { fixture: plugin },
      adapter: adapter({
        ...lintReply(),
        diagnostics: [
          {
            ...diagnostic,
            locations: [...diagnostic.locations, { path: "README.md", line: 1, column: 1 }],
          },
        ],
      }),
    });
    expect(invalid.exitCode).toBe(2);
    expect(invalid.result.diagnostics).toEqual([]);
  });

  test("provides project and ignored files as evidence without adding lint targets", async () => {
    const root = await createProject({ ignore: ["src/ignored.any"] });
    await writeFile(join(root, "README.md"), "Project contract\n");
    await writeFile(join(root, "src/ignored.any"), "Related implementation\n");
    const ai = adapter({
      ...lintReply(),
      diagnostics: [
        {
          ruleIds: ["fixture/first"],
          message: "A finding supported by project context",
          locations: [{ path: "src/sample.any", line: 1, column: 1 }],
          evidence: [
            { path: "README.md", line: 1, message: "Project contract" },
            { path: "src/ignored.any", line: 1, message: "Related implementation" },
          ],
        },
      ],
    });
    const run = await executeLint({ cwd: root, plugins: { fixture: plugin }, adapter: ai });

    const input = ai.run.mock.calls[0]![0];
    expect(input.readableFiles).toEqual([
      ".aqlintrc.jsonc",
      "README.md",
      "src/ignored.any",
      "src/sample.any",
    ]);
    expect(input).not.toHaveProperty("ignore");
    expect(run.exitCode).toBe(1);
    expect(run.result.diagnostics).toHaveLength(1);
    expect(run.result.errors).toEqual([]);
    expect(run.result.fileResults).toEqual(lintReply().fileResults);
    expect(run.result.summary.totalFiles).toBe(1);
  });

  test("unregistered and disabled rules skip selected files without invoking AI", async () => {
    const root = await createProject({ plugins: [], rules: {} });
    const ai = adapter({});
    const skipped = await executeLint({ cwd: root, plugins: { fixture: plugin }, adapter: ai });
    expect(skipped).toEqual({
      result: {
        diagnostics: [],
        errors: [],
        skippedRules: [],
        fileResults: [{ path: "src/sample.any", status: "skipped", reason: "No active rules." }],
        summary: {
          totalFiles: 1,
          successFiles: 0,
          warningFiles: 0,
          skippedFiles: 1,
          failedFiles: 0,
          activeRules: 0,
        },
      },
      exitCode: 0,
    });
    expect(ai.run).not.toHaveBeenCalled();

    await writeFile(
      join(root, ".aqlintrc.jsonc"),
      JSON.stringify({
        files: ["src/**"],
        plugins: ["fixture"],
        rules: { "fixture/first": "off", "fixture/second": "off" },
      }),
    );
    expect(await executeLint({ cwd: root, plugins: { fixture: plugin }, adapter: ai })).toEqual(
      skipped,
    );
    expect(ai.run).not.toHaveBeenCalled();
  });

  test.each([{}, undefined])("leaves registered rules inactive with rules %j", async (rules) => {
    const root = await createProject({ rules });
    const ai = adapter({});
    const run = await executeLint({ cwd: root, plugins: { fixture: plugin }, adapter: ai });
    expect(run.exitCode).toBe(0);
    expect(run.result.errors).toEqual([]);
    expect(run.result.summary).toMatchObject({
      totalFiles: 1,
      skippedFiles: 1,
      activeRules: 0,
    });
    expect(ai.run).not.toHaveBeenCalled();
  });

  test.each([{}, undefined])("runs a selected preset with rules %j", async (rules) => {
    const root = await createProject({ preset: ["fixture/all"], rules });
    const ai = adapter(lintReply(["fixture/first", "fixture/second"]));
    const run = await executeLint({ cwd: root, plugins: { fixture: plugin }, adapter: ai });
    expect(run.exitCode).toBe(0);
    expect(run.result.summary).toMatchObject({
      totalFiles: 1,
      successFiles: 1,
      warningFiles: 0,
      activeRules: 2,
    });
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  test("skips formatter rules in a mixed preset", async () => {
    const formatPrompt = vi.fn(() => ({
      applicability: "fixture",
      transformation: "Format fixture text.",
      constraints: ["Preserve behavior."],
    }));
    const mixedPlugin: RulePlugin = {
      ...plugin,
      formatRules: [
        {
          id: "format",
          description: "Format fixture text.",
          scope: "file",
          buildPrompt: formatPrompt,
        },
      ],
      presets: {
        mixed: { "fixture/first": "warn", "fixture/format": true },
      },
    };
    const root = await createProject({
      preset: ["fixture/mixed"],
      rules: { "fixture/second": "error" },
    });
    const ai = adapter(lintReply(["fixture/first", "fixture/second"]));
    const run = await executeLint({ cwd: root, plugins: { fixture: mixedPlugin }, adapter: ai });

    expect(run.exitCode).toBe(0);
    expect(run.result.errors).toEqual([]);
    expect(run.result.summary.activeRules).toBe(2);
    expect(ai.run.mock.calls[0]![0].ruleResources.map(({ ruleId }) => ruleId)).toEqual([
      "fixture/first",
      "fixture/second",
    ]);
    expect(formatPrompt).not.toHaveBeenCalled();
  });

  test("preserves findings from valid preset rules when another preset cannot be resolved", async () => {
    const root = await createProject({
      preset: ["fixture/all", "fixture/missing"],
      rules: { "fixture/second": "off" },
    });
    const ai = adapter({
      ...lintReply(),
      diagnostics: [
        {
          ruleIds: ["fixture/first"],
          message: "Valid finding from an available preset.",
          locations: [{ path: "src/sample.any", line: 1, column: 1 }],
          evidence: [{ path: "src/sample.any", line: 1, message: "Source evidence." }],
        },
      ],
    });
    const run = await executeLint({ cwd: root, plugins: { fixture: plugin }, adapter: ai });

    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(run.exitCode).toBe(2);
    expect(run.result.errors).toEqual([expect.objectContaining({ code: "PRESET_NOT_FOUND" })]);
    expect(run.result.diagnostics).toEqual([
      expect.objectContaining({ message: "Valid finding from an available preset." }),
    ]);
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(source);
  });

  test("fails missing mandatory layer settings during setup without calling AI", async () => {
    const root = await createProject({
      plugins: ["@aqtools/rules"],
      rules: {
        "aquarius/contracts/no-input-mutation": ["error", { allowOwnershipTransfer: false }],
        "aquarius/architecture/enforce-layer-direction": "warn",
      },
    });
    const ai = adapter(lintReply());
    const stages: string[] = [];
    const run = await executeLint({
      cwd: root,
      onProgress: (stage) => stages.push(stage),
      plugins: { "@aqtools/rules": builtinRules },
      adapter: ai,
    });
    expect(run.exitCode).toBe(2);
    expect(run.result.errors).toContainEqual(
      expect.objectContaining({
        code: "RULE_OPTIONS_INVALID",
        ruleIds: ["aquarius/architecture/enforce-layer-direction"],
        message: expect.stringContaining("layers"),
      }),
    );
    expect(run.result.errors[0]!.message).toContain("allowedDependencies");
    expect(run.result.summary.totalFiles).toBeNull();
    expect(run.result.summary.successFiles).toBe(0);
    expect(stages).toEqual(["Preparing rules"]);
    expect(ai.run).not.toHaveBeenCalled();
  });

  test("loads JSON configuration and applies the provided all preset", async () => {
    const root = await createProject();
    await writeFile(
      join(root, ".aqlintrc.json"),
      JSON.stringify({
        files: ["src/**"],
        plugins: ["@aqtools/rules"],
        preset: ["aquarius/all"],
        rules: {
          "aquarius/architecture/enforce-layer-direction": [
            "warn",
            {
              layers: { source: ["src/**"] },
              allowedDependencies: { source: [] },
            },
          ],
        },
      }),
    );
    const ruleIds = builtinRules.lintRules!.map(({ id }) => `${builtinRules.namespace}/${id}`);
    const ai = {
      id: "all-default-rules",
      run: vi.fn(async (input: AdapterExecuteRequest) =>
        lintReply(input.ruleResources.map(({ ruleId }) => ruleId)),
      ),
    };
    const run = await executeLint({
      cwd: root,
      plugins: { "@aqtools/rules": builtinRules },
      adapter: ai,
    });
    expect(run.exitCode).toBe(0);
    expect(run.result.summary.activeRules).toBe(ruleIds.length);
    expect(run.result.summary.successFiles).toBe(1);
    const calls = ai.run.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls.flatMap(([input]) => input.ruleResources.map(({ ruleId }) => ruleId))).toEqual(
      ruleIds,
    );
    expect(ai.run.mock.calls[0]![0].outputSchema.required).toContain("fileResults");
  });

  test("preserves valid findings, exact duplicate contributors, and invalid item errors", async () => {
    const root = await createProject({
      rules: { "fixture/first": "warn", "fixture/second": "error" },
    });
    const diagnostic = {
      message: "Same proven issue",
      locations: [{ path: "src/sample.any", line: 2, column: 3 }],
      evidence: [{ path: "src/sample.any", line: 2, message: "Concrete source evidence" }],
    };
    const ai = adapter({
      ...lintReply(["fixture/first", "fixture/second"]),
      diagnostics: [
        { ...diagnostic, ruleIds: ["fixture/first"] },
        { ...diagnostic, ruleIds: ["fixture/second"] },
        { ...diagnostic, ruleIds: ["unregistered/rule"] },
      ],
    });
    const run = await executeLint({ cwd: root, plugins: { fixture: plugin }, adapter: ai });
    expect(run.exitCode).toBe(2);
    expect(run.result.diagnostics).toHaveLength(1);
    expect(run.result.diagnostics[0]!.rules).toEqual([
      { rule: "fixture/first", severity: "warn" },
      { rule: "fixture/second", severity: "error" },
    ]);
    expect(run.result.errors.some(({ code }) => code === "INVALID_RULE_REFERENCE")).toBe(true);
    expect(ai.run).toHaveBeenCalledTimes(1);
    const input = ai.run.mock.calls[0]![0];
    expect(input.prompt).toContain("fixture/first");
    expect(input.readableFiles).toContain("src/sample.any");
  });

  test("rejects removed uncertainty results and missing rule completion", async () => {
    const root = await createProject();
    const legacy = await executeLint({
      cwd: root,
      plugins: { fixture: plugin },
      adapter: adapter({ ...lintReply(), unknowns: [] }),
    });
    expect(legacy.exitCode).toBe(2);
    expect(legacy.result.errors).toContainEqual(
      expect.objectContaining({ code: "INVALID_AI_RESPONSE" }),
    );
    expect(legacy.result).not.toHaveProperty("unknowns");
    expect(legacy.result.summary).toMatchObject({ successFiles: 0, failedFiles: 1 });

    const incomplete = await executeLint({
      cwd: root,
      plugins: { fixture: plugin },
      adapter: adapter(lintReply([])),
    });
    expect(incomplete.exitCode).toBe(2);
    expect(incomplete.result.errors.some(({ code }) => code === "INCOMPLETE_AI_RESPONSE")).toBe(
      true,
    );
  });

  test("invalid shape is not retried and configured warning severity exits successfully", async () => {
    const root = await createProject({
      rules: { "fixture/first": "warn", "fixture/second": "off" },
    });
    const invalid = adapter("not a parsed result");
    expect(
      (await executeLint({ cwd: root, plugins: { fixture: plugin }, adapter: invalid })).exitCode,
    ).toBe(2);
    expect(invalid.run).toHaveBeenCalledTimes(1);

    const run = await executeLint({
      cwd: root,
      plugins: { fixture: plugin },
      adapter: adapter({
        ...lintReply(),
        diagnostics: [
          {
            ruleIds: ["fixture/first"],
            message: "Warning",
            locations: [{ path: "src/sample.any", line: 1, column: 1 }],
            evidence: [{ path: "src/sample.any", line: 1, message: "Evidence" }],
          },
        ],
      }),
    });
    expect(run.exitCode).toBe(0);
    expect(run.result.diagnostics[0]!.severity).toBe("warn");
  });

  test("rule preparation failure keeps independent evaluation and timeout keeps source unchanged", async () => {
    const root = await createProject({
      rules: {
        "fixture/first": "error",
        "fixture/second": "off",
        "fixture/missing": "error",
      },
    });
    const ai = adapter(lintReply());
    const partial = await executeLint({ cwd: root, plugins: { fixture: plugin }, adapter: ai });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(partial.exitCode).toBe(2);
    expect(partial.result.errors.length).toBeGreaterThan(0);
    expect(partial.result.summary).toMatchObject({ totalFiles: 1, failedFiles: 1 });

    await writeFile(
      join(root, ".aqlintrc.jsonc"),
      JSON.stringify({
        files: ["src/**"],
        plugins: ["fixture"],
        rules: { "fixture/first": "error", "fixture/second": "off" },
        ai: { adapter: "@aqtools/codex", timeoutMs: 25 },
      }),
    );
    const slow = vi.fn(() => new Promise<unknown>(() => {}));
    const dispose = vi.fn();
    const timedOut = await executeLint({
      cwd: root,
      plugins: { fixture: plugin },
      adapter: { id: "slow", createSession: () => ({ execute: slow, dispose }) },
    });
    expect(timedOut.exitCode).toBe(2);
    expect(timedOut.result.errors[0]!.code).toBe("AI_TIMEOUT");
    expect(timedOut.result.summary).toMatchObject({
      totalFiles: 1,
      successFiles: 0,
      warningFiles: 0,
      failedFiles: 1,
    });
    expect(slow).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledOnce();
    expect(await readFile(join(root, "src", "sample.any"), "utf8")).toBe(source);
  });

  test("counts only selected files and preserves independently completed files", async () => {
    const root = await createProject({ ignore: ["src/ignored.any"] });
    await writeFile(join(root, "src/other.any"), source);
    await writeFile(join(root, "src/ignored.any"), source);
    await writeFile(join(root, "README.md"), "Readable context\n");
    const ai = adapter({
      ...lintReply(),
      fileResults: [
        { path: "src/sample.any", status: "completed", reason: "" },
        { path: "src/other.any", status: "failed", reason: "Could not finish analysis." },
      ],
    });
    const run = await executeLint({ cwd: root, plugins: { fixture: plugin }, adapter: ai });
    expect(run.exitCode).toBe(2);
    expect(run.result.summary).toEqual({
      totalFiles: 2,
      successFiles: 1,
      warningFiles: 0,
      skippedFiles: 0,
      failedFiles: 1,
      activeRules: 1,
    });
    expect(run.result.fileResults.map(({ path }) => path).sort()).toEqual([
      "src/other.any",
      "src/sample.any",
    ]);
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  test("all not-applicable files are skipped without an error exit", async () => {
    const root = await createProject();
    const run = await executeLint({
      cwd: root,
      plugins: { fixture: plugin },
      adapter: adapter({
        ...lintReply([]),
        skippedRules: [{ ruleId: "fixture/first", reason: "No applicable prerequisite." }],
        fileResults: [
          { path: "src/sample.any", status: "skipped", reason: "No applicable rules." },
        ],
      }),
    });
    expect(run.exitCode).toBe(0);
    expect(run.result.skippedRules).toEqual([
      { ruleId: "fixture/first", reason: "No applicable prerequisite." },
    ]);
    expect(run.result.summary).toMatchObject({
      totalFiles: 1,
      successFiles: 0,
      warningFiles: 0,
      skippedFiles: 1,
      failedFiles: 0,
    });
  });

  test("reports a missing configuration before selecting files or creating a session", async () => {
    const root = await createProject();
    await rm(join(root, ".aqlintrc.jsonc"));
    const ai = adapter(lintReply());

    const execution = await executeLint({ cwd: root, adapter: ai });

    expect(execution.exitCode).toBe(2);
    expect(execution.result.errors).toEqual([
      expect.objectContaining({ code: "CONFIG_NOT_FOUND" }),
    ]);
    expect(execution.result.fileResults).toEqual([]);
    expect(execution.result.summary.totalFiles).toBeNull();
    expect(ai.run).not.toHaveBeenCalled();
  });

  test("configuration and target selection errors leave the target count undetermined", async () => {
    const root = await createProject();
    const ai = adapter(lintReply());
    const unmatched = await executeLint({
      cwd: root,
      paths: ["missing.any"],
      plugins: { fixture: plugin },
      adapter: ai,
    });
    expect(unmatched.exitCode).toBe(2);
    expect(unmatched.result.errors[0]!.code).toBe("TARGET_UNMATCHED");
    expect(unmatched.result.summary.totalFiles).toBeNull();
    expect(unmatched.result.fileResults).toEqual([]);

    await writeFile(join(root, ".aqlintrc.json"), "{");
    const invalidConfig = await executeLint({
      cwd: root,
      plugins: { fixture: plugin },
      adapter: ai,
    });
    expect(invalidConfig.exitCode).toBe(2);
    expect(invalidConfig.result.errors[0]!.code).toBe("CONFIG_PARSE_FAILED");
    expect(invalidConfig.result.summary.totalFiles).toBeNull();
    expect(invalidConfig.result.fileResults).toEqual([]);
    expect(ai.run).not.toHaveBeenCalled();
  });

  test("an allowed empty target selection is known and never invokes AI", async () => {
    const root = await createProject({ files: ["absent/**"] });
    const ai = adapter(lintReply());
    const run = await executeLint({
      cwd: root,
      noErrorOnUnmatchedPattern: true,
      plugins: { fixture: plugin },
      adapter: ai,
    });
    expect(run.exitCode).toBe(0);
    expect(run.result.summary).toMatchObject({
      totalFiles: 0,
      successFiles: 0,
      warningFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
    });
    expect(run.result.fileResults).toEqual([]);
    expect(ai.run).not.toHaveBeenCalled();
  });

  test("cancellation fails all selected files and preserves the cancellation exit code", async () => {
    const root = await createProject();
    const controller = new AbortController();
    const ai = {
      id: "cancelled",
      run: vi.fn(async () => {
        controller.abort();
        return lintReply();
      }),
    };
    const run = await executeLint({
      cwd: root,
      signal: controller.signal,
      plugins: { fixture: plugin },
      adapter: ai,
    });
    expect(run.exitCode).toBe(130);
    expect(run.result.errors[0]!.code).toBe("AI_ABORTED");
    expect(run.result.summary).toMatchObject({ totalFiles: 1, successFiles: 0, failedFiles: 1 });
    expect(run.result.fileResults[0]!.reason).toContain("cancelled");
  });

  test("cancellation during result checking is not reported as completed", async () => {
    const root = await createProject();
    const controller = new AbortController();
    const ai = adapter(lintReply());
    const run = await executeLint({
      cwd: root,
      signal: controller.signal,
      onProgress: (stage) => {
        if (stage === "Checking results") controller.abort();
      },
      plugins: { fixture: plugin },
      adapter: ai,
    });
    expect(run.exitCode).toBe(130);
    expect(run.result.errors[0]!.code).toBe("AI_ABORTED");
    expect(run.result.summary).toMatchObject({ totalFiles: 1, successFiles: 0, failedFiles: 1 });
  });
});

const writeCliPlugin = async (root: string): Promise<void> => {
  const lintRules = await Promise.all(
    plugin.lintRules!.map(async ({ id, description, scope, buildPrompt }) => {
      const instructions = await buildPrompt({ options: {} });
      return `{ ...${JSON.stringify({ id, description, scope })},
        buildPrompt: () => (${JSON.stringify(instructions)}) }`;
    }),
  );
  await writeFile(
    join(root, "fixture-plugin.mjs"),
    `export default { namespace: "fixture", lintRules: [${lintRules.join(",")}] };`,
  );
};

test("human CLI preserves per-rule severity, locations, and evidence", async () => {
  const root = await createProject({
    rules: { "fixture/first": "error", "fixture/second": "warn" },
    plugins: ["./fixture-plugin.mjs"],
    ai: { adapter: "./adapter.mjs" },
  });
  await writeCliPlugin(root);
  const reply = {
    ...lintReply(["fixture/first", "fixture/second"]),
    diagnostics: [
      {
        ruleIds: ["fixture/first", "fixture/second"],
        message: "Two-site issue",
        locations: [
          { path: "src/sample.any", line: 1, column: 1 },
          { path: "src/sample.any", line: 2, column: 3 },
        ],
        evidence: [
          { path: "src/sample.any", line: 1, message: "First evidence" },
          { path: "src/sample.any", line: 2, message: "Second evidence" },
        ],
      },
    ],
  };
  await writeFile(
    join(root, "adapter.mjs"),
    `export default { id: "fixture", run: async () => (${JSON.stringify(reply)}) };`,
  );
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await runCli("0.1.0", [])).toBe(1);
    const output = logs.mock.calls.flat().join("\n");
    expect(output).toContain("fixture/first:error");
    expect(output).toContain("fixture/second:warn");
    expect(output).toContain("src/sample.any:2:3");
    expect(output).toContain("First evidence");
    expect(output).toContain("Second evidence");
    expect(errors).not.toHaveBeenCalled();
  } finally {
    cwd.mockRestore();
    logs.mockRestore();
    errors.mockRestore();
  }
});

const findingReply = (paths = ["src/sample.any"]) => ({
  ...lintReply(undefined, paths),
  diagnostics: [
    {
      ruleIds: ["fixture/first"],
      message: "Mutation issue",
      locations: [{ path: "src/sample.any", line: 1, column: 1 }],
      evidence: [{ path: "src/sample.any", line: 1, message: "Mutation evidence" }],
    },
  ],
});
const lintReplyResult = (): LintResult => ({
  diagnostics: [],
  errors: [],
  skippedRules: [],
  fileResults: [{ path: "src/sample.any", status: "completed", reason: "" }],
  summary: {
    totalFiles: 1,
    successFiles: 1,
    warningFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    activeRules: 1,
  },
});

test("JSON CLI output stays structured and contains no terminal styling", async () => {
  const root = await createProject({
    ai: { adapter: "./adapter.mjs" },
    plugins: ["./fixture-plugin.mjs"],
  });
  await writeCliPlugin(root);
  await writeFile(
    join(root, "adapter.mjs"),
    `export default { id: "fixture", run: async () => (${JSON.stringify(findingReply())}) };`,
  );
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await runCli("0.1.0", ["--format", "json", "src/sample.any"])).toBe(1);
    const output = String(logs.mock.calls[0]![0]);
    expect(output).not.toContain("\x1b");
    expect(JSON.parse(output).diagnostics).toHaveLength(1);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output).summary).toEqual({
      ...lintReplyResult().summary,
      successFiles: 0,
      failedFiles: 1,
    });
    expect(JSON.parse(output).fileResults).toEqual(lintReplyResult().fileResults);
  } finally {
    cwd.mockRestore();
    logs.mockRestore();
  }
});
