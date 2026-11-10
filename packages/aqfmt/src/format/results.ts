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
import { fileChangeSchema, formatWarningSchema } from "./schemas";
import type { FileChange, FormatResponse, FormatWarning } from "./types";

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
  const known = new Set(rules.map((rule) => rule.id));
  const resourceDirectories = new Set(
    ruleResources.files.map(({ detailsPath }) => detailsPath.split("/")[0]!.toLowerCase()),
  );
  let body: Record<string, unknown[]>;

  try {
    body = resultEnvelope(raw, [
      "completedRuleIds",
      "skippedRules",
      "changes",
      "warnings",
      "errors",
    ]);
  } catch (cause) {
    return { changes, warnings, skippedRules, errors: [toRunError(cause)] };
  }

  collectErrors(body.errors!, known, errors);
  skippedRules.push(...checkCompletion(body.completedRuleIds!, body.skippedRules!, known, errors));
  const skippedRuleIds = new Set(skippedRules.map(({ ruleId }) => ruleId));

  for (const item of body.changes!) {
    try {
      const change = parseResultItem(fileChangeSchema, item, "file change");
      references(change.ruleIds, known, false, skippedRuleIds);
      const paths = change.op === "move" ? [change.from, change.to] : [change.path];
      for (const path of paths) {
        normalizedPath(path);
        if (resourceDirectories.has(path.split("/")[0]!.toLowerCase()) || !policy.canWrite(path)) {
          throw new AquariusError(
            "CHANGE_OUTSIDE_SCOPE",
            `Change is outside the selected scope: ${path}`,
          );
        }
      }
      changes.push(change);
    } catch (cause) {
      errors.push(toRunError(cause, "INVALID_FILE_CHANGE"));
    }
  }

  for (const item of body.warnings!) {
    try {
      const warning = parseResultItem(formatWarningSchema, item, "format warning");
      references(warning.ruleIds, known, true, skippedRuleIds);
      nonempty(warning.code, "Warning code");
      nonempty(warning.message, "Warning message");
      for (const path of warning.paths) {
        normalizedPath(path);
        if (resourceDirectories.has(path.split("/")[0]!.toLowerCase()) || policy.isIgnored(path)) {
          throw new AquariusError(
            "INVALID_RESULT_PATH",
            "Warning references an ignored path or internal rule resources.",
          );
        }
      }
      warnings.push(warning);
    } catch (cause) {
      errors.push(toRunError(cause, "INVALID_FORMAT_WARNING"));
    }
  }

  return { changes: errors.length ? [] : changes, warnings, errors, skippedRules };
};
