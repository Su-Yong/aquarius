import { describe, expect, test } from "vitest";
import type { JsonObject, LintRuleSetting } from "@aquarius/core";
import type { LoadedConfig } from "../../core/src/config/types";
import { prepareRules } from "../../core/src/rules/prepare";
import plugin from "../src/index";
import { allRulesPreset } from "../src/presets";

const layerPolicy = {
  layers: { application: ["src/application/**"], domain: ["src/domain/**"] },
  allowedDependencies: { application: ["domain"], domain: [] },
};

const presetOptions = (id: string): JsonObject => {
  if (id === "architecture/enforce-layer-direction") {
    return layerPolicy;
  }
  const setting = allRulesPreset[`aquarius/${id}`];
  if (Array.isArray(setting)) {
    return setting[1];
  }
  if (typeof setting === "object") {
    return setting;
  }
  return {};
};

describe("provided rules", () => {
  test("preserves existing rules and publishes the architecture catalog", async () => {
    expect(plugin.namespace).toBe("aquarius");
    expect(plugin.lintRules).toHaveLength(377);
    expect(plugin.formatRules).toHaveLength(3);
    const all = [...plugin.lintRules!, ...plugin.formatRules!];
    expect(new Set(all.map((rule) => rule.id)).size).toBe(380);
    for (const rule of plugin.lintRules!) {
      const instructions = await rule.buildPrompt({ options: presetOptions(rule.id) });
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

  test("ownership options change the intended exception without mutating the preset", async () => {
    const rule = plugin.lintRules![0]!;
    const disabled = await rule.buildPrompt({ options: { allowOwnershipTransfer: false } });
    const enabled = await rule.buildPrompt({ options: { allowOwnershipTransfer: true } });
    expect(disabled.exceptions).toEqual([]);
    expect(enabled.exceptions).toHaveLength(1);
    expect(presetOptions(rule.id)).toEqual({ allowOwnershipTransfer: false });
    expect(
      rule.optionsSchema?.safeParse({ allowOwnershipTransfer: false, unknown: true }).success,
    ).toBe(false);
  });

  test("keeps applicability brief enough for the rule index", async () => {
    const rules = [...plugin.lintRules!, ...plugin.formatRules!];

    for (const rule of rules) {
      const { applicability } = await rule.buildPrompt({ options: presetOptions(rule.id) });

      expect(applicability.trim(), rule.id).not.toBe("");
      expect(applicability, rule.id).not.toMatch(/[\r\n]/);
      expect(applicability.length, rule.id).toBeLessThanOrEqual(160);
    }
  });

  test("the all preset covers every definition with the previous levels and options", () => {
    const rules = [...plugin.lintRules!, ...plugin.formatRules!];
    expect(Object.keys(plugin.presets!)).toEqual(["all"]);
    expect(plugin.presets!.all).toBe(allRulesPreset);
    expect(Object.keys(allRulesPreset).sort()).toEqual(
      rules.map(({ id }) => `aquarius/${id}`).sort(),
    );
    const configurableRules: Record<string, LintRuleSetting> = {
      "aquarius/contracts/no-input-mutation": ["error", { allowOwnershipTransfer: false }],
      "aquarius/architecture/use-public-entry": ["warn", { allowDocumentedException: false }],
      "aquarius/resource/release-on-exit": ["error", { allowOwnershipTransfer: false }],
    };

    for (const rule of rules) {
      expect(rule).not.toHaveProperty("defaultSeverity");
      expect(rule).not.toHaveProperty("defaultOptions");
    }
    for (const rule of plugin.lintRules!) {
      const id = `aquarius/${rule.id}`;
      if (Object.hasOwn(configurableRules, id)) {
        expect(allRulesPreset[id]).toEqual(configurableRules[id]);
      } else {
        expect(allRulesPreset[id]).toBe("warn");
      }
    }
    for (const rule of plugin.formatRules!) {
      expect(allRulesPreset[`aquarius/${rule.id}`]).toBe(true);
    }
  });

  test.each(["lint", "format"] as const)(
    "applies the all preset through the real %s preparation path",
    async (tool) => {
      const config: LoadedConfig = {
        tool,
        cwd: process.cwd(),
        projectRoot: process.cwd(),
        configDirectory: process.cwd(),
        files: [],
        ignore: [],
        plugins: ["provided-rules-test"],
        preset: ["aquarius/all"],
        rules: { "aquarius/architecture/enforce-layer-direction": ["warn", layerPolicy] },
        ai: { options: {}, timeoutMs: 1_000 },
      };
      const result = await prepareRules(config, { "provided-rules-test": plugin });
      const definitions = tool === "lint" ? plugin.lintRules! : plugin.formatRules!;
      expect(result.errors).toEqual([]);
      expect(result.rules.map(({ id }) => id)).toEqual(
        definitions.map(({ id }) => `aquarius/${id}`),
      );
      for (const rule of result.rules) {
        const setting = allRulesPreset[rule.id];
        const severity =
          tool === "lint" ? (Array.isArray(setting) ? setting[0] : setting) : undefined;
        expect(rule.severity).toBe(severity);
      }
    },
  );
});
