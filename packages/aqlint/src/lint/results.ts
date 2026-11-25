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

    const cached = cache.get(path);
    if (cached) {
      return await cached;
    }

    const pending = (async () => {
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
      if (!Buffer.from(text, "utf8").equals(bytes)) {
        throw new AquariusError("INVALID_RESULT_PATH", `Result file is not UTF-8 text: ${path}`);
      }
      return text.split(/\r\n|\n|\r/u);
    })();
    cache.set(path, pending);
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

const findingPaths = (item: unknown, targets: ReadonlySet<string>): string[] => {
  if (
    typeof item !== "object" ||
    item === null ||
    !("locations" in item) ||
    !Array.isArray(item.locations)
  ) {
    return [];
  }

  const affected = new Set<string>();
  for (const location of item.locations) {
    if (
      typeof location !== "object" ||
      location === null ||
      !("path" in location) ||
      typeof location.path !== "string" ||
      !targets.has(location.path)
    ) {
      continue;
    }
    affected.add(location.path);
  }
  return [...affected];
};

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
      recordItemError(toRunError(cause, "INVALID_DIAGNOSTIC"), findingPaths(item, targets));
    }
  }

  const diagnostics = groupDiagnostics(findings);
  const paths = new Set(diagnostics.flatMap(({ locations }) => locations.map(({ path }) => path)));
  for (const path of paths) {
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
      continue;
    }
    if (file.status === "skipped") {
      summary.skippedFiles += 1;
      continue;
    }
    if (levels.get(file.path) === "warn") {
      summary.warningFiles += 1;
      continue;
    }
    summary.successFiles += 1;
  }
  return summary;
};
