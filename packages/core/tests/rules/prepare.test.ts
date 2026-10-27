import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { prepareRules } from "../../src/rules/prepare";
import type { LoadedConfig } from "../../src/config/types";
import type { JsonObject } from "../../src/shared/types";
import type { LintRule, RulePlugin } from "../../src/rules/types";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("prepareRules", () => {
  test("registers only requested plugins and merges validated options without mutation", async () => {
    const received: JsonObject[] = [];
    const defaults = {
      nested: { first: true, second: "default" },
      list: [1, 2],
      nullable: "default",
    };
    const plugin: RulePlugin = {
      namespace: "demo",
      lintRules: [{
        id: "contracts/check",
        description: "Check a contract",
        scope: "module",
        defaultSeverity: "error",
        optionsSchema: z.object({
          nested: z.object({ first: z.boolean(), second: z.string() }).strict(),
          list: z.array(z.number()),
          nullable: z.string().nullable(),
        }).strict(),
        defaultOptions: defaults,
        buildPrompt: async ({ options }) => {
          received.push(options);
          return {
            applicability: "Applicable modules",
            criteria: "The contract holds",
            evidenceRequirements: ["Show evidence"],
          };
        },
      }],
    };
    const config = loaded({
      plugins: ["builtin-demo"],
      rules: [{
        rule: "demo/contracts/check",
        severity: "warn",
        options: { nested: { second: "selected" }, list: [9], nullable: null },
      }],
    });

    const result = await prepareRules(config, { "builtin-demo": plugin, unused: plugin });

    expect(result.errors).toEqual([]);
    expect(result.rules).toEqual([expect.objectContaining({
      id: "demo/contracts/check",
      scope: "module",
      severity: "warn",
    })]);
    expect(received).toEqual([{
      nested: { first: true, second: "selected" },
      list: [9],
      nullable: null,
    }]);
    expect(defaults).toEqual({
      nested: { first: true, second: "default" },
      list: [1, 2],
      nullable: "default",
    });
    expect(Object.isFrozen(received[0]?.nested)).toBe(true);
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
    const result = await prepareRules(loaded({
      plugins: ["demo-plugin"],
      rules: [
        { rule: "demo/valid" },
        { rule: "demo/bad-options", options: { unknown: true } },
        { rule: "demo/bad-prompt" },
      ],
    }), { "demo-plugin": plugin });

    expect(result.rules.map(({ id }) => id)).toEqual(["demo/valid"]);
    expect(result.errors.map(({ code }) => code)).toEqual(["RULE_OPTIONS_INVALID", "RULE_INSTRUCTIONS_INVALID"]);
  });

  test("rejects option schemas that coerce or inject values", async () => {
    const plugin: RulePlugin = {
      namespace: "demo",
      lintRules: [{
        ...lintRule("transforming", validPrompt),
        optionsSchema: z.object({ count: z.coerce.number(), enabled: z.boolean().default(true) }).strict(),
      }],
    };
    const result = await prepareRules(loaded({
      plugins: ["demo"],
      rules: [{ rule: "demo/transforming", options: { count: "1" } }],
    }), { demo: plugin });

    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({ code: "RULE_SCHEMA_TRANSFORMED_OPTIONS" })]);
  });

  test("does not call an off lint rule", async () => {
    const buildPrompt = vi.fn(() => ({ applicability: "code", criteria: "criteria", evidenceRequirements: [] }));
    const result = await prepareRules(loaded({
      plugins: ["demo"],
      rules: [{ rule: "demo/check", severity: "off" }],
    }), { demo: { namespace: "demo", lintRules: [lintRule("check", buildPrompt)] } });

    expect(result).toEqual({ rules: [], errors: [] });
    expect(buildPrompt).not.toHaveBeenCalled();
  });

  test("reports plugin namespace and rule registration conflicts without overwriting", async () => {
    const first: RulePlugin = { namespace: "same", lintRules: [lintRule("duplicate", validPrompt)] };
    const duplicateRules: RulePlugin = {
      namespace: "inside",
      lintRules: [lintRule("duplicate", validPrompt), lintRule("duplicate", validPrompt)],
    };
    const result = await prepareRules(loaded({
      plugins: ["first", "second", "inside"],
      rules: [{ rule: "same/duplicate" }, { rule: "inside/duplicate" }],
    }), {
      first,
      second: { namespace: "same", lintRules: [lintRule("other", validPrompt)] },
      inside: duplicateRules,
    });

    expect(result.rules.map(({ id }) => id)).toEqual(["same/duplicate", "inside/duplicate"]);
    expect(result.errors.map(({ code }) => code)).toEqual(["PLUGIN_NAMESPACE_CONFLICT", "RULE_CONFLICT"]);
  });

  test("loads a JavaScript plugin relative to the configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aquarius-plugin-"));
    directories.push(directory);
    await writeFile(join(directory, "plugin.mjs"), `export default {
      namespace: "external",
      formatRules: [{
        id: "style/clean",
        description: "Clean code",
        scope: "file",
        buildPrompt: () => ({ applicability: "code", transformation: "clean it", constraints: ["preserve behavior"] })
      }]
    };`);

    const result = await prepareRules(loaded({
      tool: "format",
      configDirectory: directory,
      plugins: ["./plugin.mjs"],
      rules: [{ rule: "external/style/clean" }],
    }));

    expect(result.errors).toEqual([]);
    expect(result.rules).toEqual([expect.objectContaining({ id: "external/style/clean", severity: undefined })]);
  });

  test("resolves an installed plugin package from the target project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aquarius-package-plugin-"));
    directories.push(directory);
    const packageDirectory = join(directory, "node_modules", "project-rules");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
      name: "project-rules",
      type: "module",
      exports: { ".": { import: "./index.mjs" } },
    }));
    await writeFile(join(packageDirectory, "index.mjs"), `export default {
      namespace: "project",
      lintRules: [{
        id: "check",
        description: "Check",
        scope: "project",
        defaultSeverity: "warn",
        buildPrompt: () => ({ applicability: "code", criteria: "check", evidenceRequirements: [] })
      }]
    };`);

    const result = await prepareRules(loaded({
      configDirectory: directory,
      plugins: ["project-rules"],
      rules: [{ rule: "project/check" }],
    }));

    expect(result.errors).toEqual([]);
    expect(result.rules).toEqual([expect.objectContaining({ id: "project/check", severity: "warn" })]);
  });

  test("does not make an unrequested builtin plugin available", async () => {
    const result = await prepareRules(loaded({ rules: [{ rule: "demo/check" }] }), {
      demo: { namespace: "demo", lintRules: [lintRule("check", validPrompt)] },
    });
    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({ code: "RULE_NOT_FOUND", ruleIds: ["demo/check"] })]);
  });
});

const lintRule = (id: string, buildPrompt: LintRule["buildPrompt"]): LintRule => ({
  id,
  description: "Test rule",
  scope: "file",
  defaultSeverity: "error",
  buildPrompt,
});

const validPrompt = (): ReturnType<LintRule["buildPrompt"]> => ({
  applicability: "code",
  criteria: "criteria",
  evidenceRequirements: [],
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
    ai: { adapter: "codex", options: {}, timeoutMs: 600_000 },
    rules: [],
    ...overrides,
  };
};
