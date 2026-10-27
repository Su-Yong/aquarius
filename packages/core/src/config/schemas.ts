import { z } from "zod";

const nonEmptyStringSchema = z.string().refine((value) => value.trim() !== "", {
  message: "must be a non-empty string",
});

const jsonObjectSchema = z.record(z.string(), z.json());

export const ruleSelectionSchema = z.object({
  rule: nonEmptyStringSchema,
  severity: z.enum(["off", "warn", "error"]).optional(),
  options: jsonObjectSchema.optional(),
}).strict();

export const projectConfigSchema = z.object({
  files: z.array(nonEmptyStringSchema).optional(),
  ignore: z.array(nonEmptyStringSchema).optional(),
  plugins: z.array(nonEmptyStringSchema).optional(),
  ai: z.object({
    adapter: nonEmptyStringSchema.optional(),
    options: jsonObjectSchema.optional(),
    timeoutMs: z.number()
      .int({ message: "must be a positive integer" })
      .positive({ message: "must be a positive integer" })
      .optional(),
  }).strict().optional(),
  rules: z.array(ruleSelectionSchema).optional(),
}).strict();

export const formatZodIssues = (error: z.ZodError): string => error.issues.map((issue) => {
  const path = issue.path.length > 0 ? issue.path.join(".") : "configuration";
  if (issue.code === "unrecognized_keys") {
    return `${path} contains unknown field(s): ${issue.keys.join(", ")}`;
  }
  return `${path} ${issue.message}`;
}).join("; ");
