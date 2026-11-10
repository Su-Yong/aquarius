import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { PathPolicy, PreparedRule } from "@aquarius/core/internal";
import { normalizeLintResponse, summarizeLintResult } from "../src/lint/results";
import type { FileResult } from "../src/lint/schemas";

const roots: string[] = [];
const rules: PreparedRule[] = [
  {
    id: "fixture/check",
    scope: "file",
    severity: "error",
    instructions: {
      applicability: "Source files",
      criteria: "Check the fixture contract",
      evidenceRequirements: ["Source evidence"],
    },
  },
];

const createPolicy = async (targets = ["a.ts", "b.ts"]): Promise<PathPolicy> => {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "aqlint-results-")));
  roots.push(projectRoot);
  const readableFiles = [...targets, "README.md"];
  for (const path of readableFiles) {
    await mkdir(dirname(join(projectRoot, path)), { recursive: true });
    await writeFile(join(projectRoot, path), "first line\nsecond line\n");
  }
  return {
    projectRoot,
    targets,
    readableFiles,
    ignoreRules: [],
    isIgnored: () => false,
    canWrite: (path) => targets.includes(path),
  };
};

const fileResult = (
  path: string,
  status: FileResult["status"] = "completed",
  reason = "",
): FileResult => ({ path, status, reason });

const reply = (
  policy: PathPolicy,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  completedRuleIds: ["fixture/check"],
  skippedRules: [],
  diagnostics: [],
  errors: [],
  fileResults: policy.targets.map((path) => fileResult(path)),
  ...overrides,
});

