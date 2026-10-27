import { parseDocument } from "yaml";
import { z } from "zod";
import { AquariusError } from "../shared/errors";
import type { JsonObject } from "../shared/types";
import { formatRuleZodIssues, formatInstructionsSchema, lintInstructionsSchema } from "./schemas";
import type { FormatInstructions, FormatRule, LintInstructions, LintRule } from "./types";

const jsonObjectSchema = z.record(z.string(), z.json());

const yamlRuleBaseShape = {
  id: z.string().min(1),
  description: z.string().min(1),
  scope: z.enum(["file", "module", "project"]),
  optionsSchema: jsonObjectSchema.optional(),
  defaultOptions: jsonObjectSchema.optional(),
};

const lintYamlRuleSchema = z.object({
  ...yamlRuleBaseShape,
  defaultSeverity: z.enum(["warn", "error"]),
  prompt: lintInstructionsSchema,
}).strict();

const formatYamlRuleSchema = z.object({
  ...yamlRuleBaseShape,
  prompt: formatInstructionsSchema,
}).strict();

export const lintRuleFromYaml = (text: string): LintRule => {
  const source = parseYaml(text, lintYamlRuleSchema);
  validateRuleId(source.id);
  validateDefaultOptions(source.optionsSchema, source.defaultOptions);
  validateTemplateValue(source.prompt);
  return {
    id: source.id,
    description: source.description,
    scope: source.scope,
    defaultSeverity: source.defaultSeverity,
    optionsSchema: createOptionsSchema(source.optionsSchema),
    defaultOptions: source.defaultOptions,
    buildPrompt: ({ options }) => renderValue(source.prompt, options) as LintInstructions,
  };
};

export const formatRuleFromYaml = (text: string): FormatRule => {
  const source = parseYaml(text, formatYamlRuleSchema);
  validateRuleId(source.id);
  validateDefaultOptions(source.optionsSchema, source.defaultOptions);
  validateTemplateValue(source.prompt);
  return {
    id: source.id,
    description: source.description,
    scope: source.scope,
    optionsSchema: createOptionsSchema(source.optionsSchema),
    defaultOptions: source.defaultOptions,
    buildPrompt: ({ options }) => renderValue(source.prompt, options) as FormatInstructions,
  };
};

const parseYaml = <T>(text: string, schema: z.ZodType<T>): T => {
  let value: unknown;
  try {
    const document = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new Error(document.errors.map(({ message }) => message).join("; "));
    }
    value = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new AquariusError("YAML_PARSE_FAILED", `Cannot parse YAML rule: ${errorMessage(error)}`);
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) invalid(formatRuleZodIssues(parsed.error));
  return parsed.data;
};

const createOptionsSchema = (schema: JsonObject | undefined): z.ZodType | undefined => {
  if (!schema) return undefined;
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (error) {
    invalid(`optionsSchema is not supported: ${errorMessage(error)}`);
  }
};

const validateRuleId = (id: string): void => {
  if (id.startsWith("/") || id.endsWith("/") || id.split("/").some((part) => part.trim() === "")) {
    invalid("id must contain non-empty path segments");
  }
};

const validateDefaultOptions = (schema: JsonObject | undefined, defaults: JsonObject | undefined): void => {
  if (defaults && !schema) invalid("defaultOptions requires optionsSchema");
};

const validateTemplateValue = (value: unknown): void => {
  if (typeof value === "string") {
    validateTemplateSyntax(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateTemplateValue(item);
    return;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) validateTemplateValue(item);
  }
};

const renderValue = (value: unknown, options: Readonly<JsonObject>): unknown => {
  if (typeof value === "string") return renderString(value, options);
  if (Array.isArray(value)) return value.map((item) => renderValue(item, options));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderValue(item, options)]));
  }
  return value;
};

const renderString = (template: string, options: Readonly<JsonObject>): string => template.replace(
  /{{\s*([^{}]+?)\s*}}/g,
  (_match, expression: string) => {
    const path = expression.trim().split(".");
    let value: unknown = options;
    for (const part of path.slice(1)) {
      if (!isPlainObject(value) || !Object.hasOwn(value, part)) {
        throw new AquariusError("YAML_TEMPLATE_MISSING", `Missing template option: ${path.join(".")}`);
      }
      value = value[part];
    }
    if (typeof value === "string") return value;
    try {
      const json = JSON.stringify(value);
      if (json === undefined) throw new Error("value is not JSON-serializable");
      return json;
    } catch (error) {
      throw new AquariusError("YAML_TEMPLATE_INVALID", `Cannot render ${path.join(".")}: ${errorMessage(error)}`);
    }
  },
);

const validateTemplateSyntax = (template: string): void => {
  const token = /{{\s*([^{}]+?)\s*}}/g;
  const remainder = template.replace(token, (_match, expression: string) => {
    const path = expression.trim().split(".");
    if (path[0] !== "options" || path.length < 2 || path.some((part) => part === "")) {
      invalid(`only options dot paths are allowed in templates: ${expression.trim()}`);
    }
    return "";
  });
  if (remainder.includes("{{") || remainder.includes("}}")) invalid("template contains a malformed placeholder");
};

const isPlainObject = (value: unknown): value is JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const invalid: (message: string) => never = (message) => {
  throw new AquariusError("YAML_RULE_INVALID", message);
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
