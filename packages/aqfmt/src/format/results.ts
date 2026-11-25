import {
  AquariusError,
  beginResponseNormalization,
  nonempty,
  normalizedPath,
  parseResultItem,
  references,
  toRunError,
} from "@aquarius/core/runtime";
import type {
  FileResult,
  PathPolicy,
  PreparedRule,
  RuleResource,
  RunError,
} from "@aquarius/core/runtime";

import { fileChangeSchema, type FileChange, type ReplaceChange } from "../changes/schema";
import type { ReplacementFailure } from "../changes/plan";

import { formatWarningSchema } from "./schemas";
import type { FormatResponse, FormatSummary, FormatWarning } from "./types";

export const normalizeFormatResponse = (
  raw: unknown,
  rules: readonly PreparedRule[],
  policy: PathPolicy,
  ruleResources: readonly RuleResource[],
): FormatResponse => {
  const changes: FileChange[] = [];
  const warnings: FormatWarning[] = [];
  const normalization = beginResponseNormalization(raw, rules, policy, ["changes", "warnings"]);
  const { body, skippedRuleIds, reported, recordItemError, finish } = normalization;
  if (!body) {
    return { ...finish(), changes, warnings };
  }

  const validator = createFormatValidator(rules, policy, ruleResources, skippedRuleIds);
  const fileOnly = rules.every(({ scope }) => scope === "file");
  const targets = new Set(policy.targets);
  const unassignedScopeErrors: RunError[] = [];
  for (const item of body.changes!) {
    try {
      const change = validator.change(item);
      const changePaths = formatChangePaths([change]);
      const skippedPath = changePaths.find((path) => reported.get(path)?.status === "skipped");
      if (skippedPath) {
        throw new AquariusError(
          "CONFLICTING_FILE_RESULT",
          "Skipped file " + skippedPath + " also has a change.",
        );
      }
      changes.push(change);
    } catch (cause) {
      const error = toRunError(cause, "INVALID_FILE_CHANGE");
      const paths = itemPaths(item);
      const isUnassignedScopeError =
        fileOnly &&
        error.code === "CHANGE_OUTSIDE_SCOPE" &&
        !paths.some((path) => targets.has(path));
      if (isUnassignedScopeError) {
        unassignedScopeErrors.push(error);
      } else {
        recordItemError(error, paths);
      }
    }
  }

  for (const item of body.warnings!) {
    try {
      warnings.push(validator.warning(item));
    } catch (cause) {
      recordItemError(toRunError(cause, "INVALID_FORMAT_WARNING"), itemPaths(item));
    }
  }

  const response = finish();
  return {
    ...response,
    errors: [...response.errors, ...unassignedScopeErrors],
    retryable: response.retryable && unassignedScopeErrors.length === 0,
    changes,
    warnings,
  };
};

export const createFormatValidator = (
  rules: readonly PreparedRule[],
  policy: PathPolicy,
  ruleResources: readonly RuleResource[],
  skippedRuleIds?: ReadonlySet<string>,
) => {
  const knownRuleIds = new Set(rules.map(({ id }) => id));
  const targetPaths = new Set(policy.targets);
  const fileOnly = rules.every(({ scope }) => scope === "file");
  const resourceDirectoryKey = (path: string): string => {
    const directory = path.split("/")[0]!;
    return directory.toLowerCase();
  };
  const directoryKeys = ruleResources.map(({ detailsPath }) => resourceDirectoryKey(detailsPath));
  const resourceDirectories = new Set(directoryKeys);
  const isInternalPath = (path: string): boolean =>
    resourceDirectories.has(resourceDirectoryKey(path));

  const proposedPath = (path: string): string => {
    normalizedPath(path);
    const outsideScope =
      isInternalPath(path) || !policy.canWrite(path) || (fileOnly && !targetPaths.has(path));
    if (outsideScope) {
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
      references(change.ruleIds, knownRuleIds, false, skippedRuleIds);
      const changePaths = formatChangePaths([change]);
      for (const path of changePaths) proposedPath(path);
      if (fileOnly && change.op !== "replace") {
        throw new AquariusError(
          "CHANGE_OUTSIDE_SCOPE",
          "File-scoped rules may only replace text in their assigned existing target files.",
        );
      }
      if (change.op === "create") return change;

      const sourcePath = change.op === "move" ? change.from : change.path;
      if (!targetPaths.has(sourcePath)) {
        throw new AquariusError(
          "CHANGE_OUTSIDE_SCOPE",
          "Existing-file changes require a selected target: " + sourcePath,
        );
      }
      return change;
    },
    warning: (input: unknown): FormatWarning => {
      const warning = parseResultItem(formatWarningSchema, input, "format warning");
      references(warning.ruleIds, knownRuleIds, true, skippedRuleIds);
      nonempty(warning.code, "Warning code");
      nonempty(warning.message, "Warning message");
      for (const path of warning.paths) {
        normalizedPath(path);
        if (isInternalPath(path) || policy.isIgnored(path)) {
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

export const formatChangePaths = (changes: readonly FileChange[]): string[] => {
  const paths = changes.flatMap((change) =>
    change.op === "move" ? [change.from, change.to] : [change.path],
  );
  return [...new Set(paths)].sort();
};

export const completedReplacements = ({
  changes,
  fileResults,
}: FormatResponse): ReplaceChange[] => {
  const completedFiles = fileResults.filter(({ status }) => status === "completed");
  const completedPaths = new Set(completedFiles.map(({ path }) => path));
  return changes.filter(
    (change): change is ReplaceChange => change.op === "replace" && completedPaths.has(change.path),
  );
};

export const recordReplacementFailures = (
  response: FormatResponse,
  failures: readonly ReplacementFailure[],
): FormatResponse => {
  if (!failures.length) return response;

  const failuresByPath = new Map(failures.map((failure) => [failure.path, failure]));
  const seenAliasKeys = new Set<string>();
  const isNewError = (error: RunError): boolean => {
    if (error.code !== "PATH_ALIAS_CONFLICT") return true;
    const aliasKey = JSON.stringify([error.message, error.ruleIds]);
    if (seenAliasKeys.has(aliasKey)) return false;
    seenAliasKeys.add(aliasKey);
    return true;
  };
  const errors = [...response.errors, ...failures.map(({ error }) => error)].filter(isNewError);
  return {
    ...response,
    changes: response.changes.filter(
      (change) => change.op !== "replace" || !failuresByPath.get(change.path)?.repairable,
    ),
    errors,
    fileResults: response.fileResults.map((file) => {
      const failure = failuresByPath.get(file.path);
      return failure ? { path: file.path, status: "failed", reason: failure.error.message } : file;
    }),
  };
};

export const summarizeFormatResult = (
  fileResults: readonly FileResult[],
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

const itemPaths = (item: unknown): string[] => {
  if (typeof item !== "object" || item === null) return [];
  const paths: unknown[] = [];
  if ("path" in item) paths.push(item.path);
  if ("from" in item) paths.push(item.from);
  if ("to" in item) paths.push(item.to);
  if ("paths" in item && Array.isArray(item.paths)) paths.push(...item.paths);
  return paths.filter((path): path is string => typeof path === "string");
};
