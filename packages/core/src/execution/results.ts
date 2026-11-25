import { z } from "zod";

import { AquariusError, toRunError } from "../shared/errors";
import { safeRelativePath } from "../shared/path";
import type { PathPolicy } from "../files/types";
import type { PreparedRule } from "../rules/types";
import type { RunError, SkippedRule } from "../shared/types";

import { fileResultSchema } from "./schemas";
import type { FileResult, ReviewResponse } from "./types";

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
  const fieldEntries = arrays.map((key) => [key, z.array(z.unknown())] as const);
  const fields = Object.fromEntries(fieldEntries);
  const envelopeSchema = z.strictObject(fields);

  const parsed = envelopeSchema.safeParse(value);
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
  const referenceSchema = z.array(z.string());
  const parsed = referenceSchema.safeParse(value);
  const invalidReferences =
    !parsed.success ||
    (!allowEmpty && parsed.data.length === 0) ||
    parsed.data.some((id) => !known.has(id)) ||
    new Set(parsed.data).size !== parsed.data.length;
  if (invalidReferences) {
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
  if (!safeRelativePath(value)) {
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

  const readCompletedRuleIds = (): string[] => {
    try {
      return references(items, known, true);
    } catch (cause) {
      errors.push(toRunError(cause, "INVALID_COMPLETION"));
      return [];
    }
  };

  const completed = readCompletedRuleIds();
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

export const RETRYABLE_INCOMPLETE_CODES: ReadonlySet<string> = new Set([
  "INCOMPLETE_AI_RESPONSE",
  "INCOMPLETE_FILE_RESULTS",
  "INCOMPLETE_FILE_REVIEW",
]);

export const hasFailedReview = ({ errors, fileResults }: ReviewResponse): boolean =>
  errors.length > 0 || fileResults.some(({ status }) => status === "failed");

export const beginResponseNormalization = (
  raw: unknown,
  rules: readonly PreparedRule[],
  policy: PathPolicy,
  toolFields: string[],
) => {
  const knownRules = new Set(rules.map(({ id }) => id));
  const targets = new Set(policy.targets);
  const errors: RunError[] = [];
  const reported = new Map<string, FileResult>();
  const failures = new Map<string, string>();
  const skippedRuleIds = new Set<string>();
  let skippedRules: SkippedRule[] = [];
  let globalFailure: string | undefined;
  let unexplainedFailure = false;
  let body: Record<string, unknown[]> | undefined;

  const recordItemError = (error: RunError, paths: readonly string[]): void => {
    errors.push(error);
    const affected = paths.filter((path) => targets.has(path));
    if (affected.length === 0) {
      globalFailure ??= error.message;
      return;
    }

    for (const path of affected) failures.set(path, error.message);
  };

  const finish = (): ReviewResponse => {
    const allSkipped = rules.length > 0 && skippedRules.length === rules.length;
    const finalizeFileResult = (path: string): FileResult => {
      const failure = globalFailure ?? failures.get(path);
      if (failure) return { path, status: "failed", reason: failure };
      const file = reported.get(path)!;
      if (allSkipped && file.status === "completed") {
        return { path, status: "skipped", reason: "No requested rule applies." };
      }
      return file;
    };

    return {
      errors,
      skippedRules,
      fileResults: policy.targets.map(finalizeFileResult),
      retryable:
        errors.length > 0 &&
        errors.every(({ code }) => RETRYABLE_INCOMPLETE_CODES.has(code)) &&
        !unexplainedFailure,
    };
  };

  try {
    body = resultEnvelope(raw, [
      "completedRuleIds",
      "skippedRules",
      "errors",
      "fileResults",
      ...toolFields,
    ]);
  } catch (cause) {
    recordItemError(toRunError(cause), []);
    return { body, knownRules, skippedRuleIds, reported, recordItemError, finish };
  }

  collectErrors(body.errors!, knownRules, errors);
  skippedRules = checkCompletion(body.completedRuleIds!, body.skippedRules!, knownRules, errors);
  const completionErrors = [...errors];

  for (const item of body.skippedRules!) {
    if (
      typeof item === "object" &&
      item !== null &&
      "ruleId" in item &&
      typeof item.ruleId === "string" &&
      knownRules.has(item.ruleId)
    ) {
      skippedRuleIds.add(item.ruleId);
    }
  }

  const seen = new Set<string>();
  for (const item of body.fileResults!) {
    const path =
      typeof item === "object" &&
      item !== null &&
      "path" in item &&
      typeof item.path === "string" &&
      targets.has(item.path)
        ? item.path
        : undefined;

    try {
      if (path !== undefined && seen.has(path)) {
        throw new AquariusError(
          "DUPLICATE_FILE_RESULT",
          `More than one processing result was returned for ${path}.`,
        );
      }
      if (path !== undefined) seen.add(path);

      const file = parseResultItem(fileResultSchema, item, "file processing result");
      normalizedPath(file.path);
      if (!targets.has(file.path)) {
        throw new AquariusError(
          "INVALID_RESULT_PATH",
          `File processing result is outside the selected targets: ${file.path}`,
        );
      }

      if (file.status !== "completed") nonempty(file.reason, "File processing reason");
      reported.set(file.path, file);
    } catch (cause) {
      const error = toRunError(cause, "INVALID_FILE_RESULT");
      errors.push(error);
      if (path) failures.set(path, error.message);
    }
  }

  for (const path of targets) {
    if (reported.has(path) || failures.has(path)) continue;
    const message = `AI did not report a processing result for ${path}.`;
    recordItemError({ code: "INCOMPLETE_FILE_RESULTS", message, ruleIds: [] }, [path]);
  }

  const hasFailedFiles = [...reported.values()].some(({ status }) => status === "failed");
  const hasUnfinishedFiles = failures.size > 0 || hasFailedFiles;
  globalFailure ??= completionErrors.find(
    ({ code }) => code !== "INCOMPLETE_FILE_REVIEW" || !hasUnfinishedFiles,
  )?.message;
  unexplainedFailure =
    hasFailedFiles &&
    !completionErrors.some(
      ({ code }) => code === "INCOMPLETE_FILE_REVIEW" || code === "INCOMPLETE_AI_RESPONSE",
    );

  return { body, knownRules, skippedRuleIds, reported, recordItemError, finish };
};
