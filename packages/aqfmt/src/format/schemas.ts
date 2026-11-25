import { z } from "zod";
import {
  errorSchema,
  fileResultSchema,
  reviewUpdateFields,
  skippedRuleSchema,
  type JsonObject,
} from "@aqtools/core/runtime";

import { fileChangeSchema } from "../changes/schema";

export type FormatWarning = z.infer<typeof formatWarningSchema>;
export type FormatAnalysisUpdate = z.infer<typeof formatAnalysisUpdateSchema>;

export const formatWarningSchema = z.strictObject({
  code: z.string(),
  ruleIds: z.array(z.string()),
  message: z.string(),
  paths: z.array(z.string()),
});

export const formatAnalysisUpdateSchema = z.strictObject({
  ...reviewUpdateFields,
  proposedFiles: z.array(z.string()),
  warnings: z.array(formatWarningSchema),
});

export const formatResponseSchema = z.strictObject({
  completedRuleIds: z.array(z.string()),
  skippedRules: z.array(skippedRuleSchema),
  changes: z.array(fileChangeSchema),
  warnings: z.array(formatWarningSchema),
  errors: z.array(errorSchema),
  fileResults: z.array(fileResultSchema),
});

export const formatResponseJsonSchema = z.toJSONSchema(formatResponseSchema) as JsonObject;
