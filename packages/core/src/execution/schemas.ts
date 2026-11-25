import { z } from "zod";

export const fileResultSchema = z.strictObject({
  path: z.string(),
  status: z.enum(["completed", "skipped", "failed"]),
  reason: z.string(),
});

const reviewStatus = z.enum(["pending", "in_progress", ...fileResultSchema.shape.status.options]);

export const reviewUpdateFields = {
  type: z.literal("aquarius.analysis_update"),
  revision: z.number().int().positive(),
  fileResults: z
    .array(
      z.strictObject({ path: z.string(), status: reviewStatus, reason: z.string().default("") }),
    )
    .default([]),
  ruleResults: z
    .array(
      z.strictObject({ ruleId: z.string(), status: reviewStatus, reason: z.string().default("") }),
    )
    .default([]),
};
