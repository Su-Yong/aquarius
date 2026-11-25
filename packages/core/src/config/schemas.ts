import { z } from "zod";
import { formatRuleSettingSchema, lintRuleSettingSchema } from "../rules/schemas";
import { jsonObjectSchema, nonEmptyStringSchema } from "../shared/zod";

const commonConfigShape = {
  files: z.array(nonEmptyStringSchema).optional(),
  ignore: z.array(nonEmptyStringSchema).optional(),
  plugins: z.array(nonEmptyStringSchema).optional(),
  preset: z.array(nonEmptyStringSchema).optional(),
  ai: z
    .strictObject({
      adapter: nonEmptyStringSchema.optional(),
      options: jsonObjectSchema.optional(),
      timeoutMs: z
        .number()
        .int({ message: "must be a positive integer" })
        .positive({ message: "must be a positive integer" })
        .optional(),
      fileBatchSize: z.number().int().positive().optional(),
      maxConcurrency: z.number().int().positive().optional(),
    })
    .optional(),
};

export const lintConfigSchema = z.strictObject({
  ...commonConfigShape,
  rules: z.record(nonEmptyStringSchema, lintRuleSettingSchema).optional(),
});

export const formatConfigSchema = z.strictObject({
  ...commonConfigShape,
  rules: z.record(nonEmptyStringSchema, formatRuleSettingSchema).optional(),
});
