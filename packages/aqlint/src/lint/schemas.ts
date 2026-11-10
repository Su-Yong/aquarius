import { z } from "zod";
import { errorSchema, skippedRuleSchema } from "@aquarius/core/internal";

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

export const fileResultSchema = z.strictObject({
  path: z.string(),
  status: z.enum(["completed", "skipped", "failed"]),
  reason: z.string(),
});

const updateIdSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "must be a non-empty identifier",
});

const reviewStatusSchema = z.enum(["pending", "in_progress", "completed", "skipped", "failed"]);

export const analysisUpdateSchema = z.strictObject({
  type: z.literal("aquarius.analysis_update"),
  revision: z.number().int().positive(),
  diagnostics: z.array(
    z.strictObject({ id: updateIdSchema, diagnostic: diagnosticSchema.nullable() }),
  ),
  fileResults: z.array(
    z.strictObject({ path: z.string(), status: reviewStatusSchema, reason: z.string() }),
  ),
  ruleResults: z.array(
    z.strictObject({ ruleId: z.string(), status: reviewStatusSchema, reason: z.string() }),
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
