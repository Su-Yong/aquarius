import {
  AquariusError,
  beginResponseNormalization,
  nonempty,
  normalizedPath,
  parseResultItem,
  readStableRegularFile,
  references,
  toRunError,
} from "@aquarius/core/runtime";
import type { ActiveSeverity, PathPolicy, PreparedRule } from "@aquarius/core/runtime";

import { diagnosticSchema } from "./schemas";
import type { SourceLocation } from "./schemas";
import type { Diagnostic, LintResponse, LintResult, LintSummary } from "./types";

export const normalizeLintResponse = async (
  raw: unknown,
  rules: readonly PreparedRule[],
  policy: PathPolicy,
): Promise<LintResponse> => {
  const normalization = beginResponseNormalization(raw, rules, policy, ["diagnostics"]);
  const { body, skippedRuleIds, reported, recordItemError, finish } = normalization;
  if (!body) {
    return { ...finish(), diagnostics: [] };
  }

  const targets = new Set(policy.targets);
  const validator = createLintFindingValidator(rules, policy);
  const findings: Diagnostic[] = [];
  for (const item of body.diagnostics!) {
    try {
      findings.push(await validator.diagnostic(item, skippedRuleIds));
    } catch (cause) {
      const error = toRunError(cause, "INVALID_DIAGNOSTIC");
      const affectedPaths = findingPaths(item, targets);
      recordItemError(error, affectedPaths);
    }
  }

  const diagnostics = groupDiagnostics(findings);
  const diagnosticPaths = diagnostics.flatMap(({ locations }) => locations.map(({ path }) => path));
  const uniqueDiagnosticPaths = new Set(diagnosticPaths);
  for (const path of uniqueDiagnosticPaths) {
    if (reported.get(path)?.status !== "skipped") {
      continue;
    }
    recordItemError(
      {
        code: "CONFLICTING_FILE_RESULT",
        message: `Skipped file ${path} also has a diagnostic.`,
        ruleIds: [],
      },
      [path],
    );
  }

  return { ...finish(), diagnostics };
};

