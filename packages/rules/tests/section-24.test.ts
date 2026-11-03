import { describe, expect, test } from "vitest";
import { section24Rules } from "../src/lint/catalog/section-24";

// Tests validate published prompt contracts, not an AI evaluator or framework runtime.
describe("section 24 rule definitions", () => {
  test("preserves independent canonical IDs and their order", () => {
    expect(section24Rules.map((rule) => rule.id)).toEqual([
      "observability/correlate-request-and-work",
      "observability/record-business-outcomes",
      "observability/preserve-async-context",
      "observability/bounded-metric-cardinality",
      "observability/separate-attempts-and-operations",
      "observability/no-premature-success-metrics",
      "observability/actionable-error-context",
      "observability/log-at-owning-boundary",
      "observability/separate-audit-debug-logs",
      "observability/bounded-log-volume",
      "observability/expose-queue-pool-pressure",
      "observability/surface-degraded-mode",
      "observability/account-for-partial-success",
      "observability/isolate-noncritical-telemetry-failures",
      "observability/consistent-duration-measurement"
]);
    expect(new Set(section24Rules.map((rule) => rule.id)).size).toBe(15);
  });

  test.each(section24Rules)("$id builds the supported instruction contract", async (rule) => {
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

  test.each(section24Rules)("$id returns isolated prompt data", async (rule) => {
    const first = await rule.buildPrompt({ options: {} });
    const original = structuredClone(first);
    first.evidenceRequirements.push("caller mutation");
    first.exceptions?.push("caller exception");
    if (first.examples?.[0]) first.examples[0].scenario = "caller scenario";
    expect(await rule.buildPrompt({ options: {} })).toEqual(original);
  });

  test.each([
    ["observability/correlate-request-and-work", "exceptions", "fan-in links"],
    ["observability/record-business-outcomes", "exceptions", "Central events"],
    ["observability/record-business-outcomes", "criteria", "technical request 성공"],
    ["observability/preserve-async-context", "criteria", "does not by itself prove context propagation to a worker"],
    ["observability/bounded-metric-cardinality", "exceptions", "no arbitrary universal"],
    ["observability/separate-attempts-and-operations", "exceptions", "does not require adding both"],
    ["observability/no-premature-success-metrics", "exceptions", "Acceptance/queueing success"],
    ["observability/actionable-error-context", "exceptions", "Error.cause"],
    ["observability/log-at-owning-boundary", "exceptions", "distinct purposes"],
    ["observability/separate-audit-debug-logs", "exceptions", "one physical store"],
    ["observability/bounded-log-volume", "exceptions", "mandatory audit records cannot be"],
    ["observability/expose-queue-pool-pressure", "exceptions", "Platform-provided"],
    ["observability/account-for-partial-success", "criteria", "모두 미실행으로 평탄화하지"],
    ["observability/isolate-noncritical-telemetry-failures", "exceptions", "Mandatory audit"],
    ["observability/consistent-duration-measurement", "exceptions", "business timestamps"],
  ])("preserves %s %s guardrail: %s", async (id, field, fragment) => {
    const rule = section24Rules.find((candidate) => candidate.id === id)!;
    expect(rule).toBeDefined();
    const prompt = await rule.buildPrompt({ options: {} });
    const value = prompt[field as keyof typeof prompt];
    expect(typeof value === "string" ? value : JSON.stringify(value)).toContain(fragment);
  });
});
