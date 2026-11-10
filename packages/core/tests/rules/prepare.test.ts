import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { prepareRules } from "../../src/rules/prepare";
import type { LoadedConfig } from "../../src/config/types";
import type { JsonObject } from "../../src/shared/types";
import type {
  FormatRule,
  LintRule,
  RulePlugin,
  RuleSetting,
  RuleSettings,
} from "../../src/rules/types";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("prepareRules", () => {
  test("registers plugins without activating their rules or presets", async () => {
    const buildPrompt = vi.fn(validPrompt);
    const unusedPrompt = vi.fn(validPrompt);
    const plugins: Record<string, RulePlugin> = {
      first: {
        namespace: "alpha",
        lintRules: [lintRule("check", buildPrompt)],
        presets: { all: { "alpha/check": "error" } },
      },
      second: {
        namespace: "beta",
        lintRules: [lintRule("check", buildPrompt)],
      },
      unused: {
        namespace: "unused",
        lintRules: [lintRule("check", unusedPrompt)],
      },
    };

    const result = await prepareRules(loaded({ plugins: ["first", "second"] }), plugins);

    expect(result).toEqual({ rules: [], errors: [] });
    expect(buildPrompt).not.toHaveBeenCalled();
    expect(unusedPrompt).not.toHaveBeenCalled();
  });

  test("overrides and disables individual rules while retaining other preset selections", async () => {
    const disabledPrompt = vi.fn(validPrompt);
    const config = loaded({
      plugins: ["first", "second"],
      preset: ["alpha/base", "beta/base"],
      rules: {
        "alpha/overridden": "warn",
        "alpha/disabled": "off",
      },
    });
    const result = await prepareRules(config, {
      first: {
        namespace: "alpha",
        lintRules: [
          lintRule("overridden", validPrompt),
          lintRule("disabled", disabledPrompt),
          lintRule("unchanged", validPrompt),
        ],
        presets: {
          base: {
            "alpha/overridden": "error",
            "alpha/disabled": "error",
            "alpha/unchanged": "error",
          },
        },
      },
      second: {
        namespace: "beta",
        lintRules: [lintRule("check", validPrompt)],
        presets: { base: { "beta/check": "warn" } },
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.rules).toEqual([
      expect.objectContaining({ id: "alpha/overridden", severity: "warn" }),
      expect.objectContaining({ id: "alpha/unchanged", severity: "error" }),
      expect.objectContaining({ id: "beta/check", severity: "warn" }),
    ]);
    expect(disabledPrompt).not.toHaveBeenCalled();
    expect(config.rules).toEqual({
      "alpha/overridden": "warn",
      "alpha/disabled": "off",
    });
  });

  test("registers only requested plugins and merges validated options without mutation", async () => {
    const received: JsonObject[] = [];
    const defaults = {
      nested: { first: true, second: "default" },
      list: [1, 2],
      nullable: "default",
    };
    const plugin: RulePlugin = {
      namespace: "demo",
      lintRules: [
        {
          id: "contracts/check",
          description: "Check a contract",
          scope: "module",
          optionsSchema: z
            .object({
              nested: z.object({ first: z.boolean(), second: z.string() }).strict(),
              list: z.array(z.number()),
              nullable: z.string().nullable(),
            })
            .strict(),
          buildPrompt: async ({ options }) => {
            received.push(options);
            return {
              applicability: "Applicable modules",
              criteria: "The contract holds",
              evidenceRequirements: ["Show evidence"],
            };
          },
        },
      ],
      presets: { base: { "demo/contracts/check": ["error", defaults] } },
    };
    const config = loaded({
      plugins: ["builtin-demo"],
      preset: ["demo/base"],
      rules: {
        "demo/contracts/check": [
          "warn",
          { nested: { second: "selected" }, list: [9], nullable: null },
        ],
      },
    });

    const result = await prepareRules(config, { "builtin-demo": plugin, unused: plugin });

    expect(result.errors).toEqual([]);
    expect(result.rules).toEqual([
      expect.objectContaining({
        id: "demo/contracts/check",
        scope: "module",
        severity: "warn",
      }),
    ]);
    expect(received).toEqual([
      {
        nested: { first: true, second: "selected" },
        list: [9],
        nullable: null,
      },
    ]);
    expect(defaults).toEqual({
      nested: { first: true, second: "default" },
      list: [1, 2],
      nullable: "default",
    });
    expect(Object.isFrozen(received[0]?.nested)).toBe(true);
    expect(Object.isFrozen(defaults.nested)).toBe(false);

    const repeated = await prepareRules(config, { "builtin-demo": plugin });
    expect(repeated).toEqual(result);
    expect(received[1]).toEqual(received[0]);
    expect(received[1]).not.toBe(received[0]);
  });

  test("keeps valid rules when another rule has invalid options or instructions", async () => {
    const plugin: RulePlugin = {
      namespace: "demo",
      lintRules: [
        lintRule("valid", () => ({
          applicability: "code",
          criteria: "valid",
          evidenceRequirements: [],
        })),
        {
          ...lintRule("bad-options", () => ({
            applicability: "code",
            criteria: "unused",
            evidenceRequirements: [],
          })),
          optionsSchema: z.object({}).strict(),
        },
        lintRule("bad-prompt", () => ({ applicability: "code" }) as never),
      ],
    };
    const result = await prepareRules(
      loaded({
        plugins: ["demo-plugin"],
        rules: {
          "demo/valid": "error",
          "demo/bad-options": ["error", { unknown: true }],
          "demo/bad-prompt": "error",
        },
      }),
      { "demo-plugin": plugin },
    );

    expect(result.rules.map(({ id }) => id)).toEqual(["demo/valid"]);
    expect(result.errors.map(({ code }) => code)).toEqual([
      "RULE_OPTIONS_INVALID",
      "RULE_INSTRUCTIONS_INVALID",
    ]);
  });

  test("rejects option schemas that coerce or inject values", async () => {
    const plugin: RulePlugin = {
      namespace: "demo",
      lintRules: [
        {
          ...lintRule("transforming", validPrompt),
          optionsSchema: z
            .object({ count: z.coerce.number(), enabled: z.boolean().default(true) })
            .strict(),
        },
      ],
    };
    const result = await prepareRules(
      loaded({
        plugins: ["demo"],
        rules: { "demo/transforming": ["error", { count: "1" }] },
      }),
      { demo: plugin },
    );

    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "RULE_SCHEMA_TRANSFORMED_OPTIONS" }),
    ]);
  });

  test("does not call an off lint rule", async () => {
    const buildPrompt = vi.fn(() => ({
      applicability: "code",
      criteria: "criteria",
      evidenceRequirements: [],
    }));
    const result = await prepareRules(
      loaded({
        plugins: ["demo"],
        rules: { "demo/check": "off" },
      }),
      { demo: { namespace: "demo", lintRules: [lintRule("check", buildPrompt)] } },
    );

    expect(result).toEqual({ rules: [], errors: [] });
    expect(buildPrompt).not.toHaveBeenCalled();
  });

  test.each(["off", false] as const)(
    "reports an unregistered rule even when disabled with %s",
    async (setting) => {
      const result = await prepareRules(loaded({ rules: { "missing/check": setting } }));

      expect(result.rules).toEqual([]);
      expect(result.errors).toEqual([
        expect.objectContaining({ code: "RULE_NOT_FOUND", ruleIds: ["missing/check"] }),
      ]);
    },
  );

  test("still requires explicit formatter rule selection", async () => {
    const buildPrompt = vi.fn(() => ({
      applicability: "code",
      transformation: "format code",
      constraints: ["preserve behavior"],
    }));
    const plugins: Record<string, RulePlugin> = {
      demo: {
        namespace: "demo",
        formatRules: [
          { id: "first", description: "First rule", scope: "file", buildPrompt },
          { id: "second", description: "Second rule", scope: "file", buildPrompt },
        ],
      },
    };
    const config = loaded({ tool: "format", plugins: ["demo"] });

    expect(await prepareRules(config, plugins)).toEqual({ rules: [], errors: [] });
    expect(buildPrompt).not.toHaveBeenCalled();

    const selected = await prepareRules({ ...config, rules: { "demo/second": true } }, plugins);
    expect(selected.errors).toEqual([]);
    expect(selected.rules).toEqual([
      expect.objectContaining({ id: "demo/second", severity: undefined }),
    ]);
    expect(buildPrompt).toHaveBeenCalledOnce();
  });

  test("reapplies repeated presets in order before direct settings", async () => {
    const buildPrompt = vi.fn(validPrompt);
    const plugin: RulePlugin = {
      namespace: "demo",
      lintRules: [
        {
          ...lintRule("check", buildPrompt),
          optionsSchema: z.object({ count: z.number(), retained: z.boolean() }).strict(),
        },
      ],
      presets: {
        base: { "demo/check": ["error", { count: 1 }] },
        override: { "demo/check": ["warn", { count: 2, retained: true }] },
      },
    };
    const config = loaded({
      plugins: ["demo"],
      preset: ["demo/base", "demo/override", "demo/base"],
    });

    const repeated = await prepareRules(config, { demo: plugin });
    expect(repeated.errors).toEqual([]);
    expect(repeated.rules[0]?.severity).toBe("error");
    expect(buildPrompt).toHaveBeenLastCalledWith({ options: { count: 1, retained: true } });

    const overridden = await prepareRules(
      { ...config, rules: { "demo/check": "warn" } },
      { demo: plugin },
    );
    expect(overridden.errors).toEqual([]);
    expect(overridden.rules[0]?.severity).toBe("warn");
    expect(buildPrompt).toHaveBeenLastCalledWith({ options: { count: 1, retained: true } });
  });

  test.each(["lint", "format"] as const)(
    "retains %s options through disable and re-enable settings",
    async (tool) => {
      const lintPrompt = vi.fn(validPrompt);
      const formatPrompt = vi.fn(validFormatPrompt);
      const optionsSchema = z.object({ limit: z.number() }).strict();
      const presets: Record<string, RuleSettings> = {
        base: { "demo/check": tool === "lint" ? ["error", { limit: 5 }] : { limit: 5 } },
        disabled: { "demo/check": tool === "lint" ? "off" : false },
      };
      const plugin: RulePlugin = {
        namespace: "demo",
        lintRules: tool === "lint" ? [{ ...lintRule("check", lintPrompt), optionsSchema }] : [],
        formatRules:
          tool === "format" ? [{ ...formatRule("check", formatPrompt), optionsSchema }] : [],
        presets,
      };
      const config = loaded({
        tool,
        plugins: ["demo"],
        preset: ["demo/base", "demo/disabled"],
      });

      expect(await prepareRules(config, { demo: plugin })).toEqual({ rules: [], errors: [] });
      expect(lintPrompt).not.toHaveBeenCalled();
      expect(formatPrompt).not.toHaveBeenCalled();

      const result = await prepareRules(
        { ...config, rules: { "demo/check": tool === "lint" ? "warn" : true } },
        { demo: plugin },
      );
      expect(result.errors).toEqual([]);
      expect(result.rules).toEqual([
        expect.objectContaining({
          id: "demo/check",
          severity: tool === "lint" ? "warn" : undefined,
        }),
      ]);
      expect(tool === "lint" ? lintPrompt : formatPrompt).toHaveBeenCalledWith({
        options: { limit: 5 },
      });
      expect(presets.base["demo/check"]).toEqual(
        tool === "lint" ? ["error", { limit: 5 }] : { limit: 5 },
      );
    },
  );

  test("format option objects re-enable rules and empty objects retain options", async () => {
    const buildPrompt = vi.fn(validFormatPrompt);
    const plugin: RulePlugin = {
      namespace: "demo",
      formatRules: [
        {
          ...formatRule("check", buildPrompt),
          optionsSchema: z.object({ prefix: z.string(), suffix: z.string() }).strict(),
        },
      ],
      presets: {
        base: { "demo/check": { prefix: "before", suffix: "after" } },
        disabled: { "demo/check": false },
        empty: { "demo/check": {} },
      },
    };
    const result = await prepareRules(
      loaded({
        tool: "format",
        plugins: ["demo"],
        preset: ["demo/base", "demo/disabled", "demo/empty"],
        rules: { "demo/check": { suffix: "updated" } },
      }),
      { demo: plugin },
    );

    expect(result.errors).toEqual([]);
    expect(result.rules.map(({ id }) => id)).toEqual(["demo/check"]);
    expect(buildPrompt).toHaveBeenCalledWith({
      options: { prefix: "before", suffix: "updated" },
    });
  });

  test.each(["lint", "format"] as const)(
    "resolves cross-plugin presets and selects only %s rules from mixed settings",
    async (tool) => {
      const lintPrompt = vi.fn(validPrompt);
      const formatPrompt = vi.fn(validFormatPrompt);
      const plugins: Record<string, RulePlugin> = {
        team: {
          namespace: "team",
          presets: { all: { "alpha/check": "error", "beta/clean": true } },
        },
        lint: { namespace: "alpha", lintRules: [lintRule("check", lintPrompt)] },
        format: { namespace: "beta", formatRules: [formatRule("clean", formatPrompt)] },
      };
      const result = await prepareRules(
        loaded({
          tool,
          plugins: ["team", "lint", "format"],
          preset: ["team/all"],
          rules: { "alpha/check": "warn", "beta/clean": {} },
        }),
        plugins,
      );

      expect(result.errors).toEqual([]);
      expect(result.rules.map(({ id }) => id)).toEqual([
        tool === "lint" ? "alpha/check" : "beta/clean",
      ]);
      expect(tool === "lint" ? lintPrompt : formatPrompt).toHaveBeenCalledOnce();
      expect(tool === "lint" ? formatPrompt : lintPrompt).not.toHaveBeenCalled();
    },
  );

  test("keeps valid preset entries when other selected presets or entries are invalid", async () => {
    const plugin = {
      namespace: "demo",
      lintRules: [lintRule("valid", validPrompt), lintRule("invalid", validPrompt)],
      presets: {
        malformed: [],
        partial: {
          "demo/valid": "warn",
          "demo/invalid": ["error"],
          "missing/check": "off",
        },
        unused: { "unregistered/check": "error" },
      },
    } as unknown as RulePlugin;
    const result = await prepareRules(
      loaded({
        plugins: ["demo"],
        preset: ["demo/missing", "demo/toString", "demo/malformed", "demo/partial"],
      }),
      { demo: plugin },
    );

    expect(result.rules).toEqual([expect.objectContaining({ id: "demo/valid", severity: "warn" })]);
    expect(result.errors.map(({ code }) => code)).toEqual([
      "PRESET_NOT_FOUND",
      "PRESET_NOT_FOUND",
      "PRESET_INVALID",
      "RULE_SETTING_INVALID",
      "RULE_NOT_FOUND",
    ]);
  });

  test("does not activate unregistered plugin dependencies through a preset", async () => {
    const missingPrompt = vi.fn(validPrompt);
    const result = await prepareRules(loaded({ plugins: ["team"], preset: ["team/all"] }), {
      team: { namespace: "team", presets: { all: { "missing/check": "error" } } },
      missing: { namespace: "missing", lintRules: [lintRule("check", missingPrompt)] },
    });

    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "RULE_NOT_FOUND", ruleIds: ["missing/check"] }),
    ]);
    expect(missingPrompt).not.toHaveBeenCalled();
  });

  test("retains an earlier valid selection when a later preset entry has an invalid setting", async () => {
    const buildPrompt = vi.fn(validPrompt);
    const result = await prepareRules(
      loaded({ plugins: ["demo"], preset: ["demo/base", "demo/invalid"] }),
      {
        demo: {
          namespace: "demo",
          lintRules: [lintRule("check", buildPrompt)],
          presets: {
            base: { "demo/check": "warn" },
            invalid: { "demo/check": true },
          },
        },
      },
    );

    expect(result.rules).toEqual([expect.objectContaining({ id: "demo/check", severity: "warn" })]);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "RULE_SETTING_INVALID", ruleIds: ["demo/check"] }),
    ]);
    expect(buildPrompt).toHaveBeenCalledOnce();
  });

  test.each<{ tool: "lint" | "format"; setting: RuleSetting }>([
    { tool: "lint", setting: true },
    { tool: "lint", setting: {} },
    { tool: "format", setting: "error" },
    { tool: "format", setting: "off" },
    { tool: "format", setting: ["warn", {}] },
  ])("rejects $setting for a $tool rule", async ({ tool, setting }) => {
    const result = await prepareRules(
      loaded({ tool, plugins: ["demo"], rules: { "demo/check": setting } }),
      {
        demo: {
          namespace: "demo",
          lintRules: tool === "lint" ? [lintRule("check", validPrompt)] : [],
          formatRules: tool === "format" ? [formatRule("check", validFormatPrompt)] : [],
        },
      },
    );

    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "RULE_SETTING_INVALID", ruleIds: ["demo/check"] }),
    ]);
  });

  test("requires explicit mandatory options only for active final selections", async () => {
    const buildPrompt = vi.fn(validPrompt);
    const plugin: RulePlugin = {
      namespace: "demo",
      lintRules: [
        {
          ...lintRule("check", buildPrompt),
          optionsSchema: z.object({ required: z.boolean() }).strict(),
        },
      ],
    };
    const active = await prepareRules(
      loaded({ plugins: ["demo"], rules: { "demo/check": "error" } }),
      { demo: plugin },
    );
    expect(active.rules).toEqual([]);
    expect(active.errors).toEqual([
      expect.objectContaining({ code: "RULE_OPTIONS_INVALID", ruleIds: ["demo/check"] }),
    ]);

    const disabled = await prepareRules(
      loaded({ plugins: ["demo"], rules: { "demo/check": "off" } }),
      { demo: plugin },
    );
    expect(disabled).toEqual({ rules: [], errors: [] });
    expect(buildPrompt).not.toHaveBeenCalled();
  });

  test.each([
    { field: "defaultSeverity", value: "warn" },
    { field: "defaultOptions", value: {} },
  ])(
    "rejects legacy $field on rule definitions while retaining valid rules",
    async ({ field, value }) => {
      const result = await prepareRules(
        loaded({ plugins: ["demo"], rules: { "demo/valid": "error" } }),
        {
          demo: {
            namespace: "demo",
            lintRules: [
              lintRule("valid", validPrompt),
              { ...lintRule("legacy", validPrompt), [field]: value },
            ],
          },
        },
      );

      expect(result.rules.map(({ id }) => id)).toEqual(["demo/valid"]);
      expect(result.errors).toEqual([
        expect.objectContaining({ code: "RULE_INVALID", ruleIds: ["demo/legacy"] }),
      ]);
    },
  );

  test("rejects a formatter rule that duplicates a lint rule ID", async () => {
    const lintPrompt = vi.fn(validPrompt);
    const formatPrompt = vi.fn(validFormatPrompt);
    const result = await prepareRules(
      loaded({ plugins: ["demo"], rules: { "demo/check": "warn" } }),
      {
        demo: {
          namespace: "demo",
          lintRules: [lintRule("check", lintPrompt)],
          formatRules: [formatRule("check", formatPrompt)],
        },
      },
    );

    expect(result.rules).toEqual([expect.objectContaining({ id: "demo/check", severity: "warn" })]);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "RULE_CONFLICT", ruleIds: ["demo/check"] }),
    ]);
    expect(lintPrompt).toHaveBeenCalledOnce();
    expect(formatPrompt).not.toHaveBeenCalled();
  });

  test("reports plugin namespace and rule registration conflicts without overwriting", async () => {
    const first: RulePlugin = {
      namespace: "same",
      lintRules: [lintRule("duplicate", validPrompt)],
    };
    const duplicateRules: RulePlugin = {
      namespace: "inside",
      lintRules: [lintRule("duplicate", validPrompt), lintRule("duplicate", validPrompt)],
    };
    const result = await prepareRules(
      loaded({
        plugins: ["first", "second", "inside"],
        rules: { "same/duplicate": "error", "inside/duplicate": "error" },
      }),
      {
        first,
        second: { namespace: "same", lintRules: [lintRule("other", validPrompt)] },
        inside: duplicateRules,
      },
    );

    expect(result.rules.map(({ id }) => id)).toEqual(["same/duplicate", "inside/duplicate"]);
    expect(result.errors.map(({ code }) => code)).toEqual([
      "PLUGIN_NAMESPACE_CONFLICT",
      "RULE_CONFLICT",
    ]);
  });

  test("loads a JavaScript plugin relative to the configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aquarius-plugin-"));
    directories.push(directory);
    await writeFile(
      join(directory, "plugin.mjs"),
      `export default {
      namespace: "external",
      formatRules: [{
        id: "style/clean",
        description: "Clean code",
        scope: "file",
        buildPrompt: () => ({ applicability: "code", transformation: "clean it", constraints: ["preserve behavior"] })
      }]
    };`,
    );

    const result = await prepareRules(
      loaded({
        tool: "format",
        configDirectory: directory,
        plugins: ["./plugin.mjs"],
        rules: { "external/style/clean": true },
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.rules).toEqual([
      expect.objectContaining({ id: "external/style/clean", severity: undefined }),
    ]);
  });

  test("resolves an installed plugin package from the target project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aquarius-package-plugin-"));
    directories.push(directory);
    const packageDirectory = join(directory, "node_modules", "project-rules");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({
        name: "project-rules",
        type: "module",
        exports: { ".": { import: "./index.mjs" } },
      }),
    );
    await writeFile(
      join(packageDirectory, "index.mjs"),
      `export default {
      namespace: "project",
      lintRules: [{
        id: "check",
        description: "Check",
        scope: "project",
        buildPrompt: () => ({ applicability: "code", criteria: "check", evidenceRequirements: [] })
      }]
    };`,
    );

    const result = await prepareRules(
      loaded({
        configDirectory: directory,
        plugins: ["project-rules"],
        rules: { "project/check": "warn" },
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.rules).toEqual([
      expect.objectContaining({ id: "project/check", severity: "warn" }),
    ]);
  });

  test("does not make an unrequested builtin plugin available", async () => {
    const result = await prepareRules(loaded({ rules: { "demo/check": "error" } }), {
      demo: { namespace: "demo", lintRules: [lintRule("check", validPrompt)] },
    });
    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "RULE_NOT_FOUND", ruleIds: ["demo/check"] }),
    ]);
  });
});

const lintRule = (id: string, buildPrompt: LintRule["buildPrompt"]): LintRule => ({
  id,
  description: "Test rule",
  scope: "file",
  buildPrompt,
});

const validPrompt = (): ReturnType<LintRule["buildPrompt"]> => ({
  applicability: "code",
  criteria: "criteria",
  evidenceRequirements: [],
});

const formatRule = (id: string, buildPrompt: FormatRule["buildPrompt"]): FormatRule => ({
  id,
  description: "Test format rule",
  scope: "file",
  buildPrompt,
});

const validFormatPrompt = (): ReturnType<FormatRule["buildPrompt"]> => ({
  applicability: "code",
  transformation: "format code",
  constraints: ["preserve behavior"],
});

const loaded = (overrides: Partial<LoadedConfig> = {}): LoadedConfig => {
  const root = overrides.projectRoot ?? process.cwd();
  return {
    tool: "lint",
    cwd: root,
    projectRoot: root,
    configDirectory: root,
    files: ["**/*"],
    ignore: [],
    plugins: [],
    preset: [],
    ai: { adapter: "codex", options: {}, timeoutMs: 600_000 },
    rules: {},
    ...overrides,
  };
};
