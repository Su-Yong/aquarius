import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AiBridge, BridgeInput, RulePlugin } from "@aquarius/core/internal";
import builtinRules from "@aquarius/rules";
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

const bridge = (result: unknown): AiBridge => ({
  id: "fixture",
  run: vi.fn(async () => result),
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
  test("passes a compact rule index and readable detail files, then removes temporary resources", async () => {
    const root = await createProject();
    let resourceDirectory = "";
    const ai: AiBridge = {
      id: "resources",
      run: async (input) => {
        resourceDirectory = input.ruleResources.directory;
        expect(input.ruleResources.files).toHaveLength(1);
        const reference = input.ruleResources.files[0]!;
        const detail = JSON.parse(
          await readFile(join(resourceDirectory, reference.detailsPath), "utf8"),
        );
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
    };
    const run = await executeLint({ cwd: root }, { fixture: plugin }, ai);
    expect(run.exitCode).toBe(0);
    expect(resourceDirectory).not.toBe("");
    await expect(access(resourceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("requires an explicit AI adapter when active rules need analysis", async () => {
    const root = await createProject();
    const run = await executeLint({ cwd: root }, { fixture: plugin });
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
    const run = await executeLint(
      { cwd: root, onProgress },
      { fixture: plugin },
      {
        id: "progress",
        run: async (input) => {
          input.onProgress?.("Inspecting src/sample.any");
          return lintReply();
        },
      },
    );
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
    const valid = await executeLint(
      { cwd: root, paths: ["src/sample.any"] },
      { fixture: plugin },
      bridge({
        ...lintReply(),
        diagnostics: [diagnostic],
      }),
    );
    expect(valid.result.diagnostics).toHaveLength(1);

    const invalid = await executeLint(
      { cwd: root, paths: ["src/sample.any"] },
      { fixture: plugin },
      bridge({
        ...lintReply(),
        diagnostics: [
          {
            ...diagnostic,
            locations: [...diagnostic.locations, { path: "README.md", line: 1, column: 1 }],
          },
        ],
      }),
    );
    expect(invalid.exitCode).toBe(2);
    expect(invalid.result.diagnostics).toEqual([]);
  });

  test("provides project and ignored files as evidence without adding lint targets", async () => {
    const root = await createProject({ ignore: ["src/ignored.any"] });
    await writeFile(join(root, "README.md"), "Project contract\n");
    await writeFile(join(root, "src/ignored.any"), "Related implementation\n");
    const ai = bridge({
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
    const run = await executeLint({ cwd: root }, { fixture: plugin }, ai);

    const input = vi.mocked(ai.run).mock.calls[0]![0];
    expect(input.readableFiles).toEqual([
      ".aqlintrc.jsonc",
      "README.md",
      "src/ignored.any",
      "src/sample.any",
    ]);
    expect(input.ignore).toEqual([]);
    expect(run.exitCode).toBe(1);
    expect(run.result.diagnostics).toHaveLength(1);
    expect(run.result.errors).toEqual([]);
    expect(run.result.fileResults).toEqual(lintReply().fileResults);
    expect(run.result.summary.totalFiles).toBe(1);
  });

  test("unregistered and disabled rules skip selected files without invoking AI", async () => {
    const root = await createProject({ plugins: [], rules: {} });
    const ai = bridge({});
    const skipped = await executeLint({ cwd: root }, { fixture: plugin }, ai);
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
    expect(await executeLint({ cwd: root }, { fixture: plugin }, ai)).toEqual(skipped);
    expect(ai.run).not.toHaveBeenCalled();
  });

  test.each([{}, undefined])("leaves registered rules inactive with rules %j", async (rules) => {
    const root = await createProject({ rules });
    const ai = bridge({});
    const run = await executeLint({ cwd: root }, { fixture: plugin }, ai);
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
    const ai = bridge(lintReply(["fixture/first", "fixture/second"]));
    const run = await executeLint({ cwd: root }, { fixture: plugin }, ai);
    expect(run.exitCode).toBe(0);
    expect(run.result.summary).toMatchObject({
      totalFiles: 1,
      successFiles: 1,
      warningFiles: 0,
      activeRules: 2,
    });
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  test("uses mixed presets and direct settings without preparing formatter rules", async () => {
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
      rules: { "fixture/second": "error", "fixture/format": {} },
    });
    const ai = bridge(lintReply(["fixture/first", "fixture/second"]));
    const run = await executeLint({ cwd: root }, { fixture: mixedPlugin }, ai);

    expect(run.exitCode).toBe(0);
    expect(run.result.errors).toEqual([]);
    expect(run.result.summary.activeRules).toBe(2);
    expect(
      vi.mocked(ai.run).mock.calls[0]![0].ruleResources.files.map(({ ruleId }) => ruleId),
    ).toEqual(["fixture/first", "fixture/second"]);
    expect(formatPrompt).not.toHaveBeenCalled();
  });

  test("preserves findings from valid preset rules when another preset cannot be resolved", async () => {
    const root = await createProject({
      preset: ["fixture/all", "fixture/missing"],
      rules: { "fixture/second": "off" },
    });
    const ai = bridge({
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
    const run = await executeLint({ cwd: root }, { fixture: plugin }, ai);

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
      plugins: ["@aquarius/rules"],
      rules: {
        "aquarius/contracts/no-input-mutation": ["error", { allowOwnershipTransfer: false }],
        "aquarius/architecture/enforce-layer-direction": "warn",
      },
    });
    const ai = bridge(lintReply());
    const stages: string[] = [];
    const run = await executeLint(
      { cwd: root, onProgress: (stage) => stages.push(stage) },
      { "@aquarius/rules": builtinRules },
      ai,
    );
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
        plugins: ["@aquarius/rules"],
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
    const ai: AiBridge = {
      id: "all-default-rules",
      run: vi.fn(async (input: BridgeInput) =>
        lintReply(input.ruleResources.files.map(({ ruleId }) => ruleId)),
      ),
    };
    const run = await executeLint({ cwd: root }, { "@aquarius/rules": builtinRules }, ai);
    expect(run.exitCode).toBe(0);
    expect(run.result.summary.activeRules).toBe(ruleIds.length);
    expect(run.result.summary.successFiles).toBe(1);
    const calls = vi.mocked(ai.run).mock.calls;
    expect(calls).toHaveLength(1);
    expect(
      calls.flatMap(([input]) => input.ruleResources.files.map(({ ruleId }) => ruleId)),
    ).toEqual(ruleIds);
    expect(vi.mocked(ai.run).mock.calls[0]![0].outputSchema.required).toContain("fileResults");
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
    const ai = bridge({
      ...lintReply(["fixture/first", "fixture/second"]),
      diagnostics: [
        { ...diagnostic, ruleIds: ["fixture/first"] },
        { ...diagnostic, ruleIds: ["fixture/second"] },
        { ...diagnostic, ruleIds: ["unregistered/rule"] },
      ],
    });
    const run = await executeLint({ cwd: root }, { fixture: plugin }, ai);
    expect(run.exitCode).toBe(2);
    expect(run.result.diagnostics).toHaveLength(1);
    expect(run.result.diagnostics[0]!.rules).toEqual([
      { rule: "fixture/first", severity: "warn" },
      { rule: "fixture/second", severity: "error" },
    ]);
    expect(run.result.errors.some(({ code }) => code === "INVALID_RULE_REFERENCE")).toBe(true);
    expect(ai.run).toHaveBeenCalledTimes(1);
    const input = vi.mocked(ai.run).mock.calls[0]![0];
    expect(input.prompt).toContain("fixture/first");
    expect(input.readableFiles).toContain("src/sample.any");
  });

  test("rejects removed uncertainty results and missing rule completion", async () => {
    const root = await createProject();
    const legacy = await executeLint(
      { cwd: root },
      { fixture: plugin },
      bridge({ ...lintReply(), unknowns: [] }),
    );
    expect(legacy.exitCode).toBe(2);
    expect(legacy.result.errors).toContainEqual(
      expect.objectContaining({ code: "INVALID_AI_RESPONSE" }),
    );
    expect(legacy.result).not.toHaveProperty("unknowns");
    expect(legacy.result.summary).toMatchObject({ successFiles: 0, failedFiles: 1 });

    const incomplete = await executeLint({ cwd: root }, { fixture: plugin }, bridge(lintReply([])));
    expect(incomplete.exitCode).toBe(2);
    expect(incomplete.result.errors.some(({ code }) => code === "INCOMPLETE_AI_RESPONSE")).toBe(
      true,
    );
  });

  test("invalid shape is not retried and configured warning severity exits successfully", async () => {
    const root = await createProject({
      rules: { "fixture/first": "warn", "fixture/second": "off" },
    });
    const invalid = bridge("not a parsed result");
    expect((await executeLint({ cwd: root }, { fixture: plugin }, invalid)).exitCode).toBe(2);
    expect(invalid.run).toHaveBeenCalledTimes(1);

    const run = await executeLint(
      { cwd: root },
      { fixture: plugin },
      bridge({
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
    );
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
    const ai = bridge(lintReply());
    const partial = await executeLint({ cwd: root }, { fixture: plugin }, ai);
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
        ai: { adapter: "codex", timeoutMs: 25 },
      }),
    );
    let resourceDirectory = "";
    const slow = vi.fn((input: BridgeInput) => {
      resourceDirectory = input.ruleResources.directory;
      return new Promise<unknown>(() => {});
    });
    const timedOut = await executeLint(
      { cwd: root },
      { fixture: plugin },
      { id: "slow", run: slow },
    );
    expect(timedOut.exitCode).toBe(2);
    expect(timedOut.result.errors[0]!.code).toBe("AI_TIMEOUT");
    expect(timedOut.result.summary).toMatchObject({
      totalFiles: 1,
      successFiles: 0,
      warningFiles: 0,
      failedFiles: 1,
    });
    expect(slow).toHaveBeenCalledTimes(1);
    await expect(access(resourceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "src", "sample.any"), "utf8")).toBe(source);
  });

  test("counts only selected files and preserves independently completed files", async () => {
    const root = await createProject({ ignore: ["src/ignored.any"] });
    await writeFile(join(root, "src/other.any"), source);
    await writeFile(join(root, "src/ignored.any"), source);
    await writeFile(join(root, "README.md"), "Readable context\n");
    const ai = bridge({
      ...lintReply(),
      fileResults: [
        { path: "src/sample.any", status: "completed", reason: "" },
        { path: "src/other.any", status: "failed", reason: "Could not finish analysis." },
      ],
    });
    const run = await executeLint({ cwd: root }, { fixture: plugin }, ai);
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
    const run = await executeLint(
      { cwd: root },
      { fixture: plugin },
      bridge({
        ...lintReply([]),
        skippedRules: [{ ruleId: "fixture/first", reason: "No applicable prerequisite." }],
        fileResults: [
          { path: "src/sample.any", status: "skipped", reason: "No applicable rules." },
        ],
      }),
    );
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

  test("configuration and target selection errors leave the target count undetermined", async () => {
    const root = await createProject();
    const ai = bridge(lintReply());
    const unmatched = await executeLint(
      { cwd: root, paths: ["missing.any"] },
      { fixture: plugin },
      ai,
    );
    expect(unmatched.exitCode).toBe(2);
    expect(unmatched.result.errors[0]!.code).toBe("TARGET_UNMATCHED");
    expect(unmatched.result.summary.totalFiles).toBeNull();
    expect(unmatched.result.fileResults).toEqual([]);

    await writeFile(join(root, ".aqlintrc.json"), "{");
    const invalidConfig = await executeLint({ cwd: root }, { fixture: plugin }, ai);
    expect(invalidConfig.exitCode).toBe(2);
    expect(invalidConfig.result.errors[0]!.code).toBe("CONFIG_PARSE_FAILED");
    expect(invalidConfig.result.summary.totalFiles).toBeNull();
    expect(invalidConfig.result.fileResults).toEqual([]);
    expect(ai.run).not.toHaveBeenCalled();
  });

  test("an allowed empty target selection is known and never invokes AI", async () => {
    const root = await createProject({ files: ["absent/**"] });
    const ai = bridge(lintReply());
    const run = await executeLint(
      { cwd: root, noErrorOnUnmatchedPattern: true },
      { fixture: plugin },
      ai,
    );
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
    let resourceDirectory = "";
    const ai: AiBridge = {
      id: "cancelled",
      run: vi.fn(async (input: BridgeInput) => {
        resourceDirectory = input.ruleResources.directory;
        controller.abort();
        return lintReply();
      }),
    };
    const run = await executeLint(
      { cwd: root, signal: controller.signal },
      { fixture: plugin },
      ai,
    );
    expect(run.exitCode).toBe(130);
    expect(run.result.errors[0]!.code).toBe("AI_ABORTED");
    expect(run.result.summary).toMatchObject({ totalFiles: 1, successFiles: 0, failedFiles: 1 });
    expect(run.result.fileResults[0]!.reason).toContain("cancelled");
    await expect(access(resourceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("cancellation during result checking is not reported as completed", async () => {
    const root = await createProject();
    const controller = new AbortController();
    const ai = bridge(lintReply());
    const run = await executeLint(
      {
        cwd: root,
        signal: controller.signal,
        onProgress: (stage) => {
          if (stage === "Checking results") controller.abort();
        },
      },
      { fixture: plugin },
      ai,
    );
    expect(run.exitCode).toBe(130);
    expect(run.result.errors[0]!.code).toBe("AI_ABORTED");
    expect(run.result.summary).toMatchObject({ totalFiles: 1, successFiles: 0, failedFiles: 1 });
  });
});

test("human CLI preserves per-rule severity, locations, and evidence", async () => {
  const root = await createProject({
    rules: { "fixture/first": "error", "fixture/second": "warn" },
    ai: { adapter: "./bridge.mjs" },
  });
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
    join(root, "bridge.mjs"),
    `export default { id: "fixture", run: async () => (${JSON.stringify(reply)}) };`,
  );
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await runCli("0.1.0", { fixture: plugin }, [])).toBe(1);
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
const fixReply = (path = "src/sample.any", oldText = "first line") => ({
  changes: [{ path, oldText, newText: "corrected line", ruleIds: ["fixture/first"] }],
  errors: [],
});
const fixingBridge = (finalReply: unknown = lintReply()): AiBridge => ({
  id: "fixture",
  run: vi
    .fn()
    .mockResolvedValueOnce(findingReply())
    .mockResolvedValueOnce(fixReply())
    .mockResolvedValueOnce(finalReply),
});

describe("lint fixes", () => {
  test("reuses prepared resources through fixing and rechecks the updated source", async () => {
    const root = await createProject({ preset: ["fixture/all"], rules: {} });
    const ruleIds = ["fixture/first", "fixture/second"];
    const preparation = vi.fn(() => ({
      applicability: "fixture",
      criteria: "fixture",
      evidenceRequirements: ["source"],
    }));
    const trackedPlugin: RulePlugin = {
      ...plugin,
      lintRules: plugin.lintRules!.map((rule) => ({ ...rule, buildPrompt: preparation })),
    };
    const inputs: BridgeInput[] = [];
    const sourceVersions: string[] = [];
    const onProgress = vi.fn();
    const ai: AiBridge = {
      id: "resources",
      run: async (input) => {
        inputs.push(input);
        input.onProgress?.(`Inspecting src/sample.any (request ${inputs.length})`);
        sourceVersions.push(await readFile(join(input.projectRoot, "src/sample.any"), "utf8"));
        for (const resource of input.ruleResources.files) {
          const detail = JSON.parse(
            await readFile(join(input.ruleResources.directory, resource.detailsPath), "utf8"),
          );
          expect(detail.ruleId).toBe(resource.ruleId);
        }
        if (inputs.length === 1) {
          return { ...findingReply(), completedRuleIds: ruleIds };
        }
        if (inputs.length === 2) {
          expect(input.ruleResources.files.map(({ ruleId }) => ruleId)).toEqual([ruleIds[0]]);
          const task = JSON.parse(input.prompt.split("\n\n").at(-1)!);
          expect(task.rules.map(({ ruleId }: { ruleId: string }) => ruleId)).toEqual([ruleIds[0]]);
          return fixReply();
        }
        return lintReply(ruleIds);
      },
    };
    const run = await executeLint(
      { cwd: root, fix: true, onProgress },
      { fixture: trackedPlugin },
      ai,
    );
    expect(run.exitCode).toBe(0);
    expect(preparation).toHaveBeenCalledTimes(2);
    expect(inputs).toHaveLength(3);
    for (const request of [1, 2, 3]) {
      expect(onProgress).toHaveBeenCalledWith(`Inspecting src/sample.any (request ${request})`);
    }
    expect(new Set(inputs.map(({ ruleResources }) => ruleResources.directory)).size).toBe(1);
    expect(sourceVersions).toEqual([source, source, "corrected line\nsecond line\n"]);
    expect(run.result.changedFiles).toEqual(["src/sample.any"]);
    await expect(access(inputs[0]!.ruleResources.directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("preserves reported detail-read errors and refuses every proposed change", async () => {
    const root = await createProject();
    const reportedErrors = [
      {
        code: "RULE_DETAIL_UNREADABLE",
        message: "Could not read the selected rule details.",
        ruleIds: ["fixture/first"],
      },
      {
        code: "RULE_DETAIL_INCOMPLETE",
        message: "The complete criteria were unavailable.",
        ruleIds: ["fixture/first"],
      },
    ];
    const ai: AiBridge = {
      id: "errors",
      run: vi
        .fn()
        .mockResolvedValueOnce(findingReply())
        .mockResolvedValueOnce({ ...fixReply(), errors: reportedErrors }),
    };
    const run = await executeLint({ cwd: root, fix: true }, { fixture: plugin }, ai);
    expect(run.exitCode).toBe(2);
    expect(run.result.errors).toEqual(reportedErrors);
    expect(run.result.changedFiles).toEqual([]);
    expect(run.result.summary.failedFiles).toBe(1);
    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(source);
  });

  test("rejects fix errors referring to undiagnosed rules", async () => {
    const root = await createProject();
    const ai: AiBridge = {
      id: "invalid-errors",
      run: vi
        .fn()
        .mockResolvedValueOnce(findingReply())
        .mockResolvedValueOnce({
          ...fixReply(),
          errors: [{ code: "READ_FAILED", message: "Unavailable", ruleIds: ["fixture/second"] }],
        }),
    };
    const run = await executeLint({ cwd: root, fix: true }, { fixture: plugin }, ai);
    expect(run.exitCode).toBe(2);
    expect(run.result.errors.some(({ code }) => code === "INVALID_RULE_REFERENCE")).toBe(true);
    expect(run.result.changedFiles).toEqual([]);
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(source);
  });

  test("requires the fix errors array instead of accepting an older response", async () => {
    const root = await createProject();
    const ai: AiBridge = {
      id: "old-response",
      run: vi.fn().mockResolvedValueOnce(findingReply()).mockResolvedValueOnce({ changes: [] }),
    };
    const run = await executeLint({ cwd: root, fix: true }, { fixture: plugin }, ai);
    expect(run.exitCode).toBe(2);
    expect(run.result.errors[0]!.code).toBe("INVALID_FIX_RESPONSE");
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(source);
  });

  test("corrects an input-mutation diagnostic while preserving the returned result", async () => {
    const ruleId = "aquarius/contracts/no-input-mutation";
    const root = await createProject({
      plugins: ["@aquarius/rules"],
      rules: { [ruleId]: ["error", { allowOwnershipTransfer: false }] },
    });
    await writeFile(
      join(root, "src/sample.any"),
      "// Return sorted values without modifying the caller's input.\nfunction sortedCopy(input) { return input.sort((a, b) => a - b); }\n",
    );
    const ai = {
      id: "fixture",
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ...lintReply([ruleId]),
          diagnostics: [
            {
              ruleIds: [ruleId],
              message: "Sorting mutates borrowed input.",
              locations: [{ path: "src/sample.any", line: 2, column: 37 }],
              evidence: [
                {
                  path: "src/sample.any",
                  line: 1,
                  message: "The contract requires preserving caller input.",
                },
              ],
            },
          ],
        })
        .mockResolvedValueOnce({
          errors: [],
          changes: [
            {
              path: "src/sample.any",
              oldText: "return input.sort",
              newText: "return [...input].sort",
              ruleIds: [ruleId],
            },
          ],
        })
        .mockResolvedValueOnce(lintReply([ruleId])),
    };
    const result = await executeLint(
      { cwd: root, fix: true },
      { "@aquarius/rules": builtinRules },
      ai,
    );
    expect(result.exitCode).toBe(0);
    const corrected = await readFile(join(root, "src/sample.any"), "utf8");
    const behavior = runInNewContext(
      `${corrected}\nconst values = [3, 1, 2]; JSON.stringify({ result: sortedCopy(values), input: values });`,
    );
    expect(JSON.parse(behavior)).toEqual({ result: [1, 2, 3], input: [3, 1, 2] });
  });

  test("fixes diagnosed text then reports verified remaining findings and severity", async () => {
    const root = await createProject();
    const ai = fixingBridge();
    const fixed = await executeLint({ cwd: root, fix: true }, { fixture: plugin }, ai);
    expect(fixed).toEqual({
      result: { ...lintReplyResult(), changedFiles: ["src/sample.any"] },
      exitCode: 0,
    });
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(
      "corrected line\nsecond line\n",
    );
    expect(ai.run).toHaveBeenCalledTimes(3);
    const prompt = vi.mocked(ai.run).mock.calls[1]![0].prompt;
    expect(prompt).toContain('"task": "lint-fix"');
    expect(prompt).toContain("Do not perform formatting-only changes");

    await writeFile(join(root, "src/sample.any"), source);
    const remaining = await executeLint(
      { cwd: root, fix: true },
      { fixture: plugin },
      fixingBridge(findingReply()),
    );
    expect(remaining.exitCode).toBe(1);
    expect(remaining.result.changedFiles).toEqual(["src/sample.any"]);
    expect(remaining.result.diagnostics).toHaveLength(1);
  });

  test("ordinary lint never writes, and fix skips clean or failed evaluation", async () => {
    const root = await createProject();
    const ai = bridge(findingReply());
    expect((await executeLint({ cwd: root }, { fixture: plugin }, ai)).exitCode).toBe(1);
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(source);
    const clean = bridge(lintReply());
    expect((await executeLint({ cwd: root, fix: true }, { fixture: plugin }, clean)).exitCode).toBe(
      0,
    );
    expect(clean.run).toHaveBeenCalledTimes(1);
    const invalid = bridge({ ...findingReply(), completedRuleIds: [] });
    expect(
      (await executeLint({ cwd: root, fix: true }, { fixture: plugin }, invalid)).exitCode,
    ).toBe(2);
    expect(invalid.run).toHaveBeenCalledTimes(1);
  });

  test("empty proposals leave unresolved findings and source unchanged", async () => {
    const root = await createProject();
    const ai = {
      id: "fixture",
      run: vi
        .fn()
        .mockResolvedValueOnce(findingReply())
        .mockResolvedValueOnce({ changes: [], errors: [] }),
    };
    const result = await executeLint({ cwd: root, fix: true }, { fixture: plugin }, ai);
    expect(result.exitCode).toBe(1);
    expect(result.result.changedFiles).toEqual([]);
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(source);
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  test("file processing failure prevents automatic fixes even without a global error", async () => {
    const root = await createProject();
    const ai = bridge({
      ...findingReply(),
      fileResults: [
        { path: "src/sample.any", status: "failed", reason: "Only partial analysis is available." },
      ],
    });
    const run = await executeLint({ cwd: root, fix: true }, { fixture: plugin }, ai);
    expect(run.exitCode).toBe(2);
    expect(run.result.summary.failedFiles).toBe(1);
    expect(run.result.diagnostics).toHaveLength(1);
    expect(run.result.changedFiles).toEqual([]);
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(source);
  });

  test.each([
    ["../outside.any", "first line", "CHANGE_OUTSIDE_SCOPE"],
    ["README.md", "first line", "CHANGE_OUTSIDE_SCOPE"],
    ["src/ignored.any", "first line", "CHANGE_OUTSIDE_SCOPE"],
    ["src/other.any", "first line", "FIX_WITHOUT_DIAGNOSTIC"],
    ["src/sample.any", "missing original", "REPLACE_NOT_UNIQUE"],
  ])("rejects unsafe or unrelated replacement %s", async (path, oldText, code) => {
    const root = await createProject({ ignore: ["src/ignored.any"] });
    await writeFile(join(root, "src/ignored.any"), source);
    await writeFile(join(root, "src/other.any"), source);
    await writeFile(join(root, "README.md"), source);
    const ai = {
      id: "fixture",
      run: vi
        .fn()
        .mockResolvedValueOnce(findingReply(["src/sample.any", "src/other.any"]))
        .mockResolvedValueOnce(fixReply(path, oldText)),
    };
    const result = await executeLint({ cwd: root, fix: true }, { fixture: plugin }, ai);
    expect(result.exitCode).toBe(2);
    expect(result.result.errors.some((error) => error.code === code)).toBe(true);
    for (const file of ["src/sample.any", "src/ignored.any", "src/other.any", "README.md"]) {
      expect(await readFile(join(root, file), "utf8")).toBe(source);
    }
  });

  test("refuses stale input without overwriting a concurrent edit", async () => {
    const root = await createProject();
    const ai = {
      id: "fixture",
      run: vi
        .fn()
        .mockResolvedValueOnce(findingReply())
        .mockImplementationOnce(async () => {
          await writeFile(join(root, "src/sample.any"), "user edit\n");
          return fixReply();
        }),
    };
    const result = await executeLint({ cwd: root, fix: true }, { fixture: plugin }, ai);
    expect(result.exitCode).toBe(2);
    expect(result.result.errors.some(({ code }) => code === "SOURCE_CHANGED")).toBe(true);
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe("user edit\n");
  });

  test("reports applied files and execution error if final verification fails", async () => {
    const root = await createProject();
    const ai: AiBridge = {
      id: "fixture",
      run: vi
        .fn()
        .mockResolvedValueOnce(findingReply())
        .mockResolvedValueOnce(fixReply())
        .mockRejectedValueOnce(new Error("recheck unavailable")),
    };
    const result = await executeLint({ cwd: root, fix: true }, { fixture: plugin }, ai);
    expect(result.exitCode).toBe(2);
    expect(result.result.changedFiles).toEqual(["src/sample.any"]);
    expect(result.result.diagnostics).toEqual([]);
    expect(result.result.errors[0]!.message).toContain("recheck unavailable");
    expect(result.result.summary).toMatchObject({
      totalFiles: 1,
      successFiles: 0,
      warningFiles: 0,
      failedFiles: 1,
    });
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(
      "corrected line\nsecond line\n",
    );
    const resourceDirectory = vi.mocked(ai.run).mock.calls[0]![0].ruleResources.directory;
    await expect(access(resourceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
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

test("fix CLI uses configured bridge and prints JSON with final diagnostics", async () => {
  const root = await createProject({ ai: { adapter: "./bridge.mjs" } });
  await writeFile(
    join(root, "bridge.mjs"),
    [
      'import { readFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      'export default { id: "fixture", run: async (input) => {',
      'if (input.prompt.includes("lint-fix")) return ' + JSON.stringify(fixReply()) + ";",
      'const text = await readFile(join(input.projectRoot, "src/sample.any"), "utf8");',
      'return text.includes("corrected line") ? ' +
        JSON.stringify(lintReply()) +
        " : " +
        JSON.stringify(findingReply()) +
        ";",
      "} };",
    ].join("\n"),
  );
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(
      await runCli("0.1.0", { fixture: plugin }, ["--fix", "--format", "json", "src/sample.any"]),
    ).toBe(0);
    expect(JSON.parse(logs.mock.calls[0]![0])).toEqual({
      ...lintReplyResult(),
      changedFiles: ["src/sample.any"],
    });
    expect(errors).not.toHaveBeenCalled();
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(
      "corrected line\nsecond line\n",
    );
  } finally {
    cwd.mockRestore();
    logs.mockRestore();
    errors.mockRestore();
  }
});

test("JSON CLI output stays structured and contains no terminal styling", async () => {
  const root = await createProject({ ai: { adapter: "./bridge.mjs" } });
  await writeFile(
    join(root, "bridge.mjs"),
    `export default { id: "fixture", run: async () => (${JSON.stringify(findingReply())}) };`,
  );
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await runCli("0.1.0", { fixture: plugin }, ["--format", "json", "src/sample.any"])).toBe(
      1,
    );
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

test("reports cache fallback on stderr while preserving JSON output and successful analysis", async () => {
  const root = await createProject({ ai: { adapter: "./bridge.mjs" } });
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules/.cache"), "Not a cache directory.\n");
  await writeFile(
    join(root, "bridge.mjs"),
    [
      'import { readFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      'export default { id: "fixture", run: async (input) => {',
      "const resource = input.ruleResources.files[0];",
      'const detail = JSON.parse(await readFile(join(input.ruleResources.directory, resource.detailsPath), "utf8"));',
      'if (detail.ruleId !== "fixture/first") throw new Error("Wrong rule detail");',
      `return ${JSON.stringify(lintReply())};`,
      "} };",
    ].join("\n"),
  );
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await runCli("0.1.0", { fixture: plugin }, ["--format", "json"])).toBe(0);
    expect(logs).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(logs.mock.calls[0]![0]));
    expect(output.errors).toEqual([]);
    expect(output.summary.successFiles).toBe(1);
    expect(warnings.mock.calls.flat().join("\n")).toMatch(/cache/i);
  } finally {
    cwd.mockRestore();
    logs.mockRestore();
    warnings.mockRestore();
  }
});
