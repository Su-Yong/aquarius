import { z } from "zod";
import { fileChangeSchema } from "@aquarius/core/internal";
export { fileChangeSchema } from "@aquarius/core/internal";
import { errorSchema, skippedRuleSchema } from "@aquarius/core/internal";
import type { JsonObject } from "@aquarius/core/internal";

const ruleIdsSchema = z.array(z.string());

export const formatWarningSchema = z.strictObject({
  code: z.string(),
  ruleIds: ruleIdsSchema,
  message: z.string(),
  paths: z.array(z.string()),
});

export const formatFileResultSchema = z.strictObject({
  path: z.string(),
  status: z.enum(["completed", "skipped", "failed"]),
  reason: z.string(),
});

const reviewStatusSchema = z.enum(["pending", "in_progress", "completed", "skipped", "failed"]);

export const formatAnalysisUpdateSchema = z.strictObject({
  type: z.literal("aquarius.analysis_update"),
  revision: z.number().int().positive(),
  fileResults: z.array(
    z.strictObject({ path: z.string(), status: reviewStatusSchema, reason: z.string() }),
  ),
  ruleResults: z.array(
    z.strictObject({ ruleId: z.string(), status: reviewStatusSchema, reason: z.string() }),
  ),
  proposedFiles: z.array(z.string()),
  warnings: z.array(formatWarningSchema),
});

export const formatResponseSchema = z.strictObject({
  completedRuleIds: z.array(z.string()),
  skippedRules: z.array(skippedRuleSchema),
  changes: z.array(fileChangeSchema),
  warnings: z.array(formatWarningSchema),
  errors: z.array(errorSchema),
  fileResults: z.array(formatFileResultSchema),
});

export const formatResponseJsonSchema = z.toJSONSchema(formatResponseSchema) as JsonObject;

export type FileChange = z.infer<typeof fileChangeSchema>;
export type FormatWarning = z.infer<typeof formatWarningSchema>;
export type FormatFileResult = z.infer<typeof formatFileResultSchema>;
export type FormatAnalysisUpdate = z.infer<typeof formatAnalysisUpdateSchema>;
