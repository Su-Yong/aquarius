import { z } from "zod";

const ruleIdsSchema = z.array(z.string());

export const fileChangeSchema = z.union([
  z.strictObject({
    op: z.literal("replace"),
    path: z.string(),
    patch: z.string(),
    ruleIds: ruleIdsSchema,
  }),
  z.strictObject({
    op: z.literal("create"),
    path: z.string(),
    content: z.string(),
    ruleIds: ruleIdsSchema,
  }),
  z.strictObject({
    op: z.literal("delete"),
    path: z.string(),
    ruleIds: ruleIdsSchema,
  }),
  z.strictObject({
    op: z.literal("move"),
    from: z.string(),
    to: z.string(),
    ruleIds: ruleIdsSchema,
  }),
]);

export type FileChange = z.infer<typeof fileChangeSchema>;
export type ReplaceChange = Extract<FileChange, { op: "replace" }>;
