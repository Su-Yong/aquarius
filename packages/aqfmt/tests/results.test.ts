import { describe, expect, test } from "vitest";
import type { PathPolicy, PreparedRule, RuleResource } from "@aquarius/core/runtime";
import {
  createFormatValidator,
  formatChangePaths,
  normalizeFormatResponse,
  summarizeFormatResult,
} from "../src/format/results";

const rules: PreparedRule[] = [
  {
    id: "fixture/style",
    scope: "file",
    instructions: {
      applicability: "Conditional statements",
      transformation: "Use early returns where safe.",
      constraints: ["Preserve behavior."],
    },
  },
];

const policy: PathPolicy = {
  projectRoot: process.cwd(),
  targets: ["src/example.ts"],
  readableFiles: ["src/example.ts"],
  isIgnored: () => false,
  canWrite: () => true,
};

const resources: RuleResource[] = [
  {
    ruleId: "fixture/style",
    scope: "file",
    applicability: "Conditional statements",
    detailsPath: ".aquarius-rules-test/style.json",
    content: "{}",
    contentHash: "unused-for-result-validation",
  },
];

const change = {
  op: "replace",
  path: "src/example.ts",
  oldText: "before",
  newText: "after",
  ruleIds: ["fixture/style"],
};

const reply = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  completedRuleIds: ["fixture/style"],
  skippedRules: [],
  changes: [],
  warnings: [],
  errors: [],
  fileResults: [{ path: "src/example.ts", status: "completed", reason: "" }],
  ...overrides,
});

describe("format rule results", () => {
  test("preserves non-applicable rules without producing changes", () => {
    const skippedRules = [{ ruleId: "fixture/style", reason: "No conditional statements exist." }];
    const result = normalizeFormatResponse(
      reply({ completedRuleIds: [], skippedRules }),
      rules,
      policy,
      resources,
    );

    expect(result).toEqual({
      changes: [],
      warnings: [],
      errors: [],
      skippedRules,
      fileResults: [
        { path: "src/example.ts", status: "skipped", reason: "No requested rule applies." },
      ],
      retryable: false,
    });
  });

  test.each(["changes", "warnings"])("rejects %s for non-applicable rules", (field) => {
    const item =
      field === "changes"
        ? change
        : {
            code: "UNKNOWN_CONTRACT",
            ruleIds: ["fixture/style"],
            message: "Behavior preservation cannot be established.",
            paths: ["src/example.ts"],
          };
    const result = normalizeFormatResponse(
      reply({
        completedRuleIds: [],
        skippedRules: [{ ruleId: "fixture/style", reason: "No applicable statements exist." }],
        [field]: [item],
      }),
      rules,
      policy,
      resources,
    );

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({ code: "CONFLICTING_RULE_RESULT" })]);
  });

  test("blocks even otherwise valid changes when rule completion is contradictory", () => {
    const result = normalizeFormatResponse(
      reply({
        changes: [change],
        skippedRules: [{ ruleId: "fixture/style", reason: "No conditional statements exist." }],
      }),
      rules,
      policy,
      resources,
    );

    expect(result.changes).toEqual([]);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "CONFLICTING_RULE_RESULT" }),
    );
  });

  test("rejects a response missing skippedRules instead of adapting it", () => {
    const input = reply({ changes: [change] });
    delete input.skippedRules;

    const result = normalizeFormatResponse(input, rules, policy, resources);

    expect(result.changes).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({ code: "INVALID_AI_RESPONSE" })]);
    expect(result.skippedRules).toEqual([]);
  });

  test.each([
    { op: "replace", path: ".aquarius-rules-test/style.json", oldText: "before", newText: "after" },
    { op: "create", path: ".aquarius-rules-test/new.ts", content: "new content" },
    { op: "create", path: ".AQUARIUS-RULES-TEST/new.ts", content: "new content" },
    { op: "delete", path: ".aquarius-rules-test/style.json" },
    { op: "move", from: "src/example.ts", to: ".aquarius-rules-test/nested/new.ts" },
    { op: "move", from: "src/example.ts", to: ".AQUARIUS-RULES-TEST/nested/new.ts" },
    { op: "move", from: ".aquarius-rules-test/style.json", to: "src/new.ts" },
  ])("rejects internal resource paths in $op changes", (operation) => {
    const result = normalizeFormatResponse(
      reply({ changes: [{ ...operation, ruleIds: ["fixture/style"] }] }),
      rules,
      policy,
      resources,
    );

    expect(result.changes).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({ code: "CHANGE_OUTSIDE_SCOPE" })]);
  });

  test.each([
    ".aquarius-rules-test/nested/missing.json",
    ".AQUARIUS-RULES-TEST/nested/missing.json",
  ])("rejects warnings that reference internal resource descendant %s", (path) => {
    const result = normalizeFormatResponse(
      reply({
        warnings: [
          {
            code: "UNKNOWN_CONTRACT",
            ruleIds: ["fixture/style"],
            message: "Missing contract.",
            paths: [path],
          },
        ],
      }),
      rules,
      policy,
      resources,
    );

    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({ code: "INVALID_RESULT_PATH" })]);
  });

  test("does not reserve unrelated project directories based only on their prefix", () => {
    const result = normalizeFormatResponse(
      reply({
        changes: [
          {
            op: "create",
            path: ".aquarius-rules-project/file.ts",
            content: "source",
            ruleIds: ["fixture/style"],
          },
        ],
      }),
      rules.map((rule) => ({ ...rule, scope: "module" })),
      policy,
      resources,
    );

    expect(result.errors).toEqual([]);
    expect(result.changes).toHaveLength(1);
  });
});