const diagnostic = (path = "a.ts") => ({
  ruleIds: ["fixture/check"],
  message: "A supported violation",
  locations: [{ path, line: 1, column: 1 }],
  evidence: [{ path: "README.md", line: 1, message: "The relevant contract" }],
});

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("file processing results", () => {
  test("preserves explicit non-applicable rule results without claiming detailed completion", async () => {
    const policy = await createPolicy();
    const skippedRules = [{ ruleId: "fixture/check", reason: "No applicable contract exists." }];
    const result = await normalizeLintResponse(
      reply(policy, {
        completedRuleIds: [],
        skippedRules,
        fileResults: policy.targets.map((path) => fileResult(path, "skipped", "No rule applies")),
      }),
      rules,
      policy,
    );

    expect(result.skippedRules).toEqual(skippedRules);
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({ skippedFiles: 2, failedFiles: 0, activeRules: 1 });
  });

  test("does not count files as successful when every requested rule is inapplicable", async () => {
    const policy = await createPolicy();
    const result = await normalizeLintResponse(
      reply(policy, {
        completedRuleIds: [],
        skippedRules: [{ ruleId: "fixture/check", reason: "No applicable prerequisite." }],
      }),
      rules,
      policy,
    );

    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({ successFiles: 0, skippedFiles: 2 });
    expect(result.fileResults.every(({ status }) => status === "skipped")).toBe(true);
  });

  test("rejects diagnostics for skipped rules while preserving unrelated findings", async () => {
    const policy = await createPolicy();
    const otherRule: PreparedRule = { ...rules[0]!, id: "fixture/other" };
    const otherFinding = { ...diagnostic("b.ts"), ruleIds: ["fixture/other"] };
    const result = await normalizeLintResponse(
      reply(policy, {
        completedRuleIds: ["fixture/other"],
        skippedRules: [{ ruleId: "fixture/check", reason: "No applicable contract exists." }],
        diagnostics: [diagnostic(), otherFinding],
      }),
      [...rules, otherRule],
      policy,
    );

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.rules).toEqual([{ rule: "fixture/other", severity: "error" }]);
    expect(result.errors).toEqual([expect.objectContaining({ code: "CONFLICTING_RULE_RESULT" })]);
    expect(result.fileResults.map(({ status }) => status)).toEqual(["failed", "completed"]);
  });

  test("rejects the removed unknowns field rather than silently declaring success", async () => {
    const policy = await createPolicy();
    const result = await normalizeLintResponse(reply(policy, { unknowns: [] }), rules, policy);

    expect(result.errors).toEqual([expect.objectContaining({ code: "INVALID_AI_RESPONSE" })]);
    expect(result.summary).toMatchObject({ successFiles: 0, failedFiles: 2 });
    expect(result).not.toHaveProperty("unknowns");
    expect(result.summary).not.toHaveProperty("unknownFiles");
    expect(result.summary).not.toHaveProperty("projectUnknowns");
  });

  test("requires skippedRules in the response instead of silently adapting an old response", async () => {
    const policy = await createPolicy();
    const input = reply(policy);
    delete input.skippedRules;

    const result = await normalizeLintResponse(input, rules, policy);

    expect(result.errors).toEqual([expect.objectContaining({ code: "INVALID_AI_RESPONSE" })]);
    expect(result.summary.failedFiles).toBe(2);
    expect(result.skippedRules).toEqual([]);
  });

  test("counts success, warning, failure and skip once per file", async () => {
    const policy = await createPolicy(["clean.ts", "warn.ts", "error.ts", "skip.ts", "failed.ts"]);
    const warningRule: PreparedRule = { ...rules[0]!, id: "fixture/warn", severity: "warn" };
    const warning = (path: string) => ({ ...diagnostic(path), ruleIds: ["fixture/warn"] });
    const input = reply(policy, {
      completedRuleIds: ["fixture/check", "fixture/warn"],
      fileResults: [
        fileResult("clean.ts"),
        fileResult("warn.ts"),
        fileResult("error.ts"),
        fileResult("skip.ts", "skipped", "No rule applies"),
        fileResult("failed.ts", "failed", "Unable to read the source"),
      ],
      diagnostics: [
        warning("warn.ts"),
        { ...warning("warn.ts"), message: "Another warning in the same file" },
        warning("error.ts"),
        diagnostic("error.ts"),
        diagnostic("failed.ts"),
      ],
    });
    const snapshot = structuredClone(input);
    const result = await normalizeLintResponse(input, [...rules, warningRule], policy);

    expect(result.summary).toEqual({
      totalFiles: 5,
      successFiles: 1,
      warningFiles: 1,
      skippedFiles: 1,
      failedFiles: 2,
      activeRules: 2,
    });
    const { successFiles, warningFiles, skippedFiles, failedFiles } = result.summary;
    expect(successFiles + warningFiles + skippedFiles + failedFiles).toBe(5);
    expect(result.errors).toEqual([]);
    expect(result.fileResults).toEqual(input.fileResults);
    expect(input).toEqual(snapshot);
  });

  test("preserves eight confirmed outcomes and fails only two missing target reports", async () => {
    const policy = await createPolicy(Array.from({ length: 10 }, (_, index) => `${index}.ts`));
    const result = await normalizeLintResponse(
      reply(policy, { fileResults: policy.targets.slice(0, 8).map((path) => fileResult(path)) }),
      rules,
      policy,
    );

    expect(result.summary).toMatchObject({ totalFiles: 10, successFiles: 8, failedFiles: 2 });
    expect(result.fileResults.slice(8).map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "8.ts", status: "failed" },
      { path: "9.ts", status: "failed" },
    ]);
    expect(result.errors.map(({ code }) => code)).toEqual([
      "INCOMPLETE_FILE_RESULTS",
      "INCOMPLETE_FILE_RESULTS",
    ]);
  });

  test("fails duplicate reports without selecting one or failing unrelated targets", async () => {
    const policy = await createPolicy();
    const result = await normalizeLintResponse(
      reply(policy, {
        fileResults: [
          fileResult("a.ts"),
          fileResult("a.ts", "skipped", "Not applicable"),
          fileResult("b.ts"),
        ],
      }),
      rules,
      policy,
    );

    expect(result.fileResults.map(({ status }) => status)).toEqual(["failed", "completed"]);
    expect(result.errors).toEqual([expect.objectContaining({ code: "DUPLICATE_FILE_RESULT" })]);
  });

  test.each([
    { name: "invalid status", item: { path: "a.ts", status: "ignored", reason: "Nothing" } },
    { name: "missing status", item: { path: "a.ts", reason: "Nothing" } },
    { name: "missing completed reason field", item: { path: "a.ts", status: "completed" } },
    { name: "empty skip reason", item: fileResult("a.ts", "skipped") },
    { name: "blank failure reason", item: fileResult("a.ts", "failed", "   ") },
    { name: "additional property", item: { ...fileResult("a.ts"), extra: true } },
  ])("fails only the target with $name", async ({ item }) => {
    const policy = await createPolicy();
    const result = await normalizeLintResponse(
      reply(policy, { fileResults: [item, fileResult("b.ts")] }),
      rules,
      policy,
    );

    expect(result.fileResults.map(({ status }) => status)).toEqual(["failed", "completed"]);
    expect(result.fileResults[0]!.reason).not.toBe("");
    expect(result.errors).toHaveLength(1);
  });

  test.each(["README.md", "../a.ts", "/a.ts", "a/../a.ts", "a\\b.ts", "a.ts\n"])(
    "rejects an extra path %j without counting context or out-of-scope files",
    async (path) => {
      const policy = await createPolicy();
      const result = await normalizeLintResponse(
        reply(policy, { fileResults: [fileResult("a.ts"), fileResult("b.ts"), fileResult(path)] }),
        rules,
        policy,
      );

      expect(result.fileResults.map(({ path }) => path)).toEqual(policy.targets);
      expect(result.summary).toMatchObject({ totalFiles: 2, successFiles: 2, failedFiles: 0 });
      expect(result.errors).toEqual([expect.objectContaining({ code: "INVALID_RESULT_PATH" })]);
    },
  );

  test("rejects skipped files with diagnostics", async () => {
    const policy = await createPolicy();
    const result = await normalizeLintResponse(
      reply(policy, {
        fileResults: [fileResult("a.ts", "skipped", "No rule applies"), fileResult("b.ts")],
        diagnostics: [diagnostic()],
      }),
      rules,
      policy,
    );

    expect(result.fileResults.map(({ status }) => status)).toEqual(["failed", "completed"]);
    expect(result.errors).toEqual([expect.objectContaining({ code: "CONFLICTING_FILE_RESULT" })]);
    expect(result.diagnostics).toHaveLength(1);
  });

  test("keeps valid partial findings for a failed file", async () => {
    const policy = await createPolicy();
    const result = await normalizeLintResponse(
      reply(policy, {
        fileResults: [fileResult("a.ts", "failed", "Stopped before finishing"), fileResult("b.ts")],
        diagnostics: [diagnostic()],
      }),
      rules,
      policy,
    );

    expect(result.diagnostics).toHaveLength(1);
    expect(result.errors).toEqual([]);
    expect(result.summary.failedFiles).toBe(1);
  });

  test("attributes invalid diagnostics to their targets", async () => {
    const policy = await createPolicy();
    const finding = diagnostic();
    finding.locations[0]!.column = 999;
    const result = await normalizeLintResponse(
      reply(policy, {
        diagnostics: [finding, diagnostic("b.ts")],
      }),
      rules,
      policy,
    );

    expect(result.fileResults.map(({ status }) => status)).toEqual(["failed", "completed"]);
    expect(result.errors).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(1);
  });

  test("treats an invalid finding without a target as an unscoped failure", async () => {
    const policy = await createPolicy();
    const result = await normalizeLintResponse(
      reply(policy, { diagnostics: [{ ...diagnostic(), locations: [] }] }),
      rules,
      policy,
    );

    expect(result.summary.failedFiles).toBe(2);
    expect(result.errors).toHaveLength(1);
  });

  test("still rejects evidence through symbolic links", async () => {
    const policy = await createPolicy();
    await rm(join(policy.projectRoot, "a.ts"));
    await symlink(join(policy.projectRoot, "README.md"), join(policy.projectRoot, "a.ts"));
    const result = await normalizeLintResponse(
      reply(policy, { diagnostics: [diagnostic()] }),
      rules,
      policy,
    );

    expect(result.fileResults.map(({ status }) => status)).toEqual(["failed", "completed"]);
    expect(result.errors).toEqual([expect.objectContaining({ code: "INVALID_RESULT_PATH" })]);
  });

  test("preserves valid diagnostics but fails all targets when fileResults is missing", async () => {
    const policy = await createPolicy();
    const legacy = reply(policy, { diagnostics: [diagnostic()] });
    delete legacy.fileResults;
    const result = await normalizeLintResponse(legacy, rules, policy);

    expect(result.summary).toMatchObject({ totalFiles: 2, successFiles: 0, failedFiles: 2 });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.errors).toEqual([expect.objectContaining({ code: "INVALID_AI_RESPONSE" })]);
  });

  test.each([
    { input: null },
    { input: [] },
    { input: "not JSON" },
    { input: {} },
    { input: { unexpected: [] } },
  ])("fails every target for invalid response $input", async ({ input }) => {
    const policy = await createPolicy();
    const result = await normalizeLintResponse(input, rules, policy);

    expect(result.summary.failedFiles).toBe(2);
    expect(result.summary.successFiles).toBe(0);
    expect(result.errors).toEqual([expect.objectContaining({ code: "INVALID_AI_RESPONSE" })]);
  });

  test("global execution errors fail every target while preserving valid findings", async () => {
    const policy = await createPolicy();
    const result = await normalizeLintResponse(
      reply(policy, {
        completedRuleIds: [],
        diagnostics: [diagnostic()],
        errors: [
          { code: "READ_FAILED", message: "Unable to finish a rule", ruleIds: ["fixture/check"] },
        ],
      }),
      rules,
      policy,
    );

    expect(result.summary.failedFiles).toBe(2);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.errors).toEqual([
      { code: "READ_FAILED", message: "Unable to finish a rule", ruleIds: ["fixture/check"] },
    ]);
  });

  test.each([
    { completedRuleIds: [] },
    { completedRuleIds: ["fixture/check", "fixture/check"] },
    { completedRuleIds: ["other/check"] },
  ])(
    "does not trust file completion when rule completion is invalid: $completedRuleIds",
    async ({ completedRuleIds }) => {
      const policy = await createPolicy();
      const result = await normalizeLintResponse(
        reply(policy, { completedRuleIds }),
        rules,
        policy,
      );

      expect(result.summary.failedFiles).toBe(2);
      expect(result.errors.some(({ code }) => code === "INCOMPLETE_AI_RESPONSE")).toBe(true);
    },
  );

  test("distinguishes an unknown target total from a confirmed empty selection", () => {
    const empty = { fileResults: [], diagnostics: [] };
    expect(summarizeLintResult(empty, 0, null).totalFiles).toBeNull();
    expect(summarizeLintResult(empty, 0)).toEqual({
      totalFiles: 0,
      successFiles: 0,
      warningFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      activeRules: 0,
    });
  });
});
