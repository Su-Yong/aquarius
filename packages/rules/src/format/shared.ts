import { z } from "zod";

import type { FormatInstructions, FormatRule } from "@aquarius/core";

const MAX_APPLICABILITY_LENGTH = 160;

export const nonEmptyStringSchema = z.string().refine((value) => value.trim() !== "", {
  message: "must be a non-empty string",
});

export const nonEmptyStringArraySchema = z.array(nonEmptyStringSchema).min(1);

export const pathPatternSchema = nonEmptyStringSchema.refine(isProjectRelativePathPattern, {
  message: "must be a project-relative path pattern",
});

export const pathPatternArraySchema = z.array(pathPatternSchema);

export const intRangeSchema = (min: number, max?: number) => {
  const minimumSchema = z.int().min(min);
  return max === undefined ? minimumSchema : minimumSchema.max(max);
};

export const stringKeyRecordSchema = <Value extends z.ZodType>(valueSchema: Value) => {
  const entrySchema = z.tuple([nonEmptyStringSchema, valueSchema]);

  // Zod's record parser drops own __proto__ entries when rebuilding an object.
  const recordSchema = z.custom<Record<string, z.output<Value>>>((input) => {
    if (typeof input !== "object" || input === null) return false;
    const prototype: unknown = Object.getPrototypeOf(input);
    return prototype === Object.prototype || prototype === null;
  }, "must be a record");
  type RecordRefinement = Parameters<typeof recordSchema.superRefine>[0];
  const validateRecordEntries: RecordRefinement = (record, context) => {
    for (const entry of Object.entries(record)) {
      const parsedEntry = entrySchema.safeParse(entry);
      if (parsedEntry.success) continue;
      for (const issue of parsedEntry.error.issues) {
        context.addIssue({ ...issue, path: [entry[0], ...issue.path.slice(1)] });
      }
    }
  };
  return recordSchema.superRefine(validateRecordEntries);
};

export const nonEmptyRecordSchema = <Value extends z.ZodType>(valueSchema: Value) =>
  stringKeyRecordSchema(valueSchema).refine((record) => Object.keys(record).length > 0, {
    message: "must define at least one entry",
  });

export const fileOverrideSchema = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.strictObject({ ...shape, files: pathPatternArraySchema.min(1) });

export const COMMON_FORMAT_INVARIANTS = [
  "Preserve observable behavior, including return values, exception type and timing, short-circuit evaluation, side-effect order, resource cleanup, public APIs, and serialization contracts.",
  "If a configured option or policy conflicts with behavior preservation, leave the code unchanged and report only a warning for that candidate.",
  "Tie-breaker: preserve the existing code form and relative order wherever options leave a choice unspecified or multiple candidates tie. Leave conforming code unchanged.",
  "Follow the target language and project conventions. Apply only constructs supported by that language and project.",
] as const;

export const createFormatRule = <Schema extends z.ZodType>({
  buildPrompt,
  ...definition
}: Omit<FormatRule, "optionsSchema" | "buildPrompt"> & {
  optionsSchema: Schema;
  buildPrompt: (options: z.output<Schema>) => Parameters<typeof buildInstructions>[0];
}): FormatRule => ({
  ...definition,
  // Core validates options against this schema before calling buildPrompt.
  buildPrompt: ({ options }) => {
    const prompt = buildPrompt(options as z.output<Schema>);
    return buildInstructions(prompt);
  },
});

export const buildInstructions = ({
  applicability,
  transformation,
  constraints,
  examples,
}: Omit<FormatInstructions, "constraints"> & {
  constraints?: readonly string[];
}): FormatInstructions => {
  const isInvalidApplicability =
    !applicability.trim() ||
    /[\r\n]/u.test(applicability) ||
    applicability.length > MAX_APPLICABILITY_LENGTH;
  if (isInvalidApplicability) {
    throw new Error(
      `Format applicability must be a non-empty single line of at most ${MAX_APPLICABILITY_LENGTH} characters`,
    );
  }
  return {
    applicability,
    transformation,
    constraints: [...COMMON_FORMAT_INVARIANTS, ...(constraints ?? [])],
    ...(examples && { examples: examples.map((example) => ({ ...example })) }),
  };
};

function isProjectRelativePathPattern(value: string): boolean {
  const isRelativePattern =
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split(/[\\/]/u).includes("..");
  return isRelativePattern;
}
