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
import { diagnosticSchema, fileResultSchema } from "./schemas";
import type { FileResult, SourceLocation } from "./schemas";
import type { Diagnostic, LintResult, LintSummary } from "./types";

const sourceReader = (policy: PathPolicy) => {
  const allowed = new Set(policy.readableFiles);
  const cache = new Map<string, Promise<string[]>>();

  return async (path: string): Promise<string[]> => {
    normalizedPath(path);
    if (!allowed.has(path) || policy.isIgnored(path)) {
      throw new AquariusError(
        "INVALID_RESULT_PATH",
        `Result references a file outside the readable project: ${path}`,
      );
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
          throw new AquariusError(
            "INVALID_RESULT_PATH",
            `Result file is not a stable regular project file: ${path}`,
          );
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
  if (
    requiredTargets &&
    (locations.length === 0 || !locations.every(({ path }) => requiredTargets.has(path)))
  ) {
    throw new AquariusError(
      "INVALID_RESULT_LOCATION",
      "Every primary diagnostic location must be a selected target.",
    );
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
      throw new AquariusError(
        "INVALID_RESULT_LOCATION",
        `Result position is outside ${location.path}.`,
      );
    }
  }
};

export const createLintFindingValidator = (rules: readonly PreparedRule[], policy: PathPolicy) => {
  const known = new Set(rules.map(({ id }) => id));
  const levels = new Map(rules.map(({ id, severity }) => [id, severity ?? "warn"] as const));
  const targets = new Set(policy.targets);
  const read = sourceReader(policy);

  return {
    diagnostic: async (item: unknown, skippedRules?: ReadonlySet<string>): Promise<Diagnostic> => {
      const supplied = parseResultItem(diagnosticSchema, item, "diagnostic");
      const ruleIds = references(supplied.ruleIds, known, false, skippedRules);
      nonempty(supplied.message, "Diagnostic message");
      await validateLocations(supplied.locations, read, targets);
      if (supplied.evidence.length === 0) {
        throw new AquariusError("INVALID_EVIDENCE", "A violation requires evidence.");
      }
      for (const evidence of supplied.evidence) {
        nonempty(evidence.message, "Evidence message");
        const lines = await read(evidence.path);
        if (!Number.isInteger(evidence.line) || evidence.line < 1 || evidence.line > lines.length) {
          throw new AquariusError(
            "INVALID_EVIDENCE",
            `Evidence position is outside ${evidence.path}.`,
          );
        }
      }

      const contributors = ruleIds.map((rule) => ({ rule, severity: levels.get(rule)! }));
      const severity: ActiveSeverity = contributors.some(({ severity }) => severity === "error")
        ? "error"
        : "warn";
      return {
        rules: contributors,
        severity,
        message: supplied.message,
        locations: supplied.locations.map((location) => ({ ...location })),
        evidence: supplied.evidence.map((evidence) => ({ ...evidence })),
      };
    },
  };
};

export const groupDiagnostics = (diagnostics: readonly Diagnostic[]): Diagnostic[] => {
  const grouped = new Map<string, Diagnostic>();
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify([diagnostic.message, diagnostic.locations, diagnostic.evidence]);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, structuredClone(diagnostic));
      continue;
    }
    for (const contributor of diagnostic.rules) {
      if (!existing.rules.some(({ rule }) => rule === contributor.rule)) {
        existing.rules.push({ ...contributor });
      }
    }
    existing.severity = existing.rules.some(({ severity }) => severity === "error")
      ? "error"
      : "warn";
  }
  return [...grouped.values()];
};

