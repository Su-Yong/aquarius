import {
  AquariusError,
  checkCompletion,
  collectErrors,
  nonempty,
  normalizedPath,
  parseResultItem,
  references,
  resultEnvelope,
  toRunError,
} from "@aquarius/core/internal";
import type { PathPolicy, PreparedRule, RuleResources, RunError } from "@aquarius/core/internal";
import {
  fileChangeSchema,
  formatFileResultSchema,
  formatResponseSchema,
  formatWarningSchema,
} from "./schemas";
import type {
  FileChange,
  FormatFileResult,
  FormatResponse,
  FormatSummary,
  FormatWarning,
} from "./types";

const incompleteCodes = new Set([
  "INCOMPLETE_AI_RESPONSE",
  "INCOMPLETE_FILE_RESULTS",
  "INCOMPLETE_FILE_REVIEW",
]);

export const formatChangePaths = (changes: readonly FileChange[]): string[] =>
  [
    ...new Set(
      changes.flatMap((change) =>
        change.op === "move" ? [change.from, change.to] : [change.path],
      ),
    ),
  ].sort();

export const summarizeFormatResult = (
  fileResults: readonly FormatFileResult[],
  activeRules: number,
  totalFiles: number | null = fileResults.length,
): FormatSummary => {
  const summary: FormatSummary = {
    totalFiles,
    completedFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    activeRules,
  };
  for (const file of fileResults) {
    if (file.status === "completed") summary.completedFiles += 1;
    else if (file.status === "skipped") summary.skippedFiles += 1;
    else summary.failedFiles += 1;
  }
  return summary;
};

export const createFormatValidator = (
  rules: readonly PreparedRule[],
  policy: PathPolicy,
  ruleResources: RuleResources,
) => {
  const known = new Set(rules.map(({ id }) => id));
  const targets = new Set(policy.targets);
  const fileOnly = rules.every(({ scope }) => scope === "file");
  const resourceDirectories = new Set(
    ruleResources.files.map(({ detailsPath }) => detailsPath.split("/")[0]!.toLowerCase()),
  );
  const internalPath = (path: string): boolean =>
    resourceDirectories.has(path.split("/")[0]!.toLowerCase());

  const proposedPath = (path: string): string => {
    normalizedPath(path);
    if (internalPath(path) || !policy.canWrite(path) || (fileOnly && !targets.has(path))) {
      throw new AquariusError(
        "CHANGE_OUTSIDE_SCOPE",
        "Change is outside the selected scope: " + path,
      );
    }
    return path;
  };

  return {
    proposedPath,
    change: (input: unknown): FileChange => {
      const change = parseResultItem(fileChangeSchema, input, "file change");
      references(change.ruleIds, known);
      for (const path of formatChangePaths([change])) proposedPath(path);
      if (fileOnly && change.op !== "replace") {
        throw new AquariusError(
          "CHANGE_OUTSIDE_SCOPE",
          "File-scoped rules may only replace text in their assigned existing target files.",
        );
      }
      if (change.op !== "create") {
        const source = change.op === "move" ? change.from : change.path;
        if (!targets.has(source)) {
          throw new AquariusError(
            "CHANGE_OUTSIDE_SCOPE",
            "Existing-file changes require a selected target: " + source,
          );
        }
      }
      return change;
    },
    warning: (input: unknown): FormatWarning => {
      const warning = parseResultItem(formatWarningSchema, input, "format warning");
      references(warning.ruleIds, known, true);
      nonempty(warning.code, "Warning code");
      nonempty(warning.message, "Warning message");
      for (const path of warning.paths) {
        normalizedPath(path);
        if (internalPath(path) || policy.isIgnored(path)) {
          throw new AquariusError(
            "INVALID_RESULT_PATH",
            "Warning references an ignored path or internal rule resources.",
          );
        }
      }
      return warning;
    },
  };
};

const targetPaths = (item: unknown, targets: ReadonlySet<string>): string[] => {
  if (typeof item !== "object" || item === null) return [];
  const paths: unknown[] = [];
  if ("path" in item) paths.push(item.path);
  if ("from" in item) paths.push(item.from);
  if ("to" in item) paths.push(item.to);
  if ("paths" in item && Array.isArray(item.paths)) paths.push(...item.paths);
  return paths.filter((path): path is string => typeof path === "string" && targets.has(path));
};

