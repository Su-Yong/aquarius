import { isDeepStrictEqual } from "node:util";

import { errorMessage } from "../shared/errors";
import { isPlainObject } from "../shared/json";
import { importProjectModule } from "../shared/modules";
import { formatZodIssues } from "../shared/zod";
import type { LoadedConfig } from "../config/types";
import type { JsonObject, RunError } from "../shared/types";

import {
  formatInstructionsSchema,
  formatRuleSchema,
  lintInstructionsSchema,
  lintRuleSchema,
  rulePluginShapeSchema,
  ruleSettingSchema,
} from "./schemas";
import type {
  ActiveSeverity,
  FormatInstructions,
  FormatRule,
  LintInstructions,
  LintRule,
  PreparedRules,
  RulePlugin,
  RuleSetting,
} from "./types";

interface SelectedRule {
  definition: LintRule | FormatRule;
  enabled: boolean;
  severity?: ActiveSeverity;
  options: JsonObject;
}

export const prepareRules = async (
  config: LoadedConfig,
  suppliedPlugins: Record<string, RulePlugin> = {},
): Promise<PreparedRules> => {
  const { errors, lintRules, formatRules, plugins } = await loadRulePlugins(
    config,
    suppliedPlugins,
  );

  const sources: { name: string; rules: Record<string, unknown> }[] = [];
  for (const reference of config.preset) {
    const separatorIndex = reference.indexOf("/");
    const namespace = reference.slice(0, separatorIndex);
    const name = reference.slice(separatorIndex + 1);
    const presets = plugins.get(namespace)?.presets;

    if (!presets || !Object.hasOwn(presets, name)) {
      errors.push(runError("PRESET_NOT_FOUND", `Preset is not registered: ${reference}`));
      continue;
    }

    const rules = presets[name];
    if (!isPlainObject(rules)) {
      errors.push(
        runError("PRESET_INVALID", `Preset ${reference} must be an object of rule settings`),
      );
      continue;
    }

    sources.push({ name: reference, rules });
  }
  sources.push({ name: "rules", rules: config.rules });

  const selections = new Map<string, SelectedRule>();
  for (const source of sources) {
    for (const [id, value] of Object.entries(source.rules)) {
      const definition = lintRules.get(id) ?? formatRules.get(id);
      if (!definition) {
        errors.push(
          runError("RULE_NOT_FOUND", `${source.name}: Rule is not registered: ${id}`, [id]),
        );
        continue;
      }

      const parsed = ruleSettingSchema.safeParse(value);
      if (!parsed.success) {
        errors.push(
          runError(
            "RULE_SETTING_INVALID",
            `${source.name}: ${id}: ${formatZodIssues(parsed.error, "value")}`,
            [id],
          ),
        );
        continue;
      }

      const setting = parsed.data;
      const kind = lintRules.has(id) ? "lint" : "format";
      const lintSetting = typeof setting === "string" || Array.isArray(setting);
      if (lintSetting !== (kind === "lint")) {
        errors.push(
          runError(
            "RULE_SETTING_INVALID",
            `${source.name}: ${id}: Setting is not valid for a ${kind} rule`,
            [id],
          ),
        );
        continue;
      }
      if (kind !== config.tool) {
        continue;
      }

      const { enabled, severity, options } = resolveRuleSetting(setting);
      selections.set(id, {
        definition,
        enabled,
        severity,
        options: deepMerge(selections.get(id)?.options ?? {}, options),
      });
    }
  }

  const prepared: PreparedRules["rules"] = [];
  for (const [id, selection] of selections) {
    if (!selection.enabled) {
      continue;
    }

    try {
      const instructions = await prepareRuleInstructions(
        config.tool,
        selection.definition,
        selection.options,
      );
      prepared.push({
        id,
        scope: selection.definition.scope,
        severity: selection.severity,
        instructions,
      });
    } catch (error) {
      errors.push(
        runError(
          error instanceof RulePreparationError ? error.code : "RULE_PROMPT_FAILED",
          `${id}: ${errorMessage(error)}`,
          [id],
        ),
      );
    }
  }

  return { rules: prepared, errors };
};

export const loadRulePlugins = async (
  config: LoadedConfig,
  suppliedPlugins: Record<string, RulePlugin> = {},
) => {
  const errors: RunError[] = [];
  const lintRules = new Map<string, LintRule>();
  const formatRules = new Map<string, FormatRule>();
  const plugins = new Map<string, RulePlugin>();
  const modules = new Map<string, RulePlugin>();

  for (const specifier of config.plugins) {
    let plugin: RulePlugin;
    try {
      plugin = Object.hasOwn(suppliedPlugins, specifier)
        ? suppliedPlugins[specifier]!
        : ((await importProjectModule(specifier, config.configDirectory)) as RulePlugin);
    } catch (error) {
      errors.push(
        runError("PLUGIN_LOAD_FAILED", `Cannot load plugin ${specifier}: ${errorMessage(error)}`),
      );
      continue;
    }

    modules.set(specifier, plugin);
    registerPlugin(specifier, plugin, plugins, lintRules, formatRules, errors);
  }

  return { errors, lintRules, formatRules, plugins, modules };
};

export const resolveRuleSetting = (setting: RuleSetting): Omit<SelectedRule, "definition"> => {
  if (typeof setting === "string" || Array.isArray(setting)) {
    const level = typeof setting === "string" ? setting : setting[0];
    const enabled = level !== "off";
    const severity = level === "off" ? undefined : level;
    const options = Array.isArray(setting) ? setting[1] : {};
    return { enabled, severity, options };
  }

  const enabled = setting !== false;
  const options = typeof setting === "object" ? setting : {};
  return { enabled, severity: undefined, options };
};

