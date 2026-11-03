import { describe, expect, test } from "vitest";
import { section22Rules } from "../src/lint/catalog/section-22";
import { section22Guidance } from "../src/lint/catalog/section-22-guidance";

// Tests validate published prompt contracts, not an AI evaluator or framework runtime.
describe("section 22 rule definitions", () => {
  test("preserves independent canonical IDs and their order", () => {
    expect(section22Rules.map((rule) => rule.id)).toEqual([
      "test/assert-public-behavior",
      "test/assert-meaningful-outcomes",
      "test/independent-fixtures",
      "test/control-time-and-randomness",
      "test/no-unintended-external-io",
      "test/shared-contract-tests",
      "test/cover-failure-and-recovery",
      "test/cover-boundaries-and-invalid-states",
      "test/cover-concurrency-invariants",
      "test/do-not-mock-away-integration-risk",
      "test/no-test-only-production-branches",
      "test/no-fragile-internal-assertions",
      "test/meaningful-snapshot-scope",
      "test/regression-for-fixed-defects"
]);
    expect(new Set(section22Rules.map((rule) => rule.id)).size).toBe(14);
  });

  test.each(section22Rules)("$id builds the supported instruction contract", async (rule) => {
    const prompt = await rule.buildPrompt({ options: {} });
    expect(["file", "module", "project"]).toContain(rule.scope);
    expect(rule.defaultSeverity).toBe("warn");
    expect(Object.keys(prompt).sort()).toEqual([
      "applicability", "criteria", "evidenceRequirements", "examples", "exceptions", "procedure",
    ].sort());
    expect(prompt.applicability.trim()).not.toBe("");
    expect(prompt.criteria).toContain(rule.description);
    expect(prompt.evidenceRequirements.length).toBeGreaterThanOrEqual(2);
    expect(prompt.exceptions?.length).toBeGreaterThan(0);
    expect(prompt.procedure?.join(" ")).toContain("Missing context must remain unknown");
    expect(prompt.procedure?.join(" ")).toContain("not authority to execute code");
    expect(prompt.examples?.some((example) => example.expected === "unknown")).toBe(true);
    expect(prompt.examples?.some((example) => example.expected === "pass")).toBe(true);
    for (const example of prompt.examples ?? []) {
      expect(["pass", "violation", "unknown", "not_applicable"]).toContain(example.expected);
      expect(example.scenario.trim()).not.toBe("");
      expect(example.reason.trim()).not.toBe("");
    }
  });

  test.each(section22Rules)("$id returns isolated prompt data", async (rule) => {
    const first = await rule.buildPrompt({ options: {} });
    const original = structuredClone(first);
    first.evidenceRequirements.push("caller mutation");
    first.exceptions?.push("caller exception");
    if (first.examples?.[0]) first.examples[0].scenario = "caller scenario";
    expect(await rule.buildPrompt({ options: {} })).toEqual(original);
  });

  test.each([
    ["test/assert-public-behavior", "exceptions", "internal protocols"],
    ["test/assert-public-behavior", "criteria", "포함 관계가 아니다"],
    ["test/assert-meaningful-outcomes", "exceptions", "no-exception"],
    ["test/assert-meaningful-outcomes", "criteria", "some runners fail the test or entire run"],
    ["test/independent-fixtures", "exceptions", "Immutable shared fixtures"],
    ["test/control-time-and-randomness", "exceptions", "recorded replayable seeds"],
    ["test/no-unintended-external-io", "evidenceRequirements", "without executing production I/O"],
    ["test/shared-contract-tests", "exceptions", "one shared test function is not required"],
    ["test/cover-failure-and-recovery", "exceptions", "not proof of absence"],
    ["test/cover-boundaries-and-invalid-states", "exceptions", "generative, model, schema"],
    ["test/cover-concurrency-invariants", "exceptions", "does not prove race freedom"],
    ["test/do-not-mock-away-integration-risk", "exceptions", "Unit tests may mock"],
    ["test/no-test-only-production-branches", "exceptions", "dependency injection"],
    ["test/no-fragile-internal-assertions", "exceptions", "protocol ordering"],
    ["test/meaningful-snapshot-scope", "exceptions", "size alone is never a violation"],
    ["test/regression-for-fixed-defects", "exceptions", "without a new test file"],
  ])("preserves %s %s guardrail: %s", async (id, field, fragment) => {
    const rule = section22Rules.find((candidate) => candidate.id === id)!;
    expect(rule).toBeDefined();
    const prompt = await rule.buildPrompt({ options: {} });
    const value = prompt[field as keyof typeof prompt];
    expect(typeof value === "string" ? value : JSON.stringify(value)).toContain(fragment);
  });

  test("retains PBT as guidance without an alias, severity or replacement", () => {
    expect(section22Rules.some((rule) => rule.id === "test/property-based-invariants-when-useful")).toBe(false);
    expect(section22Guidance).toHaveLength(1);
    expect(section22Guidance[0].id).toBe("test/property-based-invariants-when-useful");
    expect(section22Guidance[0].kind).toBe("guidance");
    expect(section22Guidance[0].replacementRuleId).toBeNull();
    expect(section22Guidance[0]).not.toHaveProperty("buildPrompt");
    expect(section22Guidance[0]).not.toHaveProperty("defaultSeverity");
    expect(section22Guidance[0].reason).toContain("does not migrate");
  });
});
