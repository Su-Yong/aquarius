import { describe, expect, test } from "vitest";
import type { JsonObject, LintInstructions } from "@aquarius/core";
import { prepareRules } from "../../core/src/rules/prepare";
import { lintInstructionsSchema, lintRuleSchema } from "../../core/src/rules/schemas";
import type { LoadedConfig } from "../../core/src/config/types";
import plugin from "../src/index";
import { allRulesPreset } from "../src/presets";
import { architectureRules } from "../src/lint/architecture";
import fixtures from "./fixtures/architecture.json";

const layerPolicy = {
  layers: { application: ["src/application/**"], domain: ["src/domain/**"] },
  allowedDependencies: { application: ["domain"], domain: [] },
};

describe("architecture catalog", () => {
  test("registers every section 1 ID once and preserves its source description", () => {
    expect(architectureRules.map((rule) => rule.id)).toEqual(fixtures.map((fixture) => fixture.id));
    for (const fixture of fixtures) {
      const matches = plugin.lintRules!.filter((rule) => rule.id === fixture.id);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.description).toBe(fixture.description);
    }
  });

  for (const fixture of fixtures) {
    test(`${fixture.id} builds valid independent instructions`, async () => {
      const rule = architectureRules.find((candidate) => candidate.id === fixture.id)!;
      expect(lintRuleSchema.safeParse(rule).success).toBe(true);
      const options: JsonObject =
        rule.id === "architecture/enforce-layer-direction" ? layerPolicy : {};
      const instructions = await rule.buildPrompt({ options: Object.freeze(options) });
      expect(lintInstructionsSchema.safeParse(instructions).success).toBe(true);
      expect(rule.scope).toBe("project");
      expect(allRulesPreset[`aquarius/${rule.id}`]).toBe("warn");
      expect(instructions.examples).toEqual(fixture.examples);
      expect(new Set(instructions.examples!.map((example) => example.expected))).toEqual(
        new Set(["violation", "pass", "not_applicable"]),
      );
      expect(instructions.exceptions!.length).toBeGreaterThan(0);
      expect(instructions.procedure).toContain(fixture.boundary);
      expect(instructions.procedure).toContain(fixture.overlap);
      if ("inspectionDetail" in fixture) {
        expect(instructions.evidenceRequirements).toContain(fixture.inspectionDetail!["필수 근거"]);
        expect(instructions.procedure).toContain(fixture.inspectionDetail!["중복 구별"]);
      }
      const baseline = structuredClone(instructions);
      instructions.evidenceRequirements.push("caller mutation");
      instructions.examples![0]!.scenario = "caller mutation";
      expect(await rule.buildPrompt({ options })).toEqual(baseline);
    });
  }

  test("prepares all architecture rules through the real engine contract", async () => {
    const selections = Object.fromEntries(
      fixtures.map(({ id }) => [`aquarius/${id}`, allRulesPreset[`aquarius/${id}`]]),
    );
    selections["aquarius/architecture/enforce-layer-direction"] = ["warn", layerPolicy];
    const result = await prepareRules(loaded(selections), {
      "builtin-architecture-test": plugin,
    });
    expect(result.errors).toEqual([]);
    expect(result.rules.map((rule) => rule.id)).toEqual(fixtures.map(({ id }) => `aquarius/${id}`));
    expect(result.rules.every((rule) => rule.scope === "project" && rule.severity === "warn")).toBe(
      true,
    );
  });

  test("registration alone leaves all provided rules inactive", async () => {
    const result = await prepareRules(loaded({}), { "builtin-architecture-test": plugin });
    expect(result).toEqual({ rules: [], errors: [] });
  });

  test("keeps overlapping rules independently selectable and respects severity", async () => {
    const selections: LoadedConfig["rules"] = {
      "aquarius/architecture/no-cross-domain-internals": "off",
      "aquarius/architecture/enforce-layer-direction": ["error", layerPolicy],
      "aquarius/architecture/use-public-entry":
        allRulesPreset["aquarius/architecture/use-public-entry"],
    };
    const result = await prepareRules(loaded(selections), {
      "builtin-architecture-test": plugin,
    });
    expect(result.errors).toEqual([]);
    expect(result.rules.map(({ id, severity }) => ({ id, severity }))).toEqual([
      { id: "aquarius/architecture/enforce-layer-direction", severity: "error" },
      { id: "aquarius/architecture/use-public-entry", severity: "warn" },
    ]);
  });

  test.each<JsonObject>([
    {},
    { layers: {}, allowedDependencies: {} },
    { layers: { application: [] }, allowedDependencies: { application: [] } },
    { layers: { application: ["../outside/**"] }, allowedDependencies: { application: [] } },
    { layers: { application: ["src/**"] }, allowedDependencies: {} },
    { layers: { application: ["src/**"] }, allowedDependencies: { application: ["missing"] } },
    { layers: { application: ["src/**"] }, allowedDependencies: { application: [], missing: [] } },
  ])("rejects missing or inconsistent layer configuration: %j", async (options) => {
    const result = await prepareRules(
      loaded({ "aquarius/architecture/enforce-layer-direction": ["warn", options] }),
      { "builtin-architecture-test": plugin },
    );
    expect(result.rules).toEqual([]);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "RULE_OPTIONS_INVALID",
        ruleIds: ["aquarius/architecture/enforce-layer-direction"],
      }),
    );
  });

  test("includes the configured layer map and directions in the rule instructions", async () => {
    const result = await prepareRules(
      loaded({ "aquarius/architecture/enforce-layer-direction": ["warn", layerPolicy] }),
      { "builtin-architecture-test": plugin },
    );
    expect(result.errors).toEqual([]);
    const instructions = JSON.stringify(result.rules[0]!.instructions);
    expect(instructions).toContain("src/application/**");
    expect(instructions).toContain("Allowed direct cross-layer dependencies");
    expect((result.rules[0]!.instructions as LintInstructions).procedure).toContain(
      `Allowed direct cross-layer dependencies: ${JSON.stringify(layerPolicy.allowedDependencies)}`,
    );
  });

  test("rejects undeclared policy options without hiding valid rules", async () => {
    const selections: LoadedConfig["rules"] = {
      "aquarius/architecture/enforce-layer-direction": ["warn", { inventedPolicy: true }],
      "aquarius/architecture/no-dependency-cycles": "warn",
    };
    const result = await prepareRules(loaded(selections), {
      "builtin-architecture-test": plugin,
    });
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "RULE_OPTIONS_INVALID",
        ruleIds: ["aquarius/architecture/enforce-layer-direction"],
      }),
    ]);
    expect(result.rules.map(({ id }) => id)).toEqual([
      "aquarius/architecture/no-dependency-cycles",
    ]);
  });
});

const loaded = (rules: LoadedConfig["rules"]): LoadedConfig => ({
  tool: "lint",
  cwd: process.cwd(),
  projectRoot: process.cwd(),
  configDirectory: process.cwd(),
  files: ["**/*"],
  ignore: [],
  plugins: ["builtin-architecture-test"],
  ai: { adapter: "codex", options: {}, timeoutMs: 600_000 },
  preset: [],
  rules,
});