export const normalizeLintResponse = async (
  raw: unknown,
  rules: readonly PreparedRule[],
  policy: PathPolicy,
): Promise<LintResult> => {
  const errors: RunError[] = [];
  const diagnostics: Diagnostic[] = [];
  const skippedRules: LintResult["skippedRules"] = [];
  const known = new Set(rules.map(({ id }) => id));
  const targets = new Set(policy.targets);
  const reportedFiles = new Map<string, FileResult>();
  const fileFailures = new Map<string, string>();
  let globalFailure: string | undefined;

  const finish = (): LintResult => {
    const fileResults = policy.targets.map((path): FileResult => {
      const failure = globalFailure ?? fileFailures.get(path);
      if (failure) return { path, status: "failed", reason: failure };
      if (
        rules.length > 0 &&
        skippedRules.length === rules.length &&
        reportedFiles.get(path)?.status === "completed"
      ) {
        return { path, status: "skipped", reason: "No requested rule applies." };
      }
      return (
        reportedFiles.get(path) ?? {
          path,
          status: "failed",
          reason: "No file processing result was returned.",
        }
      );
    });
    const result = { diagnostics, errors, skippedRules, fileResults };
    return {
      ...result,
      summary: summarizeLintResult(result, rules.length, policy.targets.length),
    };
  };

  const recordFindingError = (item: unknown, error: RunError): void => {
    errors.push(error);
    const affected = new Set<string>();
    if (
      typeof item === "object" &&
      item !== null &&
      "locations" in item &&
      Array.isArray(item.locations)
    ) {
      for (const location of item.locations) {
        if (
          typeof location === "object" &&
          location !== null &&
          "path" in location &&
          typeof location.path === "string" &&
          targets.has(location.path)
        ) {
          affected.add(location.path);
        }
      }
    }
    if (affected.size === 0) {
      globalFailure ??= error.message;
      return;
    }
    for (const path of affected) fileFailures.set(path, error.message);
  };

  const fields = ["completedRuleIds", "skippedRules", "diagnostics", "errors", "fileResults"];
  let body: Record<string, unknown[]>;
  try {
    body = resultEnvelope(raw, fields);
  } catch (cause) {
    const error = toRunError(cause);
    errors.push(error);
    globalFailure = error.message;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return finish();
    // Preserve valid findings without inventing completion for missing file statuses.
    try {
      body = resultEnvelope({ ...raw, fileResults: [] }, fields);
    } catch {
      return finish();
    }
  }

  collectErrors(body.errors!, known, errors);
  skippedRules.push(...checkCompletion(body.completedRuleIds!, body.skippedRules!, known, errors));
  const skippedRuleIds = new Set(skippedRules.map(({ ruleId }) => ruleId));
  if (errors.length) globalFailure ??= errors[0]!.message;

  const seen = new Set<string>();
  for (const item of body.fileResults!) {
    let path: string | undefined;
    if (
      typeof item === "object" &&
      item !== null &&
      "path" in item &&
      typeof item.path === "string" &&
      targets.has(item.path)
    ) {
      path = item.path;
    }
    try {
      const supplied = parseResultItem(fileResultSchema, item, "file processing result");
      normalizedPath(supplied.path);
      if (!targets.has(supplied.path)) {
        throw new AquariusError(
          "INVALID_RESULT_PATH",
          `File processing result is outside the selected targets: ${supplied.path}`,
        );
      }
      if (seen.has(supplied.path)) {
        throw new AquariusError(
          "DUPLICATE_FILE_RESULT",
          `More than one processing result was returned for ${supplied.path}.`,
        );
      }
      seen.add(supplied.path);
      if (supplied.status !== "completed") nonempty(supplied.reason, "File processing reason");
      reportedFiles.set(supplied.path, supplied);
    } catch (cause) {
      const error = toRunError(cause, "INVALID_FILE_RESULT");
      errors.push(error);
      if (path) fileFailures.set(path, error.message);
    }
  }
  if (!globalFailure) {
    for (const path of targets) {
      if (reportedFiles.has(path) || fileFailures.has(path)) continue;
      const message = `AI did not report a processing result for ${path}.`;
      errors.push({ code: "INCOMPLETE_FILE_RESULTS", message, ruleIds: [] });
      fileFailures.set(path, message);
    }
  }

  const validator = createLintFindingValidator(rules, policy);
  const validDiagnostics: Diagnostic[] = [];

  for (const item of body.diagnostics!) {
    try {
      validDiagnostics.push(await validator.diagnostic(item, skippedRuleIds));
    } catch (cause) {
      recordFindingError(item, toRunError(cause, "INVALID_DIAGNOSTIC"));
    }
  }
  diagnostics.push(...groupDiagnostics(validDiagnostics));

  const findingPaths = new Set(
    diagnostics.flatMap(({ locations }) => locations.map(({ path }) => path)),
  );
  for (const path of findingPaths) {
    if (reportedFiles.get(path)?.status !== "skipped") continue;
    const message = `Skipped file ${path} also has a diagnostic.`;
    errors.push({ code: "CONFLICTING_FILE_RESULT", message, ruleIds: [] });
    fileFailures.set(path, message);
  }

  return finish();
};

export const summarizeLintResult = (
  result: Pick<LintResult, "fileResults" | "diagnostics">,
  activeRules: number,
  totalFiles: number | null = result.fileResults.length,
): LintSummary => {
  const levels = new Map<string, ActiveSeverity>();
  for (const diagnostic of result.diagnostics) {
    for (const { path } of diagnostic.locations) {
      if (levels.get(path) !== "error") {
        levels.set(path, diagnostic.severity);
      }
    }
  }

  const summary: LintSummary = {
    totalFiles,
    successFiles: 0,
    warningFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    activeRules,
  };
  for (const file of result.fileResults) {
    if (file.status === "failed" || levels.get(file.path) === "error") {
      summary.failedFiles += 1;
    } else if (file.status === "skipped") {
      summary.skippedFiles += 1;
    } else if (levels.get(file.path) === "warn") {
      summary.warningFiles += 1;
    } else {
      summary.successFiles += 1;
    }
  }
  return summary;
};
