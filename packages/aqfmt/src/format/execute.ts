import { AquariusError, loadConfig, runToolExecution, toRunError } from "@aquarius/core/runtime";
import { applyFileChanges } from "../changes/apply";
import { ReplacementPatchError } from "../changes/patch";
import { planFileChanges, planPartialFileReplacements } from "../changes/plan";
import { captureBaseline, pathKey } from "../changes/state";
import type { FileBaseline, FileChangePlan } from "../changes/types";
import { createGitUndoStore, undoLastFileChanges } from "../undo/store";
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
    const restoredFiles = await undoLastFileChanges(config.projectRoot);
    return { result: { ...result, restoredFiles }, exitCode: 0 };
  } catch (cause) {
    return {
      result: { ...result, errors: [toRunError(cause)] },
      exitCode: options.signal?.aborted ? 130 : 2,
    };
  }
};

const assertNotCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
  }
};

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
    mergeAnalysis: (groups) => ({
      proposedFiles: [...new Set(groups.flatMap(({ proposedFiles }) => proposedFiles))].sort(),
      warnings: groups.flatMap(({ warnings }) => warnings),
    }),
    beforeReview: async (policy) => {
      baseline = await captureBaseline(policy.projectRoot, policy.targets);
      const byIdentity = Map.groupBy(baseline, ([, { identity }]) => identity);
      byIdentity.delete(undefined);
      for (const entries of byIdentity.values()) {
        if (entries.length < 2) continue;
        for (const [path] of entries) aliasedPaths.add(path);
      }
    },
    afterBatch: (response, context) =>
      validateBatchReplacements(response, context, baseline, (path) => !hasAlias(path)),
    // Wait to repair a hard-linked target until proposals for its aliases are known.
    afterBatches: (response, context) =>
      validateBatchReplacements(response, context, baseline, hasAlias),
    afterReview: async (response, policy, rules) => {
      let plan: FileChangePlan;
      if (rules.every(({ scope }) => scope === "file")) {
        const replacements = completedReplacements(response);
        const partial = await planPartialFileReplacements(
          policy.projectRoot,
          replacements,
          policy.canWrite,
          baseline,
        );
        plan = partial.plan;
        response = recordReplacementFailures(response, partial.failures);
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
      const store = await createGitUndoStore(policy.projectRoot);
      assertNotCancelled(options.signal);
      const applied = await applyFileChanges(plan, store);
      changedFiles = applied.changedFiles;
      if (applied.undoAvailable) {
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
    },
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
  return { result, exitCode: execution.exitCode || (wouldChangeFiles?.length ? 1 : 0) };
};
