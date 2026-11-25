import { executeWithTimeout, toRunError, type BatchReviewContext } from "@aquarius/core/runtime";
import { planPartialFileReplacements, type ReplacementFailure } from "../changes/plan";
import type { ReplaceChange } from "../changes/schema";
import type { FileBaseline } from "../changes/types";
import { buildReplacementRepairPrompt } from "./prompt";
import {
  completedReplacements,
  normalizeFormatResponse,
  recordReplacementFailures,
} from "./results";
import type { FormatResponse } from "./types";

const repairReplacement = async (
  failure: ReplacementFailure,
  patches: readonly ReplaceChange[],
  { policy, rules, request, session, timeoutMs, signal }: BatchReviewContext,
  baseline: ReadonlyMap<string, FileBaseline>,
) => {
  const { path } = failure;
  const ruleIds = new Set(patches.flatMap(({ ruleIds }) => ruleIds));
  const repairRules = rules.filter(({ id }) => ruleIds.has(id));
  const resources = request.ruleResources.filter(({ ruleId }) => ruleIds.has(ruleId));
  const repairPolicy = {
    ...policy,
    targets: [path],
    canWrite: (candidate: string) => candidate === path && policy.canWrite(candidate),
  };

  request.onProgress?.(`Repairing ${path}`);
  const raw = await executeWithTimeout(
    session,
    {
      ...request,
      ruleResources: resources,
      prompt: buildReplacementRepairPrompt(failure, patches, resources),
      onProgress: (message) => request.onProgress?.(`Repairing ${path}: ${message}`),
    },
    timeoutMs,
    signal,
    { keepAlive: true },
  );
  const repaired = normalizeFormatResponse(raw, repairRules, repairPolicy, request.ruleResources);
  const changes = completedReplacements(repaired);
  if (
    repaired.errors.length ||
    repaired.fileResults[0]?.status !== "completed" ||
    (changes.length === 0 && repaired.warnings.length === 0)
  ) {
    const reason = repaired.errors[0]?.message || repaired.fileResults[0]?.reason;
    return { failure: withRepairError(failure, reason || "No valid replacement was returned.") };
  }
  if (changes.length === 0) return { changes, warnings: repaired.warnings };

  const verification = await planPartialFileReplacements(
    policy.projectRoot,
    changes,
    repairPolicy.canWrite,
    baseline,
  );
  const invalid = verification.failures[0];
  if (invalid) return { failure: invalid, changes };
  return { changes, warnings: repaired.warnings };
};

const withRepairError = (
  failure: ReplacementFailure,
  reason: string,
  code = failure.error.code,
): ReplacementFailure => ({
  ...failure,
  error: { ...failure.error, code, message: `${failure.error.message} Repair failed: ${reason}` },
});

export const validateBatchReplacements = async (
  response: FormatResponse,
  context: BatchReviewContext,
  baseline: ReadonlyMap<string, FileBaseline>,
  includes: (path: string) => boolean,
): Promise<FormatResponse> => {
  const { policy, signal } = context;
  const candidates = completedReplacements(response).filter(({ path }) => includes(path));
  if (!candidates.length) return response;

  const { failures } = await planPartialFileReplacements(
    policy.projectRoot,
    candidates,
    policy.canWrite,
    baseline,
  );
  if (!failures.length) return response;

  const byPath = Map.groupBy(candidates, ({ path }) => path);
  const replacedPaths = new Set<string>();
  const repairedChanges: ReplaceChange[] = [];
  const remaining: ReplacementFailure[] = [];
  const warnings = [...response.warnings];
  for (const failure of failures) {
    if (!failure.repairable || signal.aborted) {
      remaining.push(failure);
      continue;
    }
    replacedPaths.add(failure.path);
    try {
      const repaired = await repairReplacement(
        failure,
        byPath.get(failure.path)!,
        context,
        baseline,
      );
      if (repaired.changes) repairedChanges.push(...repaired.changes);
      if (repaired.failure) remaining.push(repaired.failure);
      else warnings.push(...repaired.warnings);
    } catch (cause) {
      const { code, message } = toRunError(cause);
      remaining.push(withRepairError(failure, message, code));
    }
  }
  const changes = response.changes.filter(
    (change) => change.op !== "replace" || !replacedPaths.has(change.path),
  );
  return recordReplacementFailures(
    { ...response, changes: [...changes, ...repairedChanges], warnings },
    remaining,
  );
};