export const createLintFindingValidator = (rules: readonly PreparedRule[], policy: PathPolicy) => {
  const knownRuleIds = new Set(rules.map(({ id }) => id));
  const severityByRuleId = new Map(
    rules.map(({ id, severity }) => [id, severity ?? "warn"] as const),
  );
  const targets = new Set(policy.targets);
  const readSourceLines = createSourceReader(policy);

  const diagnostic = async (item: unknown, skippedRules?: ReadonlySet<string>): Promise<Diagnostic> => {
    const suppliedDiagnostic = parseResultItem(diagnosticSchema, item, "diagnostic");
    const ruleIds = references(suppliedDiagnostic.ruleIds, knownRuleIds, false, skippedRules);
    nonempty(suppliedDiagnostic.message, "Diagnostic message");
    await validateLocations(suppliedDiagnostic.locations, readSourceLines, targets);
    if (suppliedDiagnostic.evidence.length === 0) {
      throw new AquariusError("INVALID_EVIDENCE", "A violation requires evidence.");
    }
    for (const evidence of suppliedDiagnostic.evidence) {
      nonempty(evidence.message, "Evidence message");
      const lines = await readSourceLines(evidence.path);
      const isOutsideSource =
        !Number.isInteger(evidence.line) || evidence.line < 1 || evidence.line > lines.length;
      if (isOutsideSource) {
        throw new AquariusError(
          "INVALID_EVIDENCE",
          `Evidence position is outside ${evidence.path}.`,
        );
      }
    }

    const contributors = ruleIds.map((rule) => ({ rule, severity: severityByRuleId.get(rule)! }));
    const severity: ActiveSeverity = contributors.some(({ severity }) => severity === "error")
      ? "error"
      : "warn";
    return {
      rules: contributors,
      severity,
      message: suppliedDiagnostic.message,
      locations: suppliedDiagnostic.locations.map((location) => ({ ...location })),
      evidence: suppliedDiagnostic.evidence.map((evidence) => ({ ...evidence })),
    };
  };

  return { diagnostic };
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

export const summarizeLintResult = (
  result: Pick<LintResult, "fileResults" | "diagnostics">,
  activeRules: number,
  totalFiles: number | null = result.fileResults.length,
): LintSummary => {
  const severityByFilePath = new Map<string, ActiveSeverity>();
  for (const diagnostic of result.diagnostics) {
    for (const { path } of diagnostic.locations) {
      if (severityByFilePath.get(path) !== "error") {
        severityByFilePath.set(path, diagnostic.severity);
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
    if (file.status === "failed" || severityByFilePath.get(file.path) === "error") {
      summary.failedFiles += 1;
    } else if (file.status === "skipped") {
      summary.skippedFiles += 1;
    } else if (severityByFilePath.get(file.path) === "warn") {
      summary.warningFiles += 1;
    } else {
      summary.successFiles += 1;
    }
  }
  return summary;
};

const createSourceReader = (policy: PathPolicy) => {
  const readablePaths = new Set(policy.readableFiles);
  const sourceLinesByPath = new Map<string, Promise<string[]>>();

  return async (path: string): Promise<string[]> => {
    normalizedPath(path);
    if (!readablePaths.has(path) || policy.isIgnored(path)) {
      throw new AquariusError(
        "INVALID_RESULT_PATH",
        `Result references a file outside the readable project: ${path}`,
      );
    }

    const cached = sourceLinesByPath.get(path);
    if (cached) {
      return await cached;
    }

    const readUncachedSourceLines = async () => {
      let bytes: Buffer;
      try {
        ({ content: bytes } = await readStableRegularFile(policy.projectRoot, path));
      } catch {
        throw new AquariusError(
          "INVALID_RESULT_PATH",
          `Result file is not a stable regular project file: ${path}`,
        );
      }
      const text = bytes.toString("utf8");
      const encodedText = Buffer.from(text, "utf8");
      if (!encodedText.equals(bytes)) {
        throw new AquariusError("INVALID_RESULT_PATH", `Result file is not UTF-8 text: ${path}`);
      }
      const sourceLineBreak = /\r\n|\n|\r/u;
      return text.split(sourceLineBreak);
    };
    const pending = readUncachedSourceLines();
    sourceLinesByPath.set(path, pending);
    return await pending;
  };
};

const validateLocations = async (
  locations: SourceLocation[],
  readSourceLines: ReturnType<typeof createSourceReader>,
  requiredTargets?: Set<string>,
): Promise<void> => {
  const hasInvalidPrimaryLocations =
    requiredTargets &&
    (locations.length === 0 || !locations.every(({ path }) => requiredTargets.has(path)));
  if (hasInvalidPrimaryLocations) {
    throw new AquariusError(
      "INVALID_RESULT_LOCATION",
      "Every primary diagnostic location must be a selected target.",
    );
  }
  for (const location of locations) {
    const lines = await readSourceLines(location.path);
    const isOutsideSource =
      !Number.isInteger(location.line) ||
      !Number.isInteger(location.column) ||
      location.line < 1 ||
      location.line > lines.length ||
      location.column < 1 ||
      location.column > lines[location.line - 1]!.length + 1;
    if (isOutsideSource) {
      throw new AquariusError(
        "INVALID_RESULT_LOCATION",
        `Result position is outside ${location.path}.`,
      );
    }
  }
};

const findingPaths = (item: unknown, targets: ReadonlySet<string>): string[] => {
  const hasLocations = typeof item === "object" && item !== null && "locations" in item;
  if (!hasLocations || !Array.isArray(item.locations)) {
    return [];
  }

  const affectedPaths = new Set<string>();
  for (const location of item.locations) {
    const isTargetLocation =
      typeof location === "object" &&
      location !== null &&
      "path" in location &&
      typeof location.path === "string" &&
      targets.has(location.path);
    if (!isTargetLocation) {
      continue;
    }
    affectedPaths.add(location.path);
  }
  return [...affectedPaths];
};
