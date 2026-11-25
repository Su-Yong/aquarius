import aquariusRules from "@aqtools/rules";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { normalizeConfig } from "../src/config/load";
import { compressPresets } from "../src/extract/presets";
import { prepareRules } from "../src/rules/prepare";
import type { LintRule, RulePlugin, RuleSettings } from "../src/rules/types";
import type { JsonObject, ToolKind } from "../src/shared/types";

describe("config extraction preset compression", () => {
  test.each([
    ["default comment policy", true, {}],
    [
      "partial comment policy",
      { redundantComments: "keep" },
      { "aquarius/comments/enforce-policy": { redundantComments: "keep" } },
    ],
  ] as const)("uses format-recommended for %s", async (_label, setting, overrides) => {
    const rules: RuleSettings = {
      ...aquariusRules.presets!["format-recommended"],
      "aquarius/comments/enforce-policy": setting,
    };
    const fixture = context("format", aquariusRules);

    const result = await compressPresets({ ...fixture, rules });
    expect(result).toEqual({ preset: ["aquarius/format-recommended"], rules: overrides });
    await expectSamePreparedRules(fixture, rules, result);
  });

  test("uses format-safe only when omitted options preserve its comment policy", async () => {
    const rules: RuleSettings = {
      ...aquariusRules.presets!["format-safe"],
      "aquarius/comments/enforce-policy": { commentedCode: "keep", docs: { mode: "keep" } },
    };
    const fixture = context("format", aquariusRules);
    const compatible = await compressPresets({ ...fixture, rules });
    expect(compatible).toEqual({ preset: ["aquarius/format-safe"], rules: {} });
    await expectSamePreparedRules(fixture, rules, compatible);

    rules["aquarius/comments/enforce-policy"] = true;
    const incompatible = await compressPresets({ ...fixture, rules });
    expect(incompatible).toEqual({ preset: [], rules });
    await expectSamePreparedRules(fixture, rules, incompatible);
  });

  test("uses format-recommended with small overrides and keeps uncertain preset defaults", async () => {
    const uncertain = "aquarius/structure/order-sections";
    const disabled = "aquarius/control-flow/error-scope";
    const comments = "aquarius/comments/enforce-policy";
    const rules: RuleSettings = { ...aquariusRules.presets!["format-recommended"] };
    delete rules[uncertain];
    rules[disabled] = false;
    rules[comments] = {
      ...(rules[comments] as JsonObject),
      redundantComments: "keep",
    };

    const fixture = context("format", aquariusRules);
    const result = await compressPresets({
      ...fixture,
      insufficient: new Set([uncertain]),
      rules,
    });
    expect(result).toEqual({
      preset: ["aquarius/format-recommended"],
      rules: { [disabled]: false, [comments]: rules[comments] },
    });

    const direct = await prepareRules({ ...fixture.config, rules }, fixture.plugins);
    const prepared = await prepareRules({ ...fixture.config, ...result }, fixture.plugins);
    expect(direct.errors).toEqual([]);
    expect(prepared.errors).toEqual([]);
    expect(prepared.rules.some(({ id }) => id === uncertain)).toBe(true);
    expect(byId(prepared.rules.filter(({ id }) => id !== uncertain))).toEqual(byId(direct.rules));
  });

  test("does not use the all preset for a sparse lint result", async () => {
    const rules = {
      "aquarius/architecture/no-dependency-cycles": "warn",
      "aquarius/state/single-owner-for-shared-state": "error",
    } satisfies RuleSettings;
    await expect(
      compressPresets({
        ...context("lint", aquariusRules),
        rules,
      }),
    ).resolves.toEqual({ preset: [], rules });
  });

  test("considers preset order when preserving rule severity", async () => {
    const rules: RuleSettings = Object.fromEntries(
      ["shared", "left1", "left2", "left3", "right1", "right2", "right3"].map((id) => [
        `demo/${id}`,
        "warn",
      ]),
    );
    const left = selectRules(rules, "shared", "left1", "left2", "left3");
    const right = selectRules(rules, "right1", "right2", "right3");
    const fixture = context("lint", {
      namespace: "demo",
      lintRules: Object.keys(rules).map((id) => lintRule(id.slice("demo/".length))),
      presets: {
        a: left,
        z: { "demo/shared": "error", ...right },
      },
    });
    const result = await compressPresets({ ...fixture, rules });
    expect(result).toEqual({ preset: ["demo/z", "demo/a"], rules: {} });
    expect(
      byId((await prepareRules({ ...fixture.config, ...result }, fixture.plugins)).rules),
    ).toEqual(byId((await prepareRules({ ...fixture.config, rules }, fixture.plugins)).rules));
  });

  test("does not inherit nested options omitted from observed settings", async () => {
    const rules: RuleSettings = {
      "demo/first": "warn",
      "demo/second": "warn",
      "demo/nested": ["warn", { values: { observed: true } }],
    };
    const fixture = context("lint", {
      namespace: "demo",
      lintRules: [
        lintRule("first"),
        lintRule("second"),
        {
          ...lintRule("nested"),
          optionsSchema: z.strictObject({
            values: z.strictObject({ observed: z.boolean(), extra: z.boolean().optional() }),
          }),
        },
      ],
      presets: {
        inherited: {
          ...rules,
          "demo/nested": ["warn", { values: { observed: true, extra: true } }],
        },
      },
    });
    await expect(compressPresets({ ...fixture, rules })).resolves.toEqual({ preset: [], rules });
  });

  test("breaks ties deterministically without activating excluded or invalid preset rules", async () => {
    const rules: RuleSettings = {
      "demo/first": "warn",
      "demo/second": "warn",
      "demo/third": "warn",
    };
    const fixture = context("lint", {
      namespace: "demo",
      lintRules: [
        lintRule("first"),
        lintRule("second"),
        lintRule("third"),
        lintRule("excluded"),
        lintRule("unobserved"),
        {
          ...lintRule("needs-options"),
          optionsSchema: z.strictObject({ required: z.boolean() }),
        },
      ],
      presets: {
        "a-excluded": { ...rules, "demo/excluded": "warn" },
        "b-invalid": { ...rules, "demo/needs-options": "warn" },
        "z-equivalent": { ...rules, "demo/unobserved": "warn" },
        "c-valid": { ...rules, "demo/unobserved": "warn" },
      },
    });
    const result = await compressPresets({
      ...fixture,
      rules,
      insufficient: new Set(["demo/needs-options"]),
      excluded: new Set(["demo/excluded"]),
    });
    expect(result).toEqual({
      preset: ["demo/c-valid"],
      rules: { "demo/unobserved": "off" },
    });
  });

  test("bounds the search for twelve overlapping presets and reuses prompt comparisons", async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `rule-${index}`);
    const rules: RuleSettings = Object.fromEntries(
      ["shared", ...ids].map((id) => [`demo/${id}`, "warn"]),
    );
    const sharedPrompt = vi.fn(lintRule("shared").buildPrompt);
    const fixture = context("lint", {
      namespace: "demo",
      lintRules: [
        ...ids.map(lintRule),
        {
          ...lintRule("shared"),
          optionsSchema: z.strictObject({ marker: z.number().optional() }),
          buildPrompt: sharedPrompt,
        },
      ],
      presets: Object.fromEntries(
        ids.map((id, marker) => [
          `preset-${marker}`,
          { [`demo/${id}`]: "warn", "demo/shared": ["warn", { marker }] },
        ]),
      ),
    });

    const result = await compressPresets({ ...fixture, rules });
    expect(result).toEqual({ preset: [], rules });
    expect(sharedPrompt.mock.calls.length).toBeLessThanOrEqual(14);
    expect(await compressPresets({ ...fixture, rules })).toEqual(result);
    await expectSamePreparedRules(fixture, rules, result);
  }, 2_500);
});

