import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AiBridge, RulePlugin } from "@aquarius/core/internal";
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
    defaultSeverity: "error" as const,
    buildPrompt: () => ({
      applicability: "fixture",
      criteria: "fixture",
      evidenceRequirements: ["source"],
    }),
  })),
};

const createProject = async (extra: Record<string, unknown> = {}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "aqlint-test-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "sample.any"), source);
  await writeFile(join(root, ".aqlintrc.jsonc"), JSON.stringify({
    files: ["src/**"],
    plugins: ["fixture"],
    rules: [{ rule: "fixture/first" }],
    ...extra,
  }));
  return root;
};

const lintReply = (ruleIds = ["fixture/first"]) => ({
  completedRuleIds: ruleIds,
  diagnostics: [],
  unknowns: [],
  errors: [],
});

const bridge = (result: unknown): AiBridge => ({
  id: "fixture",
  run: vi.fn(async () => result),
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const candidate = resolve(root);
    if (dirname(candidate) !== resolve(tmpdir()) || !basename(candidate).startsWith("aqlint-test-")) {
      throw new Error("Unexpected cleanup path.");
    }
    await rm(candidate, { recursive: true, force: true });
  }
});

describe("lint execution", () => {
  test("reports actual analysis stages", async () => {
    const root = await createProject();
    const onProgress = vi.fn();
    const run = await executeLint({ cwd: root, onProgress }, { fixture: plugin }, bridge(lintReply()));
    expect(run.exitCode).toBe(0);
    expect(onProgress.mock.calls.map(([stage]) => stage)).toEqual([
      "Preparing rules", "Selecting files", "Analyzing files with AI", "Checking results",
    ]);
  });

  test("context may provide evidence but cannot receive primary diagnostics", async () => {
    const root = await createProject();
    await writeFile(join(root, "README.md"), "Existing project contract\n");
    const diagnostic = {
      ruleIds: ["fixture/first"],
      message: "Scoped issue",
      locations: [{ path: "src/sample.any", line: 1, column: 1 }],
      evidence: [{ path: "README.md", line: 1, message: "Contract evidence" }],
    };
    const valid = await executeLint({ cwd: root }, { fixture: plugin }, bridge({
      ...lintReply(),
      diagnostics: [diagnostic],
    }));
    expect(valid.result.diagnostics).toHaveLength(1);

    const invalid = await executeLint({ cwd: root }, { fixture: plugin }, bridge({
      ...lintReply(),
      diagnostics: [{
        ...diagnostic,
        locations: [...diagnostic.locations, { path: "README.md", line: 1, column: 1 }],
      }],
    }));
    expect(invalid.exitCode).toBe(2);
    expect(invalid.result.diagnostics).toEqual([]);
  });

  test("empty and disabled rules never invoke AI", async () => {
    const root = await createProject({ rules: [] });
    const ai = bridge({});
    expect(await executeLint({ cwd: root }, { fixture: plugin }, ai)).toEqual({
      result: { diagnostics: [], unknowns: [], errors: [] },
      exitCode: 0,
    });
    expect(ai.run).not.toHaveBeenCalled();

    await writeFile(join(root, ".aqlintrc.jsonc"), JSON.stringify({
      rules: [{ rule: "missing/rule", severity: "off" }],
    }));
    expect((await executeLint({ cwd: root }, {}, ai)).exitCode).toBe(0);
    expect(ai.run).not.toHaveBeenCalled();
  });

  test("preserves valid findings, exact duplicate contributors, and invalid item errors", async () => {
    const root = await createProject({
      rules: [
        { rule: "fixture/first", severity: "warn" },
        { rule: "fixture/second" },
      ],
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

  test("unknown conclusions do not fail and missing completion does", async () => {
    const root = await createProject();
    const unknown = await executeLint({ cwd: root }, { fixture: plugin }, bridge({
      ...lintReply(),
      unknowns: [{
        ruleIds: ["fixture/first"],
        message: "External contract is unavailable.",
        locations: [],
      }],
    }));
    expect(unknown.exitCode).toBe(0);
    expect(unknown.result.unknowns).toHaveLength(1);

    const incomplete = await executeLint({ cwd: root }, { fixture: plugin }, bridge(lintReply([])));
    expect(incomplete.exitCode).toBe(2);
    expect(incomplete.result.errors.some(({ code }) => code === "INCOMPLETE_AI_RESPONSE")).toBe(true);
  });

  test("invalid shape is not retried and configured warning severity exits successfully", async () => {
    const root = await createProject({ rules: [{ rule: "fixture/first", severity: "warn" }] });
    const invalid = bridge("not a parsed result");
    expect((await executeLint({ cwd: root }, { fixture: plugin }, invalid)).exitCode).toBe(2);
    expect(invalid.run).toHaveBeenCalledTimes(1);

    const run = await executeLint({ cwd: root }, { fixture: plugin }, bridge({
      ...lintReply(),
      diagnostics: [{
        ruleIds: ["fixture/first"],
        message: "Warning",
        locations: [{ path: "src/sample.any", line: 1, column: 1 }],
        evidence: [{ path: "src/sample.any", line: 1, message: "Evidence" }],
      }],
    }));
    expect(run.exitCode).toBe(0);
    expect(run.result.diagnostics[0]!.severity).toBe("warn");
  });

  test("rule preparation failure keeps independent evaluation and timeout keeps source unchanged", async () => {
    const root = await createProject({
      rules: [{ rule: "fixture/first" }, { rule: "fixture/missing" }],
    });
    const ai = bridge(lintReply());
    const partial = await executeLint({ cwd: root }, { fixture: plugin }, ai);
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(partial.exitCode).toBe(2);
    expect(partial.result.errors.length).toBeGreaterThan(0);

    await writeFile(join(root, ".aqlintrc.jsonc"), JSON.stringify({
      files: ["src/**"],
      plugins: ["fixture"],
      rules: [{ rule: "fixture/first" }],
      ai: { timeoutMs: 25 },
    }));
    const slow = vi.fn(() => new Promise<unknown>(() => {}));
    const timedOut = await executeLint({ cwd: root }, { fixture: plugin }, { id: "slow", run: slow });
    expect(timedOut.exitCode).toBe(2);
    expect(timedOut.result.errors[0]!.code).toBe("AI_TIMEOUT");
    expect(slow).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, "src", "sample.any"), "utf8")).toBe(source);
  });
});

test("human CLI preserves per-rule severity, locations, and evidence", async () => {
  const root = await createProject({
    rules: [
      { rule: "fixture/first" },
      { rule: "fixture/second", severity: "warn" },
    ],
    ai: { adapter: "./bridge.mjs" },
  });
  const reply = {
    ...lintReply(["fixture/first", "fixture/second"]),
    diagnostics: [{
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
    }],
  };
  await writeFile(join(root, "bridge.mjs"), `export default { id: "fixture", run: async () => (${JSON.stringify(reply)}) };`);
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


const findingReply = () => ({
  ...lintReply(),
  diagnostics: [{
    ruleIds: ["fixture/first"],
    message: "Mutation issue",
    locations: [{ path: "src/sample.any", line: 1, column: 1 }],
    evidence: [{ path: "src/sample.any", line: 1, message: "Mutation evidence" }],
  }],
});
const fixReply = (path = "src/sample.any", oldText = "first line") => ({
  changes: [{ path, oldText, newText: "corrected line", ruleIds: ["fixture/first"] }],
});
const fixingBridge = (finalReply: unknown = lintReply()): AiBridge => ({
  id: "fixture",
  run: vi.fn().mockResolvedValueOnce(findingReply()).mockResolvedValueOnce(fixReply()).mockResolvedValueOnce(finalReply),
});

describe("lint fixes", () => {
  test("corrects an input-mutation diagnostic while preserving the returned result", async () => {
    const ruleId = "aquarius/contracts/no-input-mutation";
    const root = await createProject({
      plugins: ["@aquarius/rules"],
      rules: [{ rule: ruleId }],
    });
    await writeFile(join(root, "src/sample.any"),
      "// Return sorted values without modifying the caller's input.\nfunction sortedCopy(input) { return input.sort((a, b) => a - b); }\n");
    const ai = { id: "fixture", run: vi.fn()
      .mockResolvedValueOnce({ ...lintReply([ruleId]), diagnostics: [{
        ruleIds: [ruleId], message: "Sorting mutates borrowed input.",
        locations: [{ path: "src/sample.any", line: 2, column: 37 }],
        evidence: [{ path: "src/sample.any", line: 1, message: "The contract requires preserving caller input." }],
      }] })
      .mockResolvedValueOnce({ changes: [{
        path: "src/sample.any", oldText: "return input.sort", newText: "return [...input].sort", ruleIds: [ruleId],
      }] })
      .mockResolvedValueOnce(lintReply([ruleId])) };
    const result = await executeLint({ cwd: root, fix: true }, { "@aquarius/rules": builtinRules }, ai);
    expect(result.exitCode).toBe(0);
    const corrected = await readFile(join(root, "src/sample.any"), "utf8");
    const behavior = runInNewContext(`${corrected}\nconst values = [3, 1, 2]; JSON.stringify({ result: sortedCopy(values), input: values });`);
    expect(JSON.parse(behavior)).toEqual({ result: [1, 2, 3], input: [3, 1, 2] });
  });

  test("fixes diagnosed text then reports verified remaining findings and severity", async () => {
    const root = await createProject();
    const ai = fixingBridge();
    const fixed = await executeLint({ cwd: root, fix: true }, { fixture: plugin }, ai);
    expect(fixed).toEqual({ result: { ...lintReplyResult(), changedFiles: ["src/sample.any"] }, exitCode: 0 });
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe("corrected line\nsecond line\n");
    expect(ai.run).toHaveBeenCalledTimes(3);
    const prompt = vi.mocked(ai.run).mock.calls[1]![0].prompt;
    expect(prompt).toContain('"task": "lint-fix"');
    expect(prompt).toContain("Do not perform formatting-only changes");

    await writeFile(join(root, "src/sample.any"), source);
    const remaining = await executeLint({ cwd: root, fix: true }, { fixture: plugin }, fixingBridge(findingReply()));
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
    expect((await executeLint({ cwd: root, fix: true }, { fixture: plugin }, clean)).exitCode).toBe(0);
    expect(clean.run).toHaveBeenCalledTimes(1);
    const invalid = bridge({ ...findingReply(), completedRuleIds: [] });
    expect((await executeLint({ cwd: root, fix: true }, { fixture: plugin }, invalid)).exitCode).toBe(2);
    expect(invalid.run).toHaveBeenCalledTimes(1);
  });

  test("empty proposals leave unresolved findings and source unchanged", async () => {
    const root = await createProject();
    const ai = { id: "fixture", run: vi.fn().mockResolvedValueOnce(findingReply()).mockResolvedValueOnce({ changes: [] }) };
    const result = await executeLint({ cwd: root, fix: true }, { fixture: plugin }, ai);
    expect(result.exitCode).toBe(1);
    expect(result.result.changedFiles).toEqual([]);
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(source);
    expect(ai.run).toHaveBeenCalledTimes(2);
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
    const ai = { id: "fixture", run: vi.fn().mockResolvedValueOnce(findingReply()).mockResolvedValueOnce(fixReply(path, oldText)) };
    const result = await executeLint({ cwd: root, fix: true }, { fixture: plugin }, ai);
    expect(result.exitCode).toBe(2);
    expect(result.result.errors.some((error) => error.code === code)).toBe(true);
    for (const file of ["src/sample.any", "src/ignored.any", "src/other.any", "README.md"]) {
      expect(await readFile(join(root, file), "utf8")).toBe(source);
    }
  });

  test("refuses stale input without overwriting a concurrent edit", async () => {
    const root = await createProject();
    const ai = { id: "fixture", run: vi.fn()
      .mockResolvedValueOnce(findingReply())
      .mockImplementationOnce(async () => {
        await writeFile(join(root, "src/sample.any"), "user edit\n");
        return fixReply();
      }) };
    const result = await executeLint({ cwd: root, fix: true }, { fixture: plugin }, ai);
    expect(result.exitCode).toBe(2);
    expect(result.result.errors.some(({ code }) => code === "SOURCE_CHANGED")).toBe(true);
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe("user edit\n");
  });

  test("reports applied files and execution error if final verification fails", async () => {
    const root = await createProject();
    const ai = { id: "fixture", run: vi.fn()
      .mockResolvedValueOnce(findingReply()).mockResolvedValueOnce(fixReply())
      .mockRejectedValueOnce(new Error("recheck unavailable")) };
    const result = await executeLint({ cwd: root, fix: true }, { fixture: plugin }, ai);
    expect(result.exitCode).toBe(2);
    expect(result.result.changedFiles).toEqual(["src/sample.any"]);
    expect(result.result.diagnostics).toEqual([]);
    expect(result.result.errors[0]!.message).toContain("recheck unavailable");
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe("corrected line\nsecond line\n");
  });
});

const lintReplyResult = (): LintResult => ({ diagnostics: [], unknowns: [], errors: [] });

test("fix CLI uses configured bridge and prints JSON with final diagnostics", async () => {
  const root = await createProject({ ai: { adapter: "./bridge.mjs" } });
  await writeFile(join(root, "bridge.mjs"), [
    'import { readFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    'export default { id: "fixture", run: async (input) => {',
    'if (input.prompt.includes("lint-fix")) return ' + JSON.stringify(fixReply()) + ';',
    'const text = await readFile(join(input.projectRoot, "src/sample.any"), "utf8");',
    'return text.includes("corrected line") ? ' + JSON.stringify(lintReply()) + ' : ' + JSON.stringify(findingReply()) + ';',
    '} };',
  ].join("\n"));
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await runCli("0.1.0", { fixture: plugin }, ["--fix", "--format", "json", "src/sample.any"])).toBe(0);
    expect(JSON.parse(logs.mock.calls[0]![0])).toEqual({ ...lintReplyResult(), changedFiles: ["src/sample.any"] });
    expect(errors).not.toHaveBeenCalled();
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe("corrected line\nsecond line\n");
  } finally {
    cwd.mockRestore(); logs.mockRestore(); errors.mockRestore();
  }
});

test("JSON CLI output stays structured and contains no terminal styling", async () => {
  const root = await createProject({ ai: { adapter: "./bridge.mjs" } });
  await writeFile(join(root, "bridge.mjs"), `export default { id: "fixture", run: async () => (${JSON.stringify(findingReply())}) };`);
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await runCli("0.1.0", { fixture: plugin }, ["--format", "json", "src/sample.any"])).toBe(1);
    const output = String(logs.mock.calls[0]![0]);
    expect(output).not.toContain("\x1b");
    expect(JSON.parse(output).diagnostics).toHaveLength(1);
  } finally {
    cwd.mockRestore(); logs.mockRestore();
  }
});

