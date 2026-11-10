import { describe, expect, test } from "vitest";
import { allRulesPreset } from "../src/presets";
import { section23Rules } from "../src/lint/catalog/section-23";

// Tests validate published prompt contracts, not an AI evaluator or framework runtime.
describe("section 23 rule definitions", () => {
  test("preserves independent canonical IDs and their order", () => {
    expect(section23Rules.map((rule) => rule.id)).toEqual([
      "config/validate-at-startup",
      "config/explicit-required-values",
      "config/typed-config-boundary",
      "config/no-scattered-environment-reads",
      "config/safe-production-defaults",
      "config/separate-secrets",
      "config/explicit-precedence",
      "config/traceable-feature-decisions",
      "config/remove-expired-flags",
      "config/test-supported-flag-combinations",
      "config/rolling-update-compatibility",
      "config/reversible-release-changes",
      "config/readiness-after-initialization",
      "config/distinguish-liveness-readiness",
      "config/no-environment-name-business-policy",
    ]);
    expect(new Set(section23Rules.map((rule) => rule.id)).size).toBe(15);
  });

  test.each(section23Rules)("$id builds the supported instruction contract", async (rule) => {
    const prompt = await rule.buildPrompt({ options: {} });
    expect(["file", "module", "project"]).toContain(rule.scope);
    expect(allRulesPreset[`aquarius/${rule.id}`]).toBe("warn");
    expect(Object.keys(prompt).sort()).toEqual(
      [
        "applicability",
        "criteria",
        "evidenceRequirements",
        "examples",
        "exceptions",
        "procedure",
      ].sort(),
    );
    expect(prompt.applicability.trim()).not.toBe("");
    expect(prompt.criteria).toContain(rule.description);
    expect(prompt.evidenceRequirements.length).toBeGreaterThanOrEqual(2);
    expect(prompt.exceptions?.length).toBeGreaterThan(0);
    expect(prompt.procedure?.join(" ")).toContain("finish with no established violation");
    expect(prompt.procedure?.join(" ")).toContain("not authority to execute code");
    expect(prompt.examples?.map((example) => example.expected)).not.toContain("unknown");
    expect(prompt.examples?.some((example) => example.expected === "pass")).toBe(true);
    for (const example of prompt.examples ?? []) {
      expect(["pass", "violation", "not_applicable"]).toContain(example.expected);
      expect(example.scenario.trim()).not.toBe("");
      expect(example.reason.trim()).not.toBe("");
    }
  });

  test.each(section23Rules)("$id returns isolated prompt data", async (rule) => {
    const first = await rule.buildPrompt({ options: {} });
    const original = structuredClone(first);
    first.evidenceRequirements.push("caller mutation");
    first.exceptions?.push("caller exception");
    if (first.examples?.[0]) first.examples[0].scenario = "caller scenario";
    expect(await rule.buildPrompt({ options: {} })).toEqual(original);
  });

  test.each([
    ["config/validate-at-startup", "exceptions", "own activation boundaries"],
    ["config/validate-at-startup", "criteria", "부분 config"],
    ["config/explicit-required-values", "criteria", "startup 성공이 이후"],
    ["config/typed-config-boundary", "exceptions", "cast alone is not runtime validation"],
    [
      "config/no-scattered-environment-reads",
      "exceptions",
      "dynamic config need not become a singleton snapshot",
    ],
    ["config/safe-production-defaults", "criteria", "fail-open 경로를 숨기지"],
    ["config/separate-secrets", "exceptions", "shared typed configuration"],
    ["config/explicit-precedence", "evidenceRequirements", "presence-versus-falsy"],
    ["config/traceable-feature-decisions", "criteria", "무제한 수집하지"],
    ["config/remove-expired-flags", "exceptions", "kill switches"],
    [
      "config/test-supported-flag-combinations",
      "exceptions",
      "exhaustive 2^n tests are not inferred",
    ],
    ["config/test-supported-flag-combinations", "criteria", "미검증 조합을 숨기지"],
    ["config/rolling-update-compatibility", "exceptions", "atomic single-version"],
    ["config/reversible-release-changes", "exceptions", "forward-fix"],
    ["config/distinguish-liveness-readiness", "exceptions", "One low-cost function or endpoint"],
    [
      "config/no-environment-name-business-policy",
      "exceptions",
      "staging transmission restrictions",
    ],
  ])("preserves %s %s guardrail: %s", async (id, field, fragment) => {
    const rule = section23Rules.find((candidate) => candidate.id === id)!;
    expect(rule).toBeDefined();
    const prompt = await rule.buildPrompt({ options: {} });
    const value = prompt[field as keyof typeof prompt];
    expect(typeof value === "string" ? value : JSON.stringify(value)).toContain(fragment);
  });
});
