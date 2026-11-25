import { z } from "zod";

import { AquariusError } from "../shared/errors";
import { formatZodIssues } from "../shared/zod";
import type { JsonObject } from "../shared/types";

const selectionSchema = z.strictObject({ categories: z.array(z.string()) });

// Keep dynamic rule options in JSON text so the adapter's structured schema stays closed.
const verdictSchema = z.strictObject({
  ruleId: z.string(),
  status: z.enum(["observed", "insufficient_evidence"]),
  settingJson: z.string().nullable(),
  reason: z.string(),
  mixed: z.boolean(),
  observations: z.string().nullable(),
});
const verdictsSchema = z.strictObject({ verdicts: z.array(verdictSchema) });

export const selectionOutputSchema = z.toJSONSchema(selectionSchema) as JsonObject;
export const verdictsOutputSchema = z.toJSONSchema(verdictsSchema) as JsonObject;

export type ExtractionVerdict = Omit<z.infer<typeof verdictSchema>, "settingJson"> & {
  setting: unknown;
};

export const parseSelection = (response: unknown): string[] =>
  parseResponse(selectionSchema, response).categories;

export const parseVerdicts = (response: unknown): ExtractionVerdict[] =>
  parseResponse(verdictsSchema, response).verdicts.map(({ settingJson, ...verdict }) => ({
    ...verdict,
    setting: parseSetting(settingJson),
  }));

const parseResponse = <T>(schema: z.ZodType<T>, response: unknown): T => {
  const parsed = schema.safeParse(response);
  if (!parsed.success) {
    throw new AquariusError(
      "EXTRACT_RESPONSE_INVALID",
      formatZodIssues(parsed.error, "AI response"),
    );
  }
  return parsed.data;
};

const parseSetting = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
