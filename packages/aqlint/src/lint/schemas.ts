import { z } from "zod";
import {
  errorSchema,
  fileResultSchema,
  reviewUpdateFields,
  skippedRuleSchema,
} from "@aquarius/core/runtime";

export const sourceLocationSchema = z.strictObject({
  path: z.string(),
  line: z.number().int(),
  column: z.number().int(),
});

export const evidenceLocationSchema = z.strictObject({
  path: z.string(),
  line: z.number().int(),
  message: z.string(),
});

export const diagnosticSchema = z.strictObject({
  ruleIds: z.array(z.string()),
  message: z.string(),
  locations: z.array(sourceLocationSchema),
  evidence: z.array(evidenceLocationSchema),
});

const updateIdSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "must be a non-empty identifier",
});

export const analysisUpdateSchema = z.strictObject({
  ...reviewUpdateFields,
  diagnostics: z.array(
    z.strictObject({ id: updateIdSchema, diagnostic: diagnosticSchema.nullable() }),
  ),
});

export const lintResponseSchema = z.strictObject({
  completedRuleIds: z.array(z.string()),
  skippedRules: z.array(skippedRuleSchema),
  diagnostics: z.array(diagnosticSchema),
  errors: z.array(errorSchema),
  fileResults: z.array(fileResultSchema),
});

export type SourceLocation = z.infer<typeof sourceLocationSchema>;
export type EvidenceLocation = z.infer<typeof evidenceLocationSchema>;
export type AiDiagnostic = z.infer<typeof diagnosticSchema>;
export type FileResult = z.infer<typeof fileResultSchema>;
export type AnalysisUpdate = z.infer<typeof analysisUpdateSchema>;
