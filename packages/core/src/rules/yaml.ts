import { parseDocument } from "yaml";
import { z } from "zod";

import { AquariusError, errorMessage } from "../shared/errors";
import { isPlainObject } from "../shared/json";
import { formatZodIssues, jsonObjectSchema } from "../shared/zod";
import type { JsonObject } from "../shared/types";

import { formatInstructionsSchema, lintInstructionsSchema } from "./schemas";
import type { FormatInstructions, FormatRule, LintInstructions, LintRule } from "./types";

const YAML_MAX_ALIAS_COUNT = 100;

const yamlRuleBaseShape = {
  id: z.string().min(1),
  description: z.string().min(1),
  scope: z.enum(["file", "module", "project"]),
  optionsSchema: jsonObjectSchema.optional(),
};

const lintYamlRuleSchema = z
  .object({
    ...yamlRuleBaseShape,
    prompt: lintInstructionsSchema,
  })
  .strict();

const formatYamlRuleSchema = z
  .object({
    ...yamlRuleBaseShape,
    prompt: formatInstructionsSchema,
  })
  .strict();

export const lintRuleFromYaml = (text: string): LintRule => {
  const source = parseYaml(text, lintYamlRuleSchema);
  validateRuleId(source.id);
  validateTemplateValue(source.prompt);
  return {
    id: source.id,
    description: source.description,
    scope: source.scope,
    optionsSchema: createOptionsSchema(source.optionsSchema),
    buildPrompt: ({ options }) => renderValue(source.prompt, options) as LintInstructions,
  };
};

export const formatRuleFromYaml = (text: string): FormatRule => {
  const source = parseYaml(text, formatYamlRuleSchema);
  validateRuleId(source.id);
  validateTemplateValue(source.prompt);
  return {
    id: source.id,
    description: source.description,
    scope: source.scope,
    optionsSchema: createOptionsSchema(source.optionsSchema),
    buildPrompt: ({ options }) => renderValue(source.prompt, options) as FormatInstructions,
  };
};

const parseYaml = <T>(text: string, schema: z.ZodType<T>): T => {
  let value: unknown;
  try {
    const document = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
    if (document.errors.length > 0) {
      const messages = document.errors.map(({ message }) => message);
      throw new Error(messages.join("; "));
    }
    value = document.toJS({ maxAliasCount: YAML_MAX_ALIAS_COUNT });
  } catch (error) {
    throw new AquariusError("YAML_PARSE_FAILED", `Cannot parse YAML rule: ${errorMessage(error)}`);
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) invalid(formatZodIssues(parsed.error, "value"));
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
  const hasEmptyPathSegment =
    id.startsWith("/") || id.endsWith("/") || id.split("/").some((part) => part.trim() === "");
  if (hasEmptyPathSegment) {
    invalid("id must contain non-empty path segments");
  }
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
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderValue(item, options)]),
    );
  }
  return value;
};

const renderString = (template: string, options: Readonly<JsonObject>): string => {
  const renderPlaceholder = (_match: string, expression: string): string => {
    const path = expression.trim().split(".");
    let value: unknown = options;
    for (const part of path.slice(1)) {
      if (!isPlainObject(value) || !Object.hasOwn(value, part)) {
        throw new AquariusError(
          "YAML_TEMPLATE_MISSING",
          `Missing template option: ${path.join(".")}`,
        );
      }
      value = value[part];
    }
    if (typeof value === "string") return value;
    try {
      const json = JSON.stringify(value);
      if (json === undefined) throw new Error("value is not JSON-serializable");
      return json;
    } catch (error) {
      throw new AquariusError(
        "YAML_TEMPLATE_INVALID",
        `Cannot render ${path.join(".")}: ${errorMessage(error)}`,
      );
    }
  };
  return template.replace(/{{\s*([^{}]+?)\s*}}/g, renderPlaceholder);
};

const validateTemplateSyntax = (template: string): void => {
  const removeValidatedPlaceholder = (_match: string, expression: string): string => {
    const path = expression.trim().split(".");
    const isInvalidOptionPath =
      path[0] !== "options" || path.length < 2 || path.some((part) => part === "");
    if (isInvalidOptionPath) {
      invalid(`only options dot paths are allowed in templates: ${expression.trim()}`);
    }
    return "";
  };
  const placeholderPattern = /{{\s*([^{}]+?)\s*}}/g;
  const remainder = template.replace(placeholderPattern, removeValidatedPlaceholder);
  if (remainder.includes("{{") || remainder.includes("}}"))
    invalid("template contains a malformed placeholder");
};

const invalid: (message: string) => never = (message) => {
  throw new AquariusError("YAML_RULE_INVALID", message);
};
