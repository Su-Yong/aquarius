import { describe, expect, test } from "vitest";
import { section26Principles } from "../src/lint/catalog/section-26";

describe("section 26 analyzer principles", () => {
  test("preserves all 20 canonical IDs independently of user-code lint rules", () => {
    expect(section26Principles.map((principle) => principle.id)).toEqual([
      "agentlint/require-evidence",
      "agentlint/identify-contract-sources",
      "agentlint/require-behavioral-counterexample",
      "agentlint/abstain-on-insufficient-context",
      "agentlint/no-size-only-design-judgment",
      "agentlint/honor-project-architecture",
      "agentlint/separate-defect-from-preference",
      "agentlint/deduplicate-overlapping-findings",
      "agentlint/show-cross-file-evidence",
      "agentlint/consistent-rule-application",
      "agentlint/actionable-remediation",
      "agentlint/respect-scoped-suppressions",
      "agentlint/preserve-behavior-on-refactor",
      "agentlint/separate-refactor-and-behavior-change",
      "agentlint/no-unrequested-dependency-additions",
      "agentlint/minimal-scope-fixes",
      "agentlint/no-test-weakening",
      "agentlint/validate-available-checks",
      "agentlint/report-unperformed-validation",
      "agentlint/preserve-user-changes"
]);
    expect(new Set(section26Principles.map((principle) => principle.id)).size).toBe(20);
  });

  test.each(section26Principles)("$id explicitly remains documentation, not enforcement", (principle) => {
    expect(principle.kind).toBe("analyzer-principle");
    expect(principle.implementationStatus).toBe("documentation-only");
    expect(principle.description.trim()).not.toBe("");
    expect(principle.review.trim()).not.toBe("");
    expect(principle.inspectionConditions.length).toBeGreaterThan(0);
    expect(principle).not.toHaveProperty("buildPrompt");
    expect(principle).not.toHaveProperty("scope");
    expect(principle).not.toHaveProperty("defaultSeverity");
  });

  test("preserves the contract-evidence and execution-authority boundary", () => {
    const principle = section26Principles.find((candidate) => candidate.id === "agentlint/identify-contract-sources")!;
    expect(principle.description).toContain("권한을 구분");
    expect(principle.description).toContain("자동 승격하지");
  });

  test("does not equate a passing check with behavioral equivalence", () => {
    const principle = section26Principles.find((candidate) => candidate.id === "agentlint/preserve-behavior-on-refactor")!;
    expect(principle.review).toContain("테스트 통과만으로 동등성을 단정하지");
  });
});
