import { describe, expect, test } from "vitest";
import { section25Rules } from "../src/lint/catalog/section-25";

// Tests validate published prompt contracts, not an AI evaluator or framework runtime.
describe("section 25 rule definitions", () => {
  test("preserves independent canonical IDs and their order", () => {
    expect(section25Rules.map((rule) => rule.id)).toEqual([
      "performance/evidence-based-optimization",
      "performance/bound-input-dependent-work",
      "performance/no-repeated-linear-lookups",
      "performance/hoist-invariant-computation",
      "performance/minimize-critical-path-work",
      "performance/no-redundant-serialization",
      "performance/bounded-memory-accumulation",
      "performance/no-large-object-retention",
      "performance/no-unnecessary-full-copy",
      "performance/memoize-stable-computations",
      "performance/match-data-structure-to-access",
      "performance/avoid-unrelated-ui-recomputation",
      "performance/bounded-recursion",
      "performance/no-busy-waiting",
      "performance/preserve-semantics-under-optimization"
]);
    expect(new Set(section25Rules.map((rule) => rule.id)).size).toBe(15);
  });

  test.each(section25Rules)("$id builds the supported instruction contract", async (rule) => {
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

  test.each(section25Rules)("$id returns isolated prompt data", async (rule) => {
    const first = await rule.buildPrompt({ options: {} });
    const original = structuredClone(first);
    first.evidenceRequirements.push("caller mutation");
    first.exceptions?.push("caller exception");
    if (first.examples?.[0]) first.examples[0].scenario = "caller scenario";
    expect(await rule.buildPrompt({ options: {} })).toEqual(original);
  });

  test.each([
    ["performance/evidence-based-optimization", "exceptions", "missing benchmark alone is not a defect"],
    ["performance/bound-input-dependent-work", "criteria", "수치 예산이 미정이라고"],
    ["performance/no-repeated-linear-lookups", "exceptions", "NaN, identity, duplicates"],
    ["performance/hoist-invariant-computation", "evidenceRequirements", "zero-iteration"],
    ["performance/minimize-critical-path-work", "exceptions", "fire-and-forget is not automatically safe"],
    ["performance/no-redundant-serialization", "exceptions", "structuredClone is not equivalent"],
    ["performance/bounded-memory-accumulation", "criteria", "유한하지만 과도한 peak"],
    ["performance/no-large-object-retention", "exceptions", "closure alone is not proof"],
    ["performance/no-unnecessary-full-copy", "exceptions", "immutable snapshots"],
    ["performance/memoize-stable-computations", "exceptions", "Pure calculations do not have to be memoized"],
    ["performance/memoize-stable-computations", "evidenceRequirements", "fresh-allocation"],
    ["performance/match-data-structure-to-access", "criteria", "기본 경고는 보류"],
    ["performance/avoid-unrelated-ui-recomputation", "exceptions", "compiler may already optimize"],
    ["performance/bounded-recursion", "exceptions", "independent selection"],
    ["performance/no-busy-waiting", "exceptions", "awaiting only microtasks"],
    ["performance/preserve-semantics-under-optimization", "exceptions", "intentional behavior changes"],
  ])("preserves %s %s guardrail: %s", async (id, field, fragment) => {
    const rule = section25Rules.find((candidate) => candidate.id === id)!;
    expect(rule).toBeDefined();
    const prompt = await rule.buildPrompt({ options: {} });
    const value = prompt[field as keyof typeof prompt];
    expect(typeof value === "string" ? value : JSON.stringify(value)).toContain(fragment);
  });

  test("does not recast optional optimization review as a confirmed defect", async () => {
    const rule = section25Rules.find((candidate) => candidate.id === "performance/evidence-based-optimization")!;
    const prompt = await rule.buildPrompt({ options: {} });
    expect(prompt.examples?.[0]?.expected).toBe("unknown");
    expect(prompt.examples?.[0]?.reason).toContain("optional design review");
  });
});
