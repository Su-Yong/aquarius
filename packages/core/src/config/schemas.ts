import { z } from "zod";

const nonEmptyStringSchema = z.string().refine((value) => value.trim() !== "", {
  message: "must be a non-empty string",
});

const jsonObjectSchema = z.record(z.string(), z.json());
const severitySchema = z.enum(["off", "warn", "error"]);

export const ruleSettingSchema = z.union([
  severitySchema,
  z.tuple([severitySchema, jsonObjectSchema]),
  z.boolean(),
  jsonObjectSchema,
]);

export const ruleSettingsSchema = z.record(nonEmptyStringSchema, ruleSettingSchema);

export const projectConfigSchema = z
  .object({
    files: z.array(nonEmptyStringSchema).optional(),
    ignore: z.array(nonEmptyStringSchema).optional(),
    plugins: z.array(nonEmptyStringSchema).optional(),
    preset: z.array(nonEmptyStringSchema).optional(),
    ai: z
      .object({
        adapter: nonEmptyStringSchema,
        options: jsonObjectSchema.optional(),
        timeoutMs: z
          .number()
          .int({ message: "must be a positive integer" })
          .positive({ message: "must be a positive integer" })
          .optional(),
        fileBatchSize: z.number().int().positive().optional(),
        maxConcurrency: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    rules: ruleSettingsSchema.optional(),
  })
  .strict();

export const formatZodIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "configuration";
      if (issue.code === "unrecognized_keys") {
        return `${path} contains unknown field(s): ${issue.keys.join(", ")}`;
      }
      return `${path} ${issue.message}`;
    })
    .join("; ");
