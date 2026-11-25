import type { FormatInstructions, FormatRule } from "@aquarius/core";
import { z } from "zod";

export const nonEmptyStringSchema = z.string().refine((value) => value.trim() !== "", {
  message: "must be a non-empty string",
});

export const nonEmptyStringArraySchema = z.array(nonEmptyStringSchema).min(1);

export const pathPatternSchema = nonEmptyStringSchema.refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split(/[\\/]/u).includes(".."),
  { message: "must be a project-relative path pattern" },
);

export const pathPatternArraySchema = z.array(pathPatternSchema);

export const intRangeSchema = (min: number, max?: number) => {
  const schema = z.int().min(min);
  return max === undefined ? schema : schema.max(max);
};

export const stringKeyRecordSchema = <Value extends z.ZodType>(value: Value) => {
  const entrySchema = z.tuple([nonEmptyStringSchema, value]);

  // Zod's record parser drops own __proto__ entries when rebuilding an object.
  return z
    .custom<Record<string, z.output<Value>>>((input) => {
      if (typeof input !== "object" || input === null) return false;
      const prototype: unknown = Object.getPrototypeOf(input);
      return prototype === Object.prototype || prototype === null;
    }, "must be a record")
    .superRefine((record, context) => {
      for (const entry of Object.entries(record)) {
        const parsed = entrySchema.safeParse(entry);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            context.addIssue({ ...issue, path: [entry[0], ...issue.path.slice(1)] });
          }
        }
      }
    });
};

export const nonEmptyRecordSchema = <Value extends z.ZodType>(value: Value) =>
  stringKeyRecordSchema(value).refine((record) => Object.keys(record).length > 0, {
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

export const buildInstructions = ({
  applicability,
  transformation,
  constraints,
  examples,
}: Omit<FormatInstructions, "constraints"> & {
  constraints?: readonly string[];
}): FormatInstructions => {
  if (!applicability.trim() || /[\r\n]/u.test(applicability) || applicability.length > 160) {
    throw new Error(
      "Format applicability must be a non-empty single line of at most 160 characters",
    );
  }
  return {
    applicability,
    transformation,
    constraints: [...COMMON_FORMAT_INVARIANTS, ...(constraints ?? [])],
    ...(examples && { examples: examples.map((example) => ({ ...example })) }),
  };
};

export const createFormatRule = <Schema extends z.ZodType>({
  buildPrompt,
  ...definition
}: Omit<FormatRule, "optionsSchema" | "buildPrompt"> & {
  optionsSchema: Schema;
  buildPrompt: (options: z.output<Schema>) => Parameters<typeof buildInstructions>[0];
}): FormatRule => ({
  ...definition,
  // Core validates options against this schema before calling buildPrompt.
  buildPrompt: ({ options }) => buildInstructions(buildPrompt(options as z.output<Schema>)),
});
