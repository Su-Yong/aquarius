import {
  AquariusError,
  createAnalysisState,
  type AnalysisOptions,
  type PathPolicy,
  type PreparedRule,
} from "@aquarius/core/runtime";

import { createLintFindingValidator, groupDiagnostics } from "./results";
import { analysisUpdateSchema, type AnalysisUpdate } from "./schemas";
import type { Diagnostic, LintFindings, LintResponse } from "./types";

export const createLintAnalysis = (
  rules: readonly PreparedRule[],
  policy: PathPolicy,
  options: AnalysisOptions<LintFindings> = {},
) => {
  const validator = createLintFindingValidator(rules, policy);
  let diagnostics = new Map<string, Diagnostic>();

  const applyDiagnosticUpdate: Parameters<
    typeof createAnalysisState<LintFindings, AnalysisUpdate, LintResponse>
  >[2]["apply"] = async (update, _current, files, rules) => {
    const diagnosticIds = update.diagnostics.map(({ id }) => id);
    const uniqueDiagnosticIds = new Set(diagnosticIds);

    if (uniqueDiagnosticIds.size !== update.diagnostics.length) {
      throw new AquariusError(
        "DUPLICATE_ANALYSIS_ITEM",
        "A provisional update repeats a diagnostic ID.",
      );
    }

    const nextDiagnostics = new Map(diagnostics);
    for (const entry of update.diagnostics) {
      if (entry.diagnostic !== null) {
        nextDiagnostics.set(entry.id, await validator.diagnostic(entry.diagnostic));
        continue;
      }

      if (!nextDiagnostics.delete(entry.id)) {
        throw new AquariusError(
          "UNKNOWN_ANALYSIS_ITEM",
          "A provisional update withdraws an unknown diagnostic ID.",
        );
      }
    }

    for (const diagnostic of nextDiagnostics.values()) {
      if (diagnostic.rules.some(({ rule }) => rules.get(rule)?.status === "skipped")) {
        throw new AquariusError(
          "CONFLICTING_RULE_RESULT",
          "A provisionally skipped rule also has a finding.",
        );
      }

      if (diagnostic.locations.some(({ path }) => files.get(path)?.status === "skipped")) {
        throw new AquariusError(
          "CONFLICTING_FILE_RESULT",
          "A provisionally skipped file also has a finding.",
        );
      }
    }

    diagnostics = nextDiagnostics;
    return { diagnostics: groupDiagnostics([...diagnostics.values()]) };
  };

  return createAnalysisState<LintFindings, AnalysisUpdate, LintResponse>(
    rules,
    policy,
    {
      schema: analysisUpdateSchema,
      initial: { diagnostics: [] },
      apply: applyDiagnosticUpdate,
      final: (response) => ({ diagnostics: response.diagnostics }),
      retainIncomplete: true,
    },
    options,
  );
};
