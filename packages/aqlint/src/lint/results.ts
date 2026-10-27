import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
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
import type { ActiveSeverity, PathPolicy, PreparedRule, RunError } from "@aquarius/core/internal";
import { diagnosticSchema, unknownSchema } from "./schemas";
import type { SourceLocation } from "./schemas";
import type { Diagnostic, LintResult } from "./types";

const sourceReader = (policy: PathPolicy) => {
  const allowed = new Set(policy.readableFiles);
  const cache = new Map<string, Promise<string[]>>();

  return async (path: string): Promise<string[]> => {
    normalizedPath(path);
    if (!allowed.has(path) || policy.isIgnored(path)) {
      throw new AquariusError("INVALID_RESULT_PATH", `Result references a file outside the readable project: ${path}`);
    }

    let pending = cache.get(path);
    if (!pending) {
      pending = (async () => {
        const absolute = resolve(policy.projectRoot, path);
        const canonical = await realpath(absolute);
        const inside = relative(policy.projectRoot, canonical);
        if (
          inside === ".." ||
          inside.startsWith(`..${sep}`) ||
          isAbsolute(inside) ||
          relative(absolute, canonical) !== "" ||
          !(await lstat(absolute)).isFile()
        ) {
          throw new AquariusError("INVALID_RESULT_PATH", `Result file is not a stable regular project file: ${path}`);
        }
        const bytes = await readFile(absolute);
        const text = bytes.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(bytes)) {
          throw new AquariusError("INVALID_RESULT_PATH", `Result file is not UTF-8 text: ${path}`);
        }
        return text.split(/\r\n|\n|\r/u);
      })();
      cache.set(path, pending);
    }
    return await pending;
  };
};

const validateLocations = async (
  locations: SourceLocation[],
  read: ReturnType<typeof sourceReader>,
  requiredTargets?: Set<string>,
): Promise<void> => {
  if (requiredTargets && (locations.length === 0 || !locations.every(({ path }) => requiredTargets.has(path)))) {
    throw new AquariusError("INVALID_RESULT_LOCATION", "Every primary diagnostic location must be a selected target.");
  }
  for (const location of locations) {
    const lines = await read(location.path);
    if (
      !Number.isInteger(location.line) ||
      !Number.isInteger(location.column) ||
      location.line < 1 ||
      location.line > lines.length ||
      location.column < 1 ||
      location.column > lines[location.line - 1]!.length + 1
    ) {
      throw new AquariusError("INVALID_RESULT_LOCATION", `Result position is outside ${location.path}.`);
    }
  }
};

export const normalizeLintResponse = async (
  raw: unknown,
  rules: readonly PreparedRule[],
  policy: PathPolicy,
): Promise<LintResult> => {
  const errors: RunError[] = [];
  const diagnostics: Diagnostic[] = [];
  const unknowns: LintResult["unknowns"] = [];
  const known = new Set(rules.map(({ id }) => id));
  const levels = new Map(rules.map(({ id, severity }) => [id, severity ?? "warn"] as const));
  let body: Record<string, unknown[]>;
  try {
    body = resultEnvelope(raw, ["completedRuleIds", "diagnostics", "unknowns", "errors"]);
  } catch (cause) {
    return { diagnostics, unknowns, errors: [toRunError(cause)] };
  }

  collectErrors(body.errors!, known, errors);
  const read = sourceReader(policy);
  const targets = new Set(policy.targets);
  const grouped = new Map<string, Diagnostic>();

  for (const item of body.diagnostics!) {
    try {
      const supplied = parseResultItem(diagnosticSchema, item, "diagnostic");
      const ruleIds = references(supplied.ruleIds, known);
      nonempty(supplied.message, "Diagnostic message");
      await validateLocations(supplied.locations, read, targets);
      if (supplied.evidence.length === 0) {
        throw new AquariusError("INVALID_EVIDENCE", "A violation requires evidence.");
      }
      for (const evidence of supplied.evidence) {
        nonempty(evidence.message, "Evidence message");
        const lines = await read(evidence.path);
        if (!Number.isInteger(evidence.line) || evidence.line < 1 || evidence.line > lines.length) {
          throw new AquariusError("INVALID_EVIDENCE", `Evidence position is outside ${evidence.path}.`);
        }
      }

      const key = JSON.stringify([supplied.message, supplied.locations, supplied.evidence]);
      const contributors = ruleIds.map((rule) => ({ rule, severity: levels.get(rule)! }));
      const existing = grouped.get(key);
      if (existing) {
        for (const contributor of contributors) {
          if (!existing.rules.some(({ rule }) => rule === contributor.rule)) existing.rules.push(contributor);
        }
        existing.severity = existing.rules.some(({ severity }) => severity === "error") ? "error" : "warn";
        continue;
      }

      const severity: ActiveSeverity = contributors.some(({ severity }) => severity === "error") ? "error" : "warn";
      const diagnostic: Diagnostic = {
        rules: contributors,
        severity,
        message: supplied.message,
        locations: supplied.locations.map((location) => ({ ...location })),
        evidence: supplied.evidence.map((evidence) => ({ ...evidence })),
      };
      grouped.set(key, diagnostic);
      diagnostics.push(diagnostic);
    } catch (cause) {
      errors.push(toRunError(cause, "INVALID_DIAGNOSTIC"));
    }
  }

  for (const item of body.unknowns!) {
    try {
      const supplied = parseResultItem(unknownSchema, item, "unknown conclusion");
      references(supplied.ruleIds, known);
      nonempty(supplied.message, "Unknown conclusion message");
      await validateLocations(supplied.locations, read, supplied.locations.length ? targets : undefined);
      unknowns.push({
        ruleIds: [...supplied.ruleIds],
        message: supplied.message,
        locations: supplied.locations.map((location) => ({ ...location })),
      });
    } catch (cause) {
      errors.push(toRunError(cause, "INVALID_UNKNOWN_RESULT"));
    }
  }

  checkCompletion(body.completedRuleIds!, known, errors);
  return { diagnostics, unknowns, errors };
};
