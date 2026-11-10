import { isAbsolute } from "node:path";
import { z } from "zod";
import { AquariusError, toRunError } from "../shared/errors";
import type { RunError, SkippedRule } from "../shared/types";

export const errorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  ruleIds: z.array(z.string()),
});

export const skippedRuleSchema = z.strictObject({
  ruleId: z.string(),
  reason: z.string(),
});

export const parseResultItem = <T>(schema: z.ZodType<T>, value: unknown, name: string): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AquariusError(
      "INVALID_AI_ITEM",
      `Invalid ${name} structure: ${parsed.error.message}`,
    );
  }
  return parsed.data;
};

export const resultEnvelope = (value: unknown, arrays: string[]): Record<string, unknown[]> => {
  const fields = Object.fromEntries(arrays.map((key) => [key, z.array(z.unknown())]));
  const parsed = z.strictObject(fields).safeParse(value);
  if (!parsed.success) {
    throw new AquariusError(
      "INVALID_AI_RESPONSE",
      "AI response must contain only the expected result arrays.",
    );
  }
  return parsed.data;
};

export const references = (
  value: unknown,
  known: Set<string>,
  allowEmpty = false,
  skipped?: ReadonlySet<string>,
): string[] => {
  const parsed = z.array(z.string()).safeParse(value);
  if (
    !parsed.success ||
    (!allowEmpty && parsed.data.length === 0) ||
    parsed.data.some((id) => !known.has(id)) ||
    new Set(parsed.data).size !== parsed.data.length
  ) {
    throw new AquariusError(
      "INVALID_RULE_REFERENCE",
      "AI result contains an unknown, repeated, or missing rule reference.",
    );
  }
  if (parsed.data.some((id) => skipped?.has(id))) {
    throw new AquariusError(
      "CONFLICTING_RULE_RESULT",
      "A rule reported as not applicable also has a finding or change.",
    );
  }
  return parsed.data;
};

export const nonempty = (value: string, label: string): void => {
  if (value.trim() === "")
    throw new AquariusError("INVALID_AI_ITEM", `${label} must not be empty.`);
};

export const normalizedPath = (value: string): string => {
  const segments = value.split("/");
  if (
    value === "" ||
    value.includes("\\") ||
    value.includes(":") ||
    /[\u0000-\u001f]/u.test(value) ||
    isAbsolute(value) ||
    segments.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new AquariusError(
      "INVALID_RESULT_PATH",
      "AI result path must be a normalized project-relative file path.",
    );
  }
  return value;
};

export const collectErrors = (items: unknown[], known: Set<string>, output: RunError[]): void => {
  for (const item of items) {
    try {
      const supplied = parseResultItem(errorSchema, item, "execution error");
      const ruleIds = references(supplied.ruleIds, known, true);
      nonempty(supplied.code, "Error code");
      nonempty(supplied.message, "Error message");
      output.push({ code: supplied.code, message: supplied.message, ruleIds });
    } catch (cause) {
      output.push(toRunError(cause, "INVALID_EXECUTION_ERROR"));
    }
  }
};

export const checkCompletion = (
  items: unknown[],
  skippedItems: unknown[],
  known: Set<string>,
  errors: RunError[],
): SkippedRule[] => {
  const projectFailed = errors.some(({ ruleIds }) => ruleIds.length === 0);
  const failed = new Set(errors.flatMap((entry) => entry.ruleIds));
  let completed: string[];
  try {
    completed = references(items, known, true);
  } catch (cause) {
    errors.push(toRunError(cause, "INVALID_COMPLETION"));
    completed = [];
  }
  const completedSet = new Set(completed);
  const conflicting = completed.filter((id) => failed.has(id));
  if (conflicting.length > 0) {
    errors.push({
      code: "CONFLICTING_RULE_RESULT",
      message: "A rule cannot be both completed and failed.",
      ruleIds: conflicting,
    });
  }

  const skipped = new Map<string, SkippedRule>();
  const seen = new Set<string>();
  for (const item of skippedItems) {
    try {
      const supplied = parseResultItem(skippedRuleSchema, item, "skipped rule");
      references([supplied.ruleId], known);
      if (seen.has(supplied.ruleId)) {
        skipped.delete(supplied.ruleId);
        throw new AquariusError(
          "DUPLICATE_SKIPPED_RULE",
          `More than one not-applicable result was returned for ${supplied.ruleId}.`,
        );
      }
      seen.add(supplied.ruleId);
      nonempty(supplied.reason, "Skipped rule reason");
      if (completedSet.has(supplied.ruleId) || failed.has(supplied.ruleId)) {
        throw new AquariusError(
          "CONFLICTING_RULE_RESULT",
          `A skipped rule cannot also be completed or failed: ${supplied.ruleId}.`,
        );
      }
      skipped.set(supplied.ruleId, supplied);
    } catch (cause) {
      errors.push(toRunError(cause, "INVALID_SKIPPED_RULE"));
    }
  }

  const accounted = new Set([...completed, ...failed, ...skipped.keys()]);
  const missing = [...known].filter((id) => !accounted.has(id));
  if (missing.length && !projectFailed) {
    errors.push({
      code: "INCOMPLETE_AI_RESPONSE",
      message: "AI did not complete all requested rules.",
      ruleIds: missing,
    });
  }
  return [...skipped.values()];
};