const registerPlugin = (
  specifier: string,
  plugin: RulePlugin,
  plugins: Map<string, RulePlugin>,
  lintRules: Map<string, LintRule>,
  formatRules: Map<string, FormatRule>,
  errors: RunError[],
): void => {
  const parsed = rulePluginShapeSchema.safeParse(plugin);
  if (!parsed.success || !isNamespace(plugin?.namespace)) {
    const detail = parsed.success ? "namespace is invalid" : formatZodIssues(parsed.error, "value");
    errors.push(runError("PLUGIN_INVALID", `Plugin ${specifier} is invalid: ${detail}`));
    return;
  }
  if (plugins.has(plugin.namespace)) {
    errors.push(
      runError(
        "PLUGIN_NAMESPACE_CONFLICT",
        `Plugin namespace is already registered: ${plugin.namespace}`,
      ),
    );
    return;
  }

  plugins.set(plugin.namespace, plugin);
  registerRuleList(plugin.namespace, "lint", plugin.lintRules, lintRules, formatRules, errors);
  registerRuleList(plugin.namespace, "format", plugin.formatRules, formatRules, lintRules, errors);
};

const registerRuleList = <T extends LintRule | FormatRule>(
  namespace: string,
  kind: "lint" | "format",
  input: unknown,
  registry: Map<string, T>,
  otherRegistry: ReadonlyMap<string, LintRule | FormatRule>,
  errors: RunError[],
): void => {
  if (input === undefined) return;
  if (!Array.isArray(input)) {
    errors.push(runError("PLUGIN_INVALID", `${namespace}.${kind}Rules must be an array`));
    return;
  }

  const schema = kind === "lint" ? lintRuleSchema : formatRuleSchema;
  for (const candidate of input) {
    const hasCandidateId = typeof candidate === "object" && candidate !== null && "id" in candidate;
    const candidateId = hasCandidateId ? candidate.id : undefined;
    const id = typeof candidateId === "string" ? `${namespace}/${candidateId}` : namespace;

    const parsed = schema.safeParse(candidate);
    const problem = parsed.success
      ? validateRuleId(candidateId)
      : formatZodIssues(parsed.error, "value");
    if (problem) {
      errors.push(runError("RULE_INVALID", `${id}: ${problem}`, [id]));
      continue;
    }

    const rule = parsed.data as T;
    if (registry.has(id) || otherRegistry.has(id)) {
      errors.push(runError("RULE_CONFLICT", `Rule is already registered: ${id}`, [id]));
      continue;
    }

    registry.set(id, rule);
  }
};

export const prepareRuleInstructions = async (
  tool: LoadedConfig["tool"],
  rule: LintRule | FormatRule,
  selectedOptions: JsonObject,
): Promise<LintInstructions | FormatInstructions> => {
  const options = prepareOptions(rule, selectedOptions);
  const instructions = await rule.buildPrompt({ options: deepFreeze(options) });
  validateInstructions(tool, instructions);
  return instructions;
};

export const prepareOptions = (rule: LintRule | FormatRule, selected: JsonObject): JsonObject => {
  if (!rule.optionsSchema) {
    if (Object.keys(selected).length > 0) {
      throw new RulePreparationError("RULE_OPTIONS_INVALID", "rule does not declare options");
    }
    return {};
  }

  const parsed = rule.optionsSchema.safeParse(selected);
  if (!parsed.success) {
    throw new RulePreparationError("RULE_OPTIONS_INVALID", formatZodIssues(parsed.error, "value"));
  }
  if (!isDeepStrictEqual(parsed.data, selected)) {
    throw new RulePreparationError(
      "RULE_SCHEMA_TRANSFORMED_OPTIONS",
      "optionsSchema must validate without changing options",
    );
  }

  return selected;
};

export const deepMerge = (defaults: JsonObject, selected: JsonObject): JsonObject => {
  const keys = new Set([...Object.keys(defaults), ...Object.keys(selected)]);

  const mergeEntry = (key: string): [string, unknown] => {
    if (!Object.hasOwn(selected, key)) return [key, cloneJson(defaults[key])];

    const selectedValue = selected[key];
    const defaultValue = defaults[key];
    const mergedValue =
      isPlainObject(defaultValue) && isPlainObject(selectedValue)
        ? deepMerge(defaultValue, selectedValue)
        : cloneJson(selectedValue);

    return [key, mergedValue];
  };

  return Object.fromEntries([...keys].map(mergeEntry));
};

const cloneJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  }
  return value;
};

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const validateInstructions = (tool: LoadedConfig["tool"], input: unknown): void => {
  const schema = tool === "lint" ? lintInstructionsSchema : formatInstructionsSchema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new RulePreparationError(
      "RULE_INSTRUCTIONS_INVALID",
      formatZodIssues(parsed.error, "value"),
    );
  }
};

const validateRuleId = (value: unknown): string | undefined =>
  typeof value === "string" && isRuleId(value) ? undefined : "id is invalid";

const isNamespace = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);

const isRuleId = (value: string): boolean => {
  const hasValidSegments =
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    value.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
  return hasValidSegments;
};

const runError = (code: string, message: string, ruleIds: string[] = []): RunError => ({
  code,
  message,
  ruleIds,
});

class RulePreparationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
