import { describe, expect, test } from "vitest";
import { section21Rules } from "../src/lint/catalog/section-21";

// Tests validate published prompt contracts, not an AI evaluator or framework runtime.
describe("section 21 rule definitions", () => {
  test("preserves independent canonical IDs and their order", () => {
    expect(section21Rules.map((rule) => rule.id)).toEqual([
      "ui/separate-view-and-domain-policy",
      "ui/no-side-effects-during-render",
      "ui/single-owner-for-shared-ui-state",
      "ui/separate-server-and-local-state",
      "ui/explicit-loading-empty-error-states",
      "ui/no-stale-closure-behavior",
      "ui/complete-effect-dependencies",
      "ui/cleanup-owned-effects",
      "ui/stable-semantic-item-identity",
      "ui/reconcile-optimistic-updates",
      "ui/consistent-form-validation",
      "ui/keyboard-equivalent-actions",
      "ui/preserve-meaningful-focus",
      "ui/consistent-hydration-state",
      "ui/isolate-browser-server-execution"
]);
    expect(new Set(section21Rules.map((rule) => rule.id)).size).toBe(15);
  });

  test.each(section21Rules)("$id builds the supported instruction contract", async (rule) => {
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

  test.each(section21Rules)("$id returns isolated prompt data", async (rule) => {
    const first = await rule.buildPrompt({ options: {} });
    const original = structuredClone(first);
    first.evidenceRequirements.push("caller mutation");
    first.exceptions?.push("caller exception");
    if (first.examples?.[0]) first.examples[0].scenario = "caller scenario";
    expect(await rule.buildPrompt({ options: {} })).toEqual(original);
  });

  test.each([
    ["ui/no-side-effects-during-render", "exceptions", "freshly created local"],
    ["ui/no-side-effects-during-render", "criteria", "렌더 도중 호출한"],
    ["ui/single-owner-for-shared-ui-state", "exceptions", "one reducer"],
    ["ui/single-owner-for-shared-ui-state", "criteria", "같은 위반인 경우만"],
    ["ui/separate-server-and-local-state", "exceptions", "Local editable copies"],
    ["ui/separate-server-and-local-state", "criteria", "권한은 서버 하나여도"],
    ["ui/no-stale-closure-behavior", "exceptions", "action-time snapshots"],
    ["ui/complete-effect-dependencies", "exceptions", "stable values"],
    ["ui/cleanup-owned-effects", "exceptions", "ignoring stale results does not release"],
    ["ui/stable-semantic-item-identity", "exceptions", "explicit state-reset"],
    ["ui/consistent-form-validation", "exceptions", "Partial input"],
    ["ui/keyboard-equivalent-actions", "exceptions", "Native keyboard semantics"],
    ["ui/preserve-meaningful-focus", "exceptions", "toasts should not automatically take focus"],
    ["ui/consistent-hydration-state", "exceptions", "warning-suppression option is not proof"],
    ["ui/isolate-browser-server-execution", "criteria", "한 방향 노출"],
  ])("preserves %s %s guardrail: %s", async (id, field, fragment) => {
    const rule = section21Rules.find((candidate) => candidate.id === id)!;
    expect(rule).toBeDefined();
    const prompt = await rule.buildPrompt({ options: {} });
    const value = prompt[field as keyof typeof prompt];
    expect(typeof value === "string" ? value : JSON.stringify(value)).toContain(fragment);
  });
});
