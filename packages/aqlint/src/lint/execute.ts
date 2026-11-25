import { z } from "zod";

import { runToolExecution, type RunError, type ToolExecutionOptions } from "@aqtools/core/runtime";

import { createLintAnalysis } from "./analysis";
import { buildLintPrompt } from "./prompt";
import { groupDiagnostics, normalizeLintResponse, summarizeLintResult } from "./results";
import { lintResponseSchema } from "./schemas";
import type { LintExecutionResult, LintFindings } from "./types";

export type LintExecutionOptions = ToolExecutionOptions<LintFindings>;

export const executeLint = async (options: LintExecutionOptions): Promise<LintExecutionResult> => {
  const { response, ai, activeRules, totalFiles, exitCode } = await runToolExecution(options, {
    tool: "lint",
    reviewProgress: "Analyzing files with AI",
    unreviewedFile: { status: "failed", reason: "Analysis did not complete." },
    preparationFailedFile: { status: "failed", reason: "Rule preparation did not complete." },
    onPreparationError,
    outputSchema: z.toJSONSchema(lintResponseSchema),
    empty: { diagnostics: [] },
    buildPrompt: buildLintPrompt,
    normalize: normalizeLintResponse,
    createAnalysis: (rules, policy, _resources, options) =>
      createLintAnalysis(rules, policy, options),
    merge: mergeFindings,
    mergeAnalysis: mergeFindings,
  });

  const { diagnostics, errors, fileResults, skippedRules } = response;
  const result = {
    diagnostics,
    errors,
    fileResults,
    skippedRules,
    ...(ai && { ai }),
    summary: summarizeLintResult(response, activeRules, totalFiles),
  };

  const diagnosticExitCode =
    exitCode === 0 && diagnostics.some(({ severity }) => severity === "error") ? 1 : 0;
  return { result, exitCode: exitCode === 0 ? diagnosticExitCode : exitCode };
};

const mergeFindings = (findings: readonly LintFindings[]): LintFindings => ({
  diagnostics: groupDiagnostics(findings.flatMap(({ diagnostics }) => diagnostics)),
});

const onPreparationError = (errors: readonly RunError[]): "stop" | "review" =>
  errors.some(
    ({ code }) => code === "RULE_OPTIONS_INVALID" || code === "RULE_SCHEMA_TRANSFORMED_OPTIONS",
  )
    ? "stop"
    : "review";
