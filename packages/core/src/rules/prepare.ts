import { isDeepStrictEqual } from "node:util";
import { importProjectModule } from "./modules";
import {
  formatInstructionsSchema,
  formatRuleSchema,
  formatRuleZodIssues,
  lintInstructionsSchema,
  lintRuleSchema,
  rulePluginShapeSchema,
} from "./schemas";
import type { LoadedConfig } from "../config/types";
import type { JsonObject, RunError } from "../shared/types";
import type {
  ActiveSeverity,
  FormatRule,
  LintRule,
  PreparedRules,
  RulePlugin,
} from "./types";

export const prepareRules = async (
  config: LoadedConfig,
  builtinPlugins: Record<string, RulePlugin> = {},
): Promise<PreparedRules> => {
  const errors: RunError[] = [];
  const lintRules = new Map<string, LintRule>();
  const formatRules = new Map<string, FormatRule>();
  const namespaces = new Set<string>();

  for (const specifier of config.plugins) {
    let plugin: RulePlugin;
    try {
      plugin = await importProjectModule(
        specifier,
        config.configDirectory,
        Object.hasOwn(builtinPlugins, specifier) ? builtinPlugins[specifier] : undefined,
      ) as RulePlugin;
    } catch (error) {
      errors.push(runError("PLUGIN_LOAD_FAILED", `Cannot load plugin ${specifier}: ${errorMessage(error)}`));
      continue;
    }
    registerPlugin(specifier, plugin, namespaces, lintRules, formatRules, errors);
  }

  const prepared: PreparedRules["rules"] = [];
  for (const selection of config.rules) {
    const rule = config.tool === "lint" ? lintRules.get(selection.rule) : formatRules.get(selection.rule);
    if (!rule) {
      errors.push(runError("RULE_NOT_FOUND", `Rule is not registered for ${config.tool}: ${selection.rule}`, [selection.rule]));
      continue;
    }
    if (config.tool === "lint" && selection.severity === "off") continue;

    try {
      const options = prepareOptions(rule, selection.options ?? {});
      const instructions = await rule.buildPrompt({ options: deepFreeze(options) });
      validateInstructions(config.tool, instructions);
      prepared.push({
        id: selection.rule,
        scope: rule.scope,
        severity: config.tool === "lint"
          ? (selection.severity ?? (rule as LintRule).defaultSeverity) as ActiveSeverity
          : undefined,
        instructions,
      });
    } catch (error) {
      errors.push(runError(
        error instanceof RulePreparationError ? error.code : "RULE_PROMPT_FAILED",
        `${selection.rule}: ${errorMessage(error)}`,
        [selection.rule],
      ));
    }
  }

  return { rules: prepared, errors };
};

const registerPlugin = (
  specifier: string,
  plugin: RulePlugin,
  namespaces: Set<string>,
  lintRules: Map<string, LintRule>,
  formatRules: Map<string, FormatRule>,
  errors: RunError[],
): void => {
  const parsed = rulePluginShapeSchema.safeParse(plugin);
  if (!parsed.success || !isNamespace(plugin?.namespace)) {
    const detail = parsed.success ? "namespace is invalid" : formatRuleZodIssues(parsed.error);
    errors.push(runError("PLUGIN_INVALID", `Plugin ${specifier} is invalid: ${detail}`));
    return;
  }
  if (namespaces.has(plugin.namespace)) {
    errors.push(runError("PLUGIN_NAMESPACE_CONFLICT", `Plugin namespace is already registered: ${plugin.namespace}`));
    return;
  }
  namespaces.add(plugin.namespace);

  registerRuleList(plugin.namespace, "lint", plugin.lintRules, lintRules, errors);
  registerRuleList(plugin.namespace, "format", plugin.formatRules, formatRules, errors);
};

const registerRuleList = <T extends LintRule | FormatRule>(
  namespace: string,
  kind: "lint" | "format",
  input: unknown,
  registry: Map<string, T>,
  errors: RunError[],
): void => {
  if (input === undefined) return;
  if (!Array.isArray(input)) {
    errors.push(runError("PLUGIN_INVALID", `${namespace}.${kind}Rules must be an array`));
    return;
  }

  const schema = kind === "lint" ? lintRuleSchema : formatRuleSchema;
  for (const candidate of input) {
    const candidateId = typeof candidate === "object" && candidate !== null && "id" in candidate
      ? candidate.id
      : undefined;
    const id = typeof candidateId === "string" ? `${namespace}/${candidateId}` : namespace;
    const parsed = schema.safeParse(candidate);
    const problem = parsed.success ? validateRuleId(candidateId) : formatRuleZodIssues(parsed.error);
    if (problem) {
      errors.push(runError("RULE_INVALID", `${id}: ${problem}`, [id]));
      continue;
    }
    const rule = parsed.data as T;
    if (rule.defaultOptions !== undefined && rule.optionsSchema === undefined) {
      errors.push(runError("RULE_INVALID", `${id}: defaultOptions requires optionsSchema`, [id]));
      continue;
    }
    if (registry.has(id)) {
      errors.push(runError("RULE_CONFLICT", `Rule is already registered: ${id}`, [id]));
      continue;
    }
    registry.set(id, rule);
  }
};

const prepareOptions = (rule: LintRule | FormatRule, selected: JsonObject): JsonObject => {
  if (!rule.optionsSchema) {
    if (Object.keys(selected).length > 0) {
      throw new RulePreparationError("RULE_OPTIONS_INVALID", "rule does not declare options");
    }
    return {};
  }

  const merged = deepMerge(rule.defaultOptions ?? {}, selected);
  const parsed = rule.optionsSchema.safeParse(merged);
  if (!parsed.success) {
    throw new RulePreparationError("RULE_OPTIONS_INVALID", formatRuleZodIssues(parsed.error));
  }
  if (!isDeepStrictEqual(parsed.data, merged)) {
    throw new RulePreparationError("RULE_SCHEMA_TRANSFORMED_OPTIONS", "optionsSchema must validate without changing options");
  }
  return merged;
};

const deepMerge = (defaults: JsonObject, selected: JsonObject): JsonObject => {
  const keys = new Set([...Object.keys(defaults), ...Object.keys(selected)]);
  return Object.fromEntries([...keys].map((key) => {
    if (!Object.hasOwn(selected, key)) return [key, cloneJson(defaults[key])];
    const selectedValue = selected[key];
    const defaultValue = defaults[key];
    return [
      key,
      isPlainObject(defaultValue) && isPlainObject(selectedValue)
        ? deepMerge(defaultValue, selectedValue)
        : cloneJson(selectedValue),
    ];
  }));
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
  const parsed = (tool === "lint" ? lintInstructionsSchema : formatInstructionsSchema).safeParse(input);
  if (!parsed.success) {
    throw new RulePreparationError("RULE_INSTRUCTIONS_INVALID", formatRuleZodIssues(parsed.error));
  }
};

const validateRuleId = (value: unknown): string | undefined => (
  typeof value === "string" && isRuleId(value) ? undefined : "id is invalid"
);

const isNamespace = (value: unknown): value is string => (
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
);

const isRuleId = (value: string): boolean => (
  !value.startsWith("/")
  && !value.endsWith("/")
  && value.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
);

const isPlainObject = (value: unknown): value is JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const runError = (code: string, message: string, ruleIds: string[] = []): RunError => ({ code, message, ruleIds });

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

class RulePreparationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}
