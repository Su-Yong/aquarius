import { describe, expect, test } from "vitest";
import plugin from "../src/index";

describe("provided rules", () => {
  test("publishes three independent lint rules and three behavior-preserving format rules", async () => {
    expect(plugin.namespace).toBe("aquarius");
    expect(plugin.lintRules).toHaveLength(3);
    expect(plugin.formatRules).toHaveLength(3);
    const all = [...plugin.lintRules!, ...plugin.formatRules!];
    expect(new Set(all.map((rule) => rule.id)).size).toBe(6);
    for (const rule of plugin.lintRules!) {
      const instructions = await rule.buildPrompt({ options: rule.defaultOptions ?? {} });
      expect(instructions.applicability).not.toBe("");
      expect(instructions.criteria).not.toBe("");
      expect(instructions.evidenceRequirements.length).toBeGreaterThan(0);
    }
    for (const rule of plugin.formatRules!) {
      const instructions = await rule.buildPrompt({ options: {} });
      expect(instructions.transformation).not.toBe("");
      expect(instructions.constraints.join(" ")).toMatch(/preserve/i);
    }
  });

  test("ownership options change the intended exception without mutating defaults", async () => {
    const rule = plugin.lintRules![0]!;
    const disabled = await rule.buildPrompt({ options: { allowOwnershipTransfer: false } });
    const enabled = await rule.buildPrompt({ options: { allowOwnershipTransfer: true } });
    expect(disabled.exceptions).toEqual([]);
    expect(enabled.exceptions).toHaveLength(1);
    expect(rule.defaultOptions).toEqual({ allowOwnershipTransfer: false });
    expect(rule.optionsSchema?.safeParse({ allowOwnershipTransfer: false, unknown: true }).success).toBe(false);
  });
});