const context = (tool: ToolKind, plugin: RulePlugin) => ({
  config: normalizeConfig(tool, process.cwd(), { plugins: ["plugin"] }),
  plugins: { plugin },
  candidates: new Map(
    (tool === "lint" ? (plugin.lintRules ?? []) : (plugin.formatRules ?? [])).map((rule) => [
      `${plugin.namespace}/${rule.id}`,
      rule,
    ]),
  ),
  insufficient: new Set<string>(),
});

const lintRule = (id: string): LintRule => ({
  id,
  description: "Test rule",
  scope: "file",
  buildPrompt: ({ options }) => ({
    applicability: "Source files",
    criteria: JSON.stringify(options),
    evidenceRequirements: [],
  }),
});

const selectRules = (rules: RuleSettings, ...ids: string[]): RuleSettings =>
  Object.fromEntries(ids.map((id) => [`demo/${id}`, rules[`demo/${id}`]!]));

const byId = <T extends { id: string }>(items: T[]): Record<string, T> =>
  Object.fromEntries(items.map((item) => [item.id, item]));

const expectSamePreparedRules = async (
  { config, plugins }: ReturnType<typeof context>,
  rules: RuleSettings,
  compressed: Awaited<ReturnType<typeof compressPresets>>,
): Promise<void> => {
  const direct = await prepareRules({ ...config, rules }, plugins);
  const prepared = await prepareRules({ ...config, ...compressed }, plugins);
  expect(direct.errors).toEqual([]);
  expect(prepared.errors).toEqual([]);
  expect(byId(prepared.rules)).toEqual(byId(direct.rules));
};
