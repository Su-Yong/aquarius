import { z } from "zod";
import { errorSchema } from "@aquarius/core/internal";

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

export const unknownSchema = z.strictObject({
  ruleIds: z.array(z.string()),
  message: z.string(),
  locations: z.array(sourceLocationSchema),
});

export const lintResponseSchema = z.strictObject({
  completedRuleIds: z.array(z.string()),
  diagnostics: z.array(diagnosticSchema),
  unknowns: z.array(unknownSchema),
  errors: z.array(errorSchema),
});

export type SourceLocation = z.infer<typeof sourceLocationSchema>;
export type EvidenceLocation = z.infer<typeof evidenceLocationSchema>;
export type AiDiagnostic = z.infer<typeof diagnosticSchema>;
export type UnknownFinding = z.infer<typeof unknownSchema>;