describe("format file outcomes and partial results", () => {
  const paths = ["src/example.ts", "src/other.ts"];
  const twoFiles = { ...policy, targets: paths, readableFiles: paths };
  const completed = (path: string) => ({ path, status: "completed", reason: "" });
  const otherChange = { ...change, path: "src/other.ts" };
  const normalize = (overrides: Record<string, unknown> = {}) =>
    normalizeFormatResponse(
      reply({ fileResults: paths.map(completed), ...overrides }),
      rules,
      twoFiles,
      resources,
    );

  test("preserves eight valid outcomes and marks only two missing files incomplete", () => {
    const targets = Array.from({ length: 10 }, (_, index) => "src/file-" + index + ".ts");
    const result = normalizeFormatResponse(
      reply({ fileResults: targets.slice(0, 8).map(completed) }),
      rules,
      { ...policy, targets },
      resources,
    );

    expect(result.fileResults.filter(({ status }) => status === "completed")).toHaveLength(8);
    expect(result.fileResults.filter(({ status }) => status === "failed")).toHaveLength(2);
    expect(result.fileResults.map(({ path }) => path)).toEqual(targets);
    expect(result.errors.map(({ code }) => code)).toEqual([
      "INCOMPLETE_FILE_RESULTS",
      "INCOMPLETE_FILE_RESULTS",
    ]);
    expect(result.retryable).toBe(true);
    expect(summarizeFormatResult(result.fileResults, 1)).toEqual({
      totalFiles: 10,
      completedFiles: 8,
      skippedFiles: 0,
      failedFiles: 2,
      activeRules: 1,
    });
  });

  test.each([
    { path: paths[0], status: "unknown", reason: "" },
    { path: paths[0], status: "skipped", reason: "" },
    { path: paths[0], status: "failed", reason: " " },
  ])("keeps normal files when another status is malformed: %j", (invalid) => {
    const result = normalize({ fileResults: [invalid, completed(paths[1]!)] });

    expect(result.fileResults[0]).toMatchObject({ path: paths[0], status: "failed" });
    expect(result.fileResults[1]).toEqual(completed(paths[1]!));
    expect(result.errors).toHaveLength(1);
    expect(result.retryable).toBe(false);
  });

  test("a duplicate status fails only its file and cannot erase the first failure", () => {
    const result = normalize({
      fileResults: [completed(paths[0]!), completed(paths[1]!), completed(paths[0]!)],
    });

    expect(result.fileResults).toHaveLength(2);
    expect(result.fileResults[0]).toMatchObject({ status: "failed" });
    expect(result.fileResults[1]).toEqual(completed(paths[1]!));
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_FILE_RESULT" }),
    );
    expect(result.retryable).toBe(false);
  });

  test("a foreign file row does not enter the target universe or erase valid outcomes", () => {
    const result = normalize({ fileResults: [...paths.map(completed), completed("new/file.ts")] });

    expect(result.fileResults).toEqual(paths.map(completed));
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "INVALID_RESULT_PATH" }));
    expect(result.retryable).toBe(false);
  });

  test("old or malformed response envelopes fail every target without retry", () => {
    const raw = reply({ changes: [change] });
    delete raw.fileResults;
    const result = normalizeFormatResponse(raw, rules, twoFiles, resources);

    expect(result.fileResults.map(({ status }) => status)).toEqual(["failed", "failed"]);
    expect(result.errors).toEqual([expect.objectContaining({ code: "INVALID_AI_RESPONSE" })]);
    expect(result.retryable).toBe(false);
  });

  test("a failed status alone does not justify an automatic retry", () => {
    const result = normalize({
      fileResults: [
        { path: paths[0], status: "failed", reason: "Cannot read the source." },
        completed(paths[1]!),
      ],
    });

    expect(result.fileResults[0]).toMatchObject({ status: "failed" });
    expect(result.fileResults[1]).toEqual(completed(paths[1]!));
    expect(result.retryable).toBe(false);
  });

  test("an explicit unfinished file review preserves other results and is retryable", () => {
    const result = normalize({
      fileResults: [
        { path: paths[0], status: "failed", reason: "Review not finished." },
        completed(paths[1]!),
      ],
      errors: [{ code: "INCOMPLETE_FILE_REVIEW", message: "Review not finished.", ruleIds: [] }],
      changes: [otherChange],
    });

    expect(result.fileResults[1]).toEqual(completed(paths[1]!));
    expect(result.changes).toEqual([otherChange]);
    expect(result.retryable).toBe(true);
  });

  test("an unfinished rule cannot be hidden by completed file statuses", () => {
    const result = normalize({ completedRuleIds: [] });

    expect(result.fileResults.every(({ status }) => status === "failed")).toBe(true);
    expect(result.errors).toEqual([expect.objectContaining({ code: "INCOMPLETE_AI_RESPONSE" })]);
    expect(result.retryable).toBe(true);
  });

  test("an explicit unfinished rule explains failed files and permits one retry", () => {
    const result = normalize({
      completedRuleIds: [],
      fileResults: paths.map((path) => ({
        path,
        status: "failed",
        reason: "Rule review unfinished.",
      })),
      errors: [
        {
          code: "INCOMPLETE_AI_RESPONSE",
          message: "Rule review unfinished.",
          ruleIds: ["fixture/style"],
        },
      ],
    });

    expect(result.errors).toHaveLength(1);
    expect(result.fileResults.every(({ status }) => status === "failed")).toBe(true);
    expect(result.retryable).toBe(true);
  });

  test("an ordinary execution error disables retry but preserves valid proposals", () => {
    const result = normalize({
      changes: [change],
      fileResults: [completed(paths[0]!)],
      errors: [
        { code: "READ_FAILED", message: "Required context could not be read.", ruleIds: [] },
      ],
    });

    expect(result.errors.some(({ code }) => code === "INCOMPLETE_FILE_RESULTS")).toBe(true);
    expect(result.changes).toEqual([change]);
    expect(result.retryable).toBe(false);
  });

  test("invalid changes affect their own file while independent valid proposals survive", () => {
    const result = normalize({
      changes: [{ ...change, oldText: 42 }, otherChange],
    });

    expect(result.changes).toEqual([otherChange]);
    expect(result.fileResults[0]).toMatchObject({ status: "failed" });
    expect(result.fileResults[1]).toEqual(completed(paths[1]!));
    expect(result.retryable).toBe(false);
  });

  test("changes to skipped files are rejected without discarding independent changes", () => {
    const result = normalize({
      fileResults: [
        { path: paths[0], status: "skipped", reason: "No applicable code." },
        completed(paths[1]!),
      ],
      changes: [change, otherChange],
    });

    expect(result.changes).toEqual([otherChange]);
    expect(result.fileResults[0]).toMatchObject({ status: "failed" });
    expect(result.fileResults[1]).toEqual(completed(paths[1]!));
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "CONFLICTING_FILE_RESULT" }),
    );
  });

  test("a warning may reference a skipped target used as context", () => {
    const warning = {
      code: "CONTEXT",
      ruleIds: ["fixture/style"],
      message: "Related context.",
      paths: [paths[0]],
    };
    const result = normalize({
      fileResults: [
        { path: paths[0], status: "skipped", reason: "No applicable code." },
        completed(paths[1]!),
      ],
      warnings: [warning],
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([warning]);
    expect(result.fileResults[0]).toMatchObject({ status: "skipped" });
  });
});

