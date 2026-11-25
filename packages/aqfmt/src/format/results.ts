import {
  AquariusError,
  beginResponseNormalization,
  nonempty,
  normalizedPath,
  parseResultItem,
  references,
  toRunError,
} from "@aquarius/core/runtime";
import type { FileResult, PathPolicy, PreparedRule, RuleResource } from "@aquarius/core/runtime";
import { fileChangeSchema, type FileChange } from "../changes/schema";
import { formatWarningSchema } from "./schemas";
import type { FormatResponse, FormatSummary, FormatWarning } from "./types";

export const formatChangePaths = (changes: readonly FileChange[]): string[] =>
  [
    ...new Set(
      changes.flatMap((change) =>
        change.op === "move" ? [change.from, change.to] : [change.path],
      ),
    ),
  ].sort();

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

export const createFormatValidator = (
  rules: readonly PreparedRule[],
  policy: PathPolicy,
  ruleResources: readonly RuleResource[],
  skippedRuleIds?: ReadonlySet<string>,
) => {
  const known = new Set(rules.map(({ id }) => id));
  const targets = new Set(policy.targets);
  const fileOnly = rules.every(({ scope }) => scope === "file");
  const resourceDirectories = new Set(
    ruleResources.map(({ detailsPath }) => detailsPath.split("/")[0]!.toLowerCase()),
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
      references(change.ruleIds, known, false, skippedRuleIds);
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
      references(warning.ruleIds, known, true, skippedRuleIds);
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

const itemPaths = (item: unknown): string[] => {
  if (typeof item !== "object" || item === null) return [];
  const paths: unknown[] = [];
  if ("path" in item) paths.push(item.path);
  if ("from" in item) paths.push(item.from);
  if ("to" in item) paths.push(item.to);
  if ("paths" in item && Array.isArray(item.paths)) paths.push(...item.paths);
  return paths.filter((path): path is string => typeof path === "string");
};

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
  for (const item of body.changes!) {
    try {
      const change = validator.change(item);
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
      recordItemError(toRunError(cause, "INVALID_FILE_CHANGE"), itemPaths(item));
    }
  }

  for (const item of body.warnings!) {
    try {
      warnings.push(validator.warning(item));
    } catch (cause) {
      recordItemError(toRunError(cause, "INVALID_FORMAT_WARNING"), itemPaths(item));
    }
  }

  return {
    ...finish(),
    changes,
    warnings,
  };
};
