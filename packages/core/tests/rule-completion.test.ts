import { describe, expect, test } from "vitest";
import { checkCompletion, references } from "../src/ai/results";
import type { RunError } from "../src/shared/types";

const known = new Set(["fixture/checked", "fixture/skipped", "fixture/failed"]);
const skippedRule = { ruleId: "fixture/skipped", reason: "No matching contract exists." };

describe("rule completion", () => {
  test("keeps a project failure without repeating every rule as an incomplete response", () => {
    const failure = { code: "READ_FAILED", message: "Cannot read the snapshot.", ruleIds: [] };
    const errors: RunError[] = [failure];

    expect(checkCompletion([], [], known, errors)).toEqual([]);
    expect(errors).toEqual([failure]);
  });

  test("accounts for completed, skipped, and failed rules separately", () => {
    const errors: RunError[] = [
      { code: "READ_FAILED", message: "Cannot read evidence.", ruleIds: ["fixture/failed"] },
    ];

    expect(checkCompletion(["fixture/checked"], [skippedRule], known, errors)).toEqual([
      skippedRule,
    ]);
    expect(errors).toEqual([
      { code: "READ_FAILED", message: "Cannot read evidence.", ruleIds: ["fixture/failed"] },
    ]);
  });

  test.each([
    { name: "missing reason", item: { ruleId: "fixture/skipped" } },
    { name: "blank reason", item: { ...skippedRule, reason: "  " } },
    { name: "unknown rule", item: { ...skippedRule, ruleId: "other/rule" } },
    { name: "extra property", item: { ...skippedRule, extra: true } },
    { name: "invalid item", item: null },
  ])("rejects a skipped rule with $name", ({ item }) => {
    const errors: RunError[] = [];
    const skipped = checkCompletion([], [item], new Set(["fixture/skipped"]), errors);

    expect(skipped).toEqual([]);
    expect(errors).not.toHaveLength(0);
    expect(errors).toContainEqual(
      expect.objectContaining({ code: "INCOMPLETE_AI_RESPONSE", ruleIds: ["fixture/skipped"] }),
    );
  });

  test("does not choose one of duplicate skipped reports", () => {
    const errors: RunError[] = [];
    const skipped = checkCompletion(
      [],
      [skippedRule, { ...skippedRule, reason: "A different explanation." }],
      new Set(["fixture/skipped"]),
      errors,
    );

    expect(skipped).toEqual([]);
    expect(errors).toContainEqual(expect.objectContaining({ code: "DUPLICATE_SKIPPED_RULE" }));
  });

  test.each(["completed", "failed"])("rejects a skipped rule also reported as %s", (status) => {
    const errors: RunError[] =
      status === "failed"
        ? [{ code: "READ_FAILED", message: "Cannot read.", ruleIds: ["fixture/skipped"] }]
        : [];
    const completed = status === "completed" ? ["fixture/skipped"] : [];

    const skipped = checkCompletion(completed, [skippedRule], new Set(["fixture/skipped"]), errors);

    expect(skipped).toEqual([]);
    expect(errors).toContainEqual(expect.objectContaining({ code: "CONFLICTING_RULE_RESULT" }));
  });

  test("rejects completed and failed overlap", () => {
    const errors: RunError[] = [
      { code: "READ_FAILED", message: "Cannot read.", ruleIds: ["fixture/failed"] },
    ];

    checkCompletion(["fixture/failed"], [], new Set(["fixture/failed"]), errors);

    expect(errors).toContainEqual(
      expect.objectContaining({ code: "CONFLICTING_RULE_RESULT", ruleIds: ["fixture/failed"] }),
    );
  });

  test("reports only unaccounted rules as missing", () => {
    const errors: RunError[] = [];

    checkCompletion(["fixture/checked"], [skippedRule], known, errors);

    expect(errors).toEqual([
      expect.objectContaining({ code: "INCOMPLETE_AI_RESPONSE", ruleIds: ["fixture/failed"] }),
    ]);
  });

  test.each([{ completed: ["fixture/checked", "fixture/checked"] }, { completed: ["other/rule"] }])(
    "rejects invalid completed IDs $completed",
    ({ completed }) => {
      const errors: RunError[] = [];

      checkCompletion(completed, [], new Set(["fixture/checked"]), errors);

      expect(errors).toContainEqual(expect.objectContaining({ code: "INVALID_RULE_REFERENCE" }));
      expect(errors).toContainEqual(expect.objectContaining({ code: "INCOMPLETE_AI_RESPONSE" }));
    },
  );

  test("rejects findings for skipped rules without rejecting other known rules", () => {
    const skipped = new Set(["fixture/skipped"]);

    expect(references(["fixture/checked"], known, false, skipped)).toEqual(["fixture/checked"]);
    expect(() => references(["fixture/skipped"], known, false, skipped)).toThrow(
      expect.objectContaining({ code: "CONFLICTING_RULE_RESULT" }),
    );
  });
});
