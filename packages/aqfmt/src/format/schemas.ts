import { z } from "zod";
import { fileChangeSchema } from "@aquarius/core/internal";
export { fileChangeSchema } from "@aquarius/core/internal";
import { errorSchema } from "@aquarius/core/internal";
import type { JsonObject } from "@aquarius/core/internal";

const ruleIdsSchema = z.array(z.string());

export const formatWarningSchema = z.strictObject({
  code: z.string(),
  ruleIds: ruleIdsSchema,
  message: z.string(),
  paths: z.array(z.string()),
});

export const formatResponseSchema = z.strictObject({
  completedRuleIds: z.array(z.string()),
  changes: z.array(fileChangeSchema),
  warnings: z.array(formatWarningSchema),
  errors: z.array(errorSchema),
});

export const formatResponseJsonSchema = z.toJSONSchema(formatResponseSchema) as JsonObject;

export type FileChange = z.infer<typeof fileChangeSchema>;
export type FormatWarning = z.infer<typeof formatWarningSchema>;
