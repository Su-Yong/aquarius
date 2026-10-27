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
import type { PathPolicy, PreparedRule, RunError } from "@aquarius/core/internal";
import { fileChangeSchema, formatWarningSchema } from "./schemas";
import type { FileChange, FormatResponse, FormatWarning } from "./types";

export const normalizeFormatResponse = (
  raw: unknown,
  rules: readonly PreparedRule[],
  policy: PathPolicy,
): FormatResponse => {
  const changes: FileChange[] = [];
  const warnings: FormatWarning[] = [];
  const errors: RunError[] = [];
  const known = new Set(rules.map((rule) => rule.id));
  let body: Record<string, unknown[]>;

  try {
    body = resultEnvelope(raw, ["completedRuleIds", "changes", "warnings", "errors"]);
  } catch (cause) {
    return { changes, warnings, errors: [toRunError(cause)] };
  }

  collectErrors(body.errors!, known, errors);

  for (const item of body.changes!) {
    try {
      const change = parseResultItem(fileChangeSchema, item, "file change");
      references(change.ruleIds, known);
      const paths = change.op === "move" ? [change.from, change.to] : [change.path];
      for (const path of paths) {
        normalizedPath(path);
        if (!policy.canWrite(path)) {
          throw new AquariusError("CHANGE_OUTSIDE_SCOPE", `Change is outside the selected scope: ${path}`);
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
      references(warning.ruleIds, known, true);
      nonempty(warning.code, "Warning code");
      nonempty(warning.message, "Warning message");
      for (const path of warning.paths) {
        normalizedPath(path);
        if (policy.isIgnored(path)) {
          throw new AquariusError("INVALID_RESULT_PATH", "Warning references an ignored path.");
        }
      }
      warnings.push(warning);
    } catch (cause) {
      errors.push(toRunError(cause, "INVALID_FORMAT_WARNING"));
    }
  }

  checkCompletion(body.completedRuleIds!, known, errors);
  return { changes: errors.length ? [] : changes, warnings, errors };
};
