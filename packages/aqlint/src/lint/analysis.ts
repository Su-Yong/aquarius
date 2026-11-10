import { AquariusError, nonempty, normalizedPath, toRunError } from "@aquarius/core/internal";
import type { PathPolicy, PreparedRule, RunError } from "@aquarius/core/internal";
import { createLintFindingValidator, groupDiagnostics } from "./results";
import { analysisUpdateSchema } from "./schemas";
import type { AnalysisUpdate, SourceLocation } from "./schemas";
import type { Diagnostic, FileReview, LintAnalysisSnapshot, LintResult, RuleReview } from "./types";

interface AnalysisOptions {
  onUpdate?: (snapshot: LintAnalysisSnapshot) => void;
  onWarning?: (message: string) => void;
}

const assertUnique = (identifiers: readonly string[], label: string): void => {
  if (new Set(identifiers).size !== identifiers.length) {
    throw new AquariusError("DUPLICATE_ANALYSIS_ITEM", `A provisional update repeats a ${label}.`);
  }
};

export const createLintAnalysis = (
  rules: readonly PreparedRule[],
  policy: PathPolicy,
  options: AnalysisOptions = {},
) => {
  const knownRules = new Set(rules.map(({ id }) => id));
  const targets = new Set(policy.targets);
  const validator = createLintFindingValidator(rules, policy);
  let diagnostics = new Map<string, Diagnostic>();
  let fileResults = new Map<string, FileReview>(
    policy.targets.map((path) => [path, { path, status: "pending", reason: "" }]),
  );
  let ruleResults = new Map<string, RuleReview>(
    rules.map(({ id }) => [id, { ruleId: id, status: "pending", reason: "" }]),
  );
  let revision = 0;
  let accepting = true;
  let pending = Promise.resolve();
  let latest: LintAnalysisSnapshot = {
    phase: "provisional",
    revision,
    diagnostics: [],
    fileResults: [...fileResults.values()],
    ruleResults: [...ruleResults.values()],
    errors: [],
  };

  const warn = (message: string): void => {
    try {
      Promise.resolve(options.onWarning?.(message)).catch(() => {});
    } catch {
      // Reporting callbacks must not replace the analysis result or its original error.
    }
  };

  const publish = (snapshot: LintAnalysisSnapshot): LintAnalysisSnapshot => {
    latest = structuredClone(snapshot);
    try {
      Promise.resolve(options.onUpdate?.(structuredClone(latest))).catch(() => {
        warn("The provisional analysis observer failed; analysis will continue.");
      });
    } catch {
      warn("The provisional analysis observer failed; analysis will continue.");
    }
    return structuredClone(latest);
  };

  const apply = async (update: AnalysisUpdate): Promise<void> => {
    if (update.revision <= revision) return;

    assertUnique(
      update.diagnostics.map(({ id }) => id),
      "diagnostic ID",
    );
    assertUnique(
      update.fileResults.map(({ path }) => path),
      "file path",
    );
    assertUnique(
      update.ruleResults.map(({ ruleId }) => ruleId),
      "rule ID",
    );

    const nextDiagnostics = new Map(diagnostics);
    const nextFiles = new Map(fileResults);
    const nextRules = new Map(ruleResults);

    for (const entry of update.diagnostics) {
      if (entry.diagnostic === null) {
        if (!nextDiagnostics.delete(entry.id)) {
          throw new AquariusError(
            "UNKNOWN_ANALYSIS_ITEM",
            "A provisional update withdraws an unknown diagnostic ID.",
          );
        }
      } else {
        nextDiagnostics.set(entry.id, await validator.diagnostic(entry.diagnostic));
      }
    }
    for (const file of update.fileResults) {
      normalizedPath(file.path);
      if (!targets.has(file.path)) {
        throw new AquariusError(
          "INVALID_RESULT_PATH",
          "A provisional file status is outside the selected targets.",
        );
      }
      if (file.status === "skipped" || file.status === "failed") {
        nonempty(file.reason, "File review reason");
      }
      nextFiles.set(file.path, file);
    }
    for (const rule of update.ruleResults) {
      if (!knownRules.has(rule.ruleId)) {
        throw new AquariusError(
          "INVALID_RULE_REFERENCE",
          "A provisional review references an unrequested rule.",
        );
      }
      if (rule.status === "skipped" || rule.status === "failed") {
        nonempty(rule.reason, "Rule review reason");
      }
      nextRules.set(rule.ruleId, rule);
    }

    const checkApplicability = (ruleIds: string[], locations: SourceLocation[]): void => {
      if (ruleIds.some((id) => nextRules.get(id)?.status === "skipped")) {
        throw new AquariusError(
          "CONFLICTING_RULE_RESULT",
          "A provisionally skipped rule also has a finding.",
        );
      }
      if (locations.some(({ path }) => nextFiles.get(path)?.status === "skipped")) {
        throw new AquariusError(
          "CONFLICTING_FILE_RESULT",
          "A provisionally skipped file also has a finding.",
        );
      }
    };
    for (const diagnostic of nextDiagnostics.values()) {
      checkApplicability(
        diagnostic.rules.map(({ rule }) => rule),
        diagnostic.locations,
      );
    }
    diagnostics = nextDiagnostics;
    fileResults = nextFiles;
    ruleResults = nextRules;
    revision = update.revision;
    publish({
      phase: "provisional",
      revision,
      diagnostics: groupDiagnostics([...diagnostics.values()]),
      fileResults: [...fileResults.values()],
      ruleResults: [...ruleResults.values()],
      errors: [],
    });
  };

  const update = (raw: unknown): void => {
    if (!accepting) return;
    const parsed = analysisUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      warn("Ignored an invalid provisional analysis update (INVALID_ANALYSIS_UPDATE).");
      return;
    }
    pending = pending.then(async () => {
      try {
        await apply(parsed.data);
      } catch (cause) {
        const error = toRunError(cause, "INVALID_ANALYSIS_UPDATE");
        warn(`Ignored a provisional analysis update (${error.code}): ${error.message}`);
      }
    });
  };

  const interrupt = (errors: readonly RunError[] = []): Promise<LintAnalysisSnapshot> => {
    accepting = false;
    const interrupted = pending.then(() => {
      revision += 1;
      return publish({
        ...latest,
        phase: "incomplete",
        revision,
        errors: [...errors],
      });
    });
    pending = interrupted.then(() => {});
    return interrupted;
  };

  const finish = (
    result: LintResult,
    phase: "provisional" | "final" = "final",
  ): Promise<LintAnalysisSnapshot> => {
    if (result.errors.length > 0 || result.fileResults.some(({ status }) => status === "failed")) {
      return interrupt(result.errors);
    }
    accepting = false;
    const finished = pending.then(() => {
      const skipped = new Map(result.skippedRules.map((rule) => [rule.ruleId, rule.reason]));
      revision += 1;
      return publish({
        phase,
        revision,
        diagnostics: result.diagnostics,
        fileResults: result.fileResults,
        ruleResults: rules.map(({ id }): RuleReview => ({
          ruleId: id,
          status: skipped.has(id) ? "skipped" : "completed",
          reason: skipped.get(id) ?? "",
        })),
        errors: result.errors,
      });
    });
    pending = finished.then(() => {});
    return finished;
  };

  publish(latest);
  return { update, flush: () => pending, finish, interrupt };
};