export const normalizeFormatResponse = (
  raw: unknown,
  rules: readonly PreparedRule[],
  policy: PathPolicy,
  ruleResources: RuleResources,
): FormatResponse => {
  const changes: FileChange[] = [];
  const warnings: FormatWarning[] = [];
  const errors: RunError[] = [];
  const skippedRules: FormatResponse["skippedRules"] = [];
  const known = new Set(rules.map(({ id }) => id));
  const targets = new Set(policy.targets);
  const reported = new Map<string, FormatFileResult>();
  const failures = new Map<string, string>();
  let globalFailure: string | undefined;
  let body: Record<string, unknown[]>;

  try {
    body = resultEnvelope(raw, [
      "completedRuleIds",
      "skippedRules",
      "changes",
      "warnings",
      "errors",
      "fileResults",
    ]);
  } catch (cause) {
    const error = toRunError(cause);
    return {
      changes,
      warnings,
      skippedRules,
      errors: [error],
      retryable: false,
      fileResults: policy.targets.map((path) => ({
        path,
        status: "failed",
        reason: error.message,
      })),
    };
  }

  collectErrors(body.errors!, known, errors);
  skippedRules.push(...checkCompletion(body.completedRuleIds!, body.skippedRules!, known, errors));
  const completionErrors = [...errors];
  const skippedRuleIds = new Set(skippedRules.map(({ ruleId }) => ruleId));
  // A contradictory skipped declaration must not legitimize changes for that same rule.
  for (const item of body.skippedRules!) {
    if (
      typeof item === "object" &&
      item !== null &&
      "ruleId" in item &&
      typeof item.ruleId === "string" &&
      known.has(item.ruleId)
    ) {
      skippedRuleIds.add(item.ruleId);
    }
  }

  const seen = new Set<string>();
  for (const item of body.fileResults!) {
    const path = targetPaths(item, targets)[0];
    try {
      if (path && seen.has(path)) {
        throw new AquariusError(
          "DUPLICATE_FILE_RESULT",
          "More than one processing result was returned for " + path + ".",
        );
      }
      if (path) seen.add(path);
      const file = parseResultItem(formatFileResultSchema, item, "file processing result");
      normalizedPath(file.path);
      if (!targets.has(file.path)) {
        throw new AquariusError(
          "INVALID_RESULT_PATH",
          "File processing result is outside the selected targets: " + file.path,
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
    const message = "AI did not report a processing result for " + path + ".";
    errors.push({ code: "INCOMPLETE_FILE_RESULTS", message, ruleIds: [] });
    failures.set(path, message);
  }

  const hasUnfinishedFiles =
    failures.size > 0 || [...reported.values()].some(({ status }) => status === "failed");
  const unscopedFailure = completionErrors.find(
    (error) => error.code !== "INCOMPLETE_FILE_REVIEW" || !hasUnfinishedFiles,
  );
  globalFailure = unscopedFailure?.message;

  const recordItemError = (item: unknown, error: RunError): void => {
    errors.push(error);
    const paths = targetPaths(item, targets);
    if (paths.length === 0) {
      globalFailure ??= error.message;
    } else {
      for (const path of paths) failures.set(path, error.message);
    }
  };
  const validator = createFormatValidator(rules, policy, ruleResources);
  for (const item of body.changes!) {
    try {
      const change = validator.change(item);
      references(change.ruleIds, known, false, skippedRuleIds);
      const skippedPath = formatChangePaths([change]).find(
        (path) => reported.get(path)?.status === "skipped",
      );
      if (skippedPath) {
        throw new AquariusError(
          "CONFLICTING_FILE_RESULT",
          "Skipped file " + skippedPath + " also has a change.",
        );
      }
      changes.push(change);
    } catch (cause) {
      recordItemError(item, toRunError(cause, "INVALID_FILE_CHANGE"));
    }
  }
  for (const item of body.warnings!) {
    try {
      const warning = validator.warning(item);
      references(warning.ruleIds, known, true, skippedRuleIds);
      warnings.push(warning);
    } catch (cause) {
      recordItemError(item, toRunError(cause, "INVALID_FORMAT_WARNING"));
    }
  }

  const fileResults = policy.targets.map((path): FormatFileResult => {
    const failure = globalFailure ?? failures.get(path);
    if (failure) return { path, status: "failed", reason: failure };
    const file = reported.get(path)!;
    if (rules.length > 0 && skippedRules.length === rules.length && file.status === "completed") {
      return { path, status: "skipped", reason: "No requested rule applies." };
    }
    return file;
  });
  const unexplainedFailure =
    [...reported.values()].some(({ status }) => status === "failed") &&
    !completionErrors.some(
      ({ code }) => code === "INCOMPLETE_FILE_REVIEW" || code === "INCOMPLETE_AI_RESPONSE",
    );
  const retryable =
    formatResponseSchema.safeParse(raw).success &&
    errors.length > 0 &&
    errors.every(({ code }) => incompleteCodes.has(code)) &&
    !unexplainedFailure;

  return { changes, warnings, errors, skippedRules, fileResults, retryable };
};
