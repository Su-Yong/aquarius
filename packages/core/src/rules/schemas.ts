import { z } from "zod";
import type {
  FormatRule,
  LintRule,
} from "./types";

const nonEmptyStringSchema = z.string().refine((value) => value.trim() !== "", {
  message: "must be a non-empty string",
});

const stringArraySchema = z.array(nonEmptyStringSchema);
const jsonObjectSchema = z.record(z.string(), z.json());
const scopeSchema = z.enum(["file", "module", "project"]);
const optionsSchema = z.custom<z.ZodType>((value) => (
  value !== null
  && typeof value === "object"
  && "safeParse" in value
  && typeof value.safeParse === "function"
), "must be a Zod schema");
const buildPromptSchema = z.custom<LintRule["buildPrompt"] | FormatRule["buildPrompt"]>(
  (value) => typeof value === "function",
  "must be a function",
);

const ruleBaseShape = {
  id: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  scope: scopeSchema,
  optionsSchema: optionsSchema.optional(),
  defaultOptions: jsonObjectSchema.optional(),
  buildPrompt: buildPromptSchema,
};

export const lintRuleSchema = z.object({
  ...ruleBaseShape,
  defaultSeverity: z.enum(["warn", "error"]),
}).strict();

export const formatRuleSchema = z.object(ruleBaseShape).strict();

export const rulePluginShapeSchema = z.object({
  namespace: nonEmptyStringSchema,
  lintRules: z.array(z.unknown()).optional(),
  formatRules: z.array(z.unknown()).optional(),
}).strict();

export const lintInstructionsSchema = z.object({
  applicability: nonEmptyStringSchema,
  criteria: nonEmptyStringSchema,
  evidenceRequirements: stringArraySchema,
  exceptions: stringArraySchema.optional(),
  procedure: stringArraySchema.optional(),
  examples: z.array(z.object({
    scenario: nonEmptyStringSchema,
    expected: z.enum(["pass", "violation", "unknown", "not_applicable"]),
    reason: nonEmptyStringSchema,
  }).strict()).optional(),
}).strict();

export const formatInstructionsSchema = z.object({
  applicability: nonEmptyStringSchema,
  transformation: nonEmptyStringSchema,
  constraints: stringArraySchema,
  examples: z.array(z.object({
    before: nonEmptyStringSchema,
    after: nonEmptyStringSchema,
    reason: nonEmptyStringSchema,
  }).strict()).optional(),
}).strict();

export const formatRuleZodIssues = (error: z.ZodError): string => error.issues.map((issue) => {
  const path = issue.path.length > 0 ? issue.path.join(".") : "value";
  if (issue.code === "unrecognized_keys") {
    return `${path} contains unknown field(s): ${issue.keys.join(", ")}`;
  }
  return `${path} ${issue.message}`;
}).join("; ");
