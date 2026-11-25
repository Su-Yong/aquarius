import { z } from "zod";
import { jsonObjectSchema, nonEmptyStringSchema } from "../shared/zod";
import type { FormatRule, LintRule } from "./types";

const severitySchema = z.enum(["off", "warn", "error"]);
export const lintRuleSettingSchema = z.union([
  severitySchema,
  z.tuple([severitySchema, jsonObjectSchema]),
]);
export const formatRuleSettingSchema = z.union([z.boolean(), jsonObjectSchema]);
export const ruleSettingSchema = z.union([lintRuleSettingSchema, formatRuleSettingSchema]);

const stringArraySchema = z.array(nonEmptyStringSchema);
const scopeSchema = z.enum(["file", "module", "project"]);
const optionsSchema = z.custom<z.ZodType>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    "safeParse" in value &&
    typeof value.safeParse === "function",
  "must be a Zod schema",
);
const buildPromptSchema = z.custom<LintRule["buildPrompt"] | FormatRule["buildPrompt"]>(
  (value) => typeof value === "function",
  "must be a function",
);

const ruleBaseShape = {
  id: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  scope: scopeSchema,
  optionsSchema: optionsSchema.optional(),
  buildPrompt: buildPromptSchema,
};

export const lintRuleSchema = z.object(ruleBaseShape).strict();
export const formatRuleSchema = z.object(ruleBaseShape).strict();

export const rulePluginShapeSchema = z
  .object({
    namespace: nonEmptyStringSchema,
    lintRules: z.array(z.unknown()).optional(),
    formatRules: z.array(z.unknown()).optional(),
    presets: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const lintInstructionsSchema = z
  .object({
    applicability: nonEmptyStringSchema,
    criteria: nonEmptyStringSchema,
    evidenceRequirements: stringArraySchema,
    exceptions: stringArraySchema.optional(),
    procedure: stringArraySchema.optional(),
    examples: z
      .array(
        z
          .object({
            scenario: nonEmptyStringSchema,
            expected: z.enum(["pass", "violation", "not_applicable"]),
            reason: nonEmptyStringSchema,
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const formatInstructionsSchema = z
  .object({
    applicability: nonEmptyStringSchema,
    transformation: nonEmptyStringSchema,
    constraints: stringArraySchema,
    examples: z
      .array(
        z
          .object({
            before: nonEmptyStringSchema,
            after: nonEmptyStringSchema,
            reason: nonEmptyStringSchema,
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
