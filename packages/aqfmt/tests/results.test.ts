import { describe, expect, test } from "vitest";
import type { PathPolicy, PreparedRule, RuleResources } from "@aquarius/core/internal";
import { normalizeFormatResponse } from "../src/format/results";

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
  ignoreRules: [],
  isIgnored: () => false,
  canWrite: () => true,
};

const resources: RuleResources = {
  directory: "/unused-rule-resource-source",
  files: [
    {
      ruleId: "fixture/style",
      scope: "file",
      applicability: "Conditional statements",
      detailsPath: ".aquarius-rules-test/style.json",
      contentHash: "unused-for-result-validation",
    },
  ],
};

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

    expect(result).toEqual({ changes: [], warnings: [], errors: [], skippedRules });
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
      rules,
      policy,
      resources,
    );

    expect(result.errors).toEqual([]);
    expect(result.changes).toHaveLength(1);
  });
});