describe("format scope helpers", () => {
  test.each([
    { op: "create", path: "src/new.ts", content: "new" },
    { op: "delete", path: "src/example.ts" },
    { op: "move", from: "src/example.ts", to: "src/new.ts" },
  ])("rejects $op even in a one-file request", (operation) => {
    const validator = createFormatValidator(rules, policy, resources);
    expect(() => validator.change({ ...operation, ruleIds: ["fixture/style"] })).toThrow(
      expect.objectContaining({ code: "CHANGE_OUTSIDE_SCOPE" }),
    );
  });

  test("rejects another group's existing file even when the shared policy permits it", () => {
    const validator = createFormatValidator(rules, policy, resources);
    expect(() => validator.change({ ...change, path: "src/other.ts" })).toThrow(
      expect.objectContaining({ code: "CHANGE_OUTSIDE_SCOPE" }),
    );
    expect(() => validator.proposedPath("src/other.ts")).toThrow();
  });

  test("module requests allow new paths but retain the original file-result universe", () => {
    const moduleRules: PreparedRule[] = rules.map((rule) => ({ ...rule, scope: "module" }));
    const move = {
      op: "move" as const,
      from: "src/example.ts",
      to: "src/moved.ts",
      ruleIds: ["fixture/style"],
    };
    const create = {
      op: "create" as const,
      path: "src/new.ts",
      content: "new",
      ruleIds: ["fixture/style"],
    };
    const result = normalizeFormatResponse(
      reply({ changes: [move, create] }),
      moduleRules,
      policy,
      resources,
    );

    expect(result.errors).toEqual([]);
    expect(result.fileResults.map(({ path }) => path)).toEqual(["src/example.ts"]);
    expect(formatChangePaths([move, create, create])).toEqual([
      "src/example.ts",
      "src/moved.ts",
      "src/new.ts",
    ]);
    expect(summarizeFormatResult(result.fileResults, 1).totalFiles).toBe(1);
  });

  test("distinguishes an unknown target total from a confirmed empty selection", () => {
    expect(summarizeFormatResult([], 0, null).totalFiles).toBeNull();
    expect(summarizeFormatResult([], 0).totalFiles).toBe(0);
  });
});
