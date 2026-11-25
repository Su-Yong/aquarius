import { AquariusError, loadConfig, runToolExecution, toRunError } from "@aqtools/core/runtime";

import { applyFileChanges } from "../changes/apply";
import { ReplacementPatchError } from "../changes/patch";
import { planFileChanges, planPartialFileReplacements } from "../changes/plan";
import { captureBaseline, pathKey } from "../changes/state";
import { createGitUndoStore, undoLastFileChanges } from "../undo/store";
import type { FileBaseline, FileChangePlan } from "../changes/types";

import { createFormatAnalysis, formatSnapshotDetails } from "./analysis";
import { buildFormatPrompt } from "./prompt";
import { validateBatchReplacements } from "./repair";
import {
  completedReplacements,
  formatChangePaths,
  normalizeFormatResponse,
  recordReplacementFailures,
  summarizeFormatResult,
} from "./results";
import { formatResponseJsonSchema } from "./schemas";
import type {
  FormatDetails,
  FormatExecutionOptions,
  FormatExecutionResult,
  FormatResult,
  FormatSnapshotDetails,
} from "./types";

type FormatExecutionHooks = Parameters<
  typeof runToolExecution<FormatDetails, FormatSnapshotDetails>
>[1];

export const executeFormat = async (
  options: FormatExecutionOptions,
): Promise<FormatExecutionResult> => {
  if (options.undo) {
    return executeUndo(options);
  }

  let baseline: ReadonlyMap<string, FileBaseline> = new Map();
  const aliasedPaths = new Set<string>();
  const hasAlias = (path: string): boolean => aliasedPaths.has(pathKey(path));
  let changedFiles: string[] = [];
  let wouldChangeFiles: string[] | undefined;

  const mergeFormatAnalysis: FormatExecutionHooks["mergeAnalysis"] = (groups) => {
    const proposedPaths = groups.flatMap(({ proposedFiles }) => proposedFiles);
    const uniqueProposedPaths = new Set(proposedPaths);
    const proposedFiles = [...uniqueProposedPaths].sort();
    return { proposedFiles, warnings: groups.flatMap(({ warnings }) => warnings) };
  };

  const captureReviewBaseline: NonNullable<FormatExecutionHooks["beforeReview"]> = async (policy) => {
    baseline = await captureBaseline(policy.projectRoot, policy.targets);
    const baselineByIdentity = Map.groupBy(baseline, ([, { identity }]) => identity);
    baselineByIdentity.delete(undefined);

    for (const entries of baselineByIdentity.values()) {
      if (entries.length < 2) continue;
      for (const [path] of entries) aliasedPaths.add(path);
    }
  };

  const applyReviewedChanges: NonNullable<FormatExecutionHooks["afterReview"]> = async (
    response,
    policy,
    rules,
  ) => {
    let plan: FileChangePlan;
    if (rules.every(({ scope }) => scope === "file")) {
      const replacements = completedReplacements(response);
      const partialPlan = await planPartialFileReplacements(
        policy.projectRoot,
        replacements,
        policy.canWrite,
        baseline,
      );
      plan = partialPlan.plan;
      response = recordReplacementFailures(response, partialPlan.failures);
    } else {
      try {
        plan = await planFileChanges(
          policy.projectRoot,
          response.changes,
          policy.canWrite,
          baseline,
        );
      } catch (cause) {
        if (!(cause instanceof ReplacementPatchError)) throw cause;
        return {
          ...response,
          errors: [...response.errors, toRunError(cause, undefined, cause.ruleIds)],
        };
      }
    }

    assertNotCancelled(options.signal);
    if (options.check) {
      wouldChangeFiles = plan.files.map(({ path }) => path);
      return response;
    }
    if (!plan.files.length) {
      return response;
    }

    options.onProgress?.("Writing changes");
    const undoStore = await createGitUndoStore(policy.projectRoot);
    assertNotCancelled(options.signal);
    const appliedChanges = await applyFileChanges(plan, undoStore);
    changedFiles = appliedChanges.changedFiles;

    if (appliedChanges.undoAvailable) {
      return response;
    }
    return {
      ...response,
      warnings: [
        ...response.warnings,
        {
          code: "UNDO_UNAVAILABLE",
          ruleIds: [],
          paths: [],
          message: "Formatting completed without Git undo support.",
        },
      ],
    };
  };

  const execution = await runToolExecution<FormatDetails, FormatSnapshotDetails>(options, {
    tool: "format",
    reviewProgress: "Planning changes with AI",
    unreviewedFile: { status: "skipped", reason: "Formatting did not start." },
    preparationFailedFile: {
      status: "skipped",
      reason: "Rule preparation failed; formatting did not start.",
    },
    onPreparationError: () => "select",
    continueOnBatchFailure: true,
    retrySingleFileGroup: true,
    afterReviewOnFailure: true,
    outputSchema: formatResponseJsonSchema,
    empty: { changes: [], warnings: [] },
    buildPrompt: buildFormatPrompt,
    normalize: normalizeFormatResponse,
    createAnalysis: createFormatAnalysis,
    finalDetails: formatSnapshotDetails,
    merge: (groups) => ({
      changes: groups.flatMap(({ changes }) => changes),
      warnings: groups.flatMap(({ warnings }) => warnings),
    }),
    mergeAnalysis: mergeFormatAnalysis,
    beforeReview: captureReviewBaseline,
    afterBatch: (response, context) =>
      validateBatchReplacements(response, context, baseline, (path) => !hasAlias(path)),
    // Wait to repair a hard-linked target until proposals for its aliases are known.
    afterBatches: (response, context) =>
      validateBatchReplacements(response, context, baseline, hasAlias),
    afterReview: applyReviewedChanges,
  });

  const { changes, warnings, errors, skippedRules, fileResults } = execution.response;
  const { ai } = execution;
  const result = {
    ...(ai && { ai }),
    changedFiles,
    ...(wouldChangeFiles === undefined ? {} : { wouldChangeFiles }),
    proposedFiles: formatChangePaths(changes),
    warnings,
    errors,
    skippedRules,
    fileResults,
    summary: summarizeFormatResult(fileResults, execution.activeRules, execution.totalFiles),
  };

  const selectCheckExitCode = (): 0 | 1 => (wouldChangeFiles?.length ? 1 : 0);
  const exitCode = execution.exitCode || selectCheckExitCode();
  return { result, exitCode };
};

const executeUndo = async (options: FormatExecutionOptions): Promise<FormatExecutionResult> => {
  const result: FormatResult = {
    changedFiles: [],
    proposedFiles: [],
    skippedRules: [],
    warnings: [],
    errors: [],
    fileResults: [],
    summary: summarizeFormatResult([], 0, null),
  };

  let restoredFiles: string[];
  try {
    if (options.check || options.paths?.length) {
      throw new AquariusError(
        "INVALID_ARGUMENTS",
        "--undo cannot be combined with --check or target paths.",
      );
    }

    const config = await loadConfig("format", options);
    assertNotCancelled(options.signal);

    options.onProgress?.("Restoring files");
    assertNotCancelled(options.signal);
    restoredFiles = await undoLastFileChanges(config.projectRoot);
  } catch (cause) {
    return {
      result: { ...result, errors: [toRunError(cause)] },
      exitCode: options.signal?.aborted ? 130 : 2,
    };
  }

  return { result: { ...result, restoredFiles }, exitCode: 0 };
};

const assertNotCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
  }
};
