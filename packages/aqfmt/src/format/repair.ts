import { executeWithTimeout, toRunError, type BatchReviewContext } from "@aqtools/core/runtime";

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

  const replacementsByPath = Map.groupBy(candidates, ({ path }) => path);
  const replacedPaths = new Set<string>();
  const repairedChanges: ReplaceChange[] = [];
  const unresolvedFailures: ReplacementFailure[] = [];
  const warnings = [...response.warnings];

  for (const failure of failures) {
    if (!failure.repairable || signal.aborted) {
      unresolvedFailures.push(failure);
      continue;
    }

    replacedPaths.add(failure.path);
    try {
      const repaired = await repairReplacement(
        failure,
        replacementsByPath.get(failure.path)!,
        context,
        baseline,
      );
      if (repaired.changes) repairedChanges.push(...repaired.changes);
      if (repaired.failure) unresolvedFailures.push(repaired.failure);
      else warnings.push(...repaired.warnings);
    } catch (cause) {
      const { code, message } = toRunError(cause);
      unresolvedFailures.push(withRepairError(failure, message, code));
    }
  }

  const changes = response.changes.filter(
    (change) => change.op !== "replace" || !replacedPaths.has(change.path),
  );
  return recordReplacementFailures(
    { ...response, changes: [...changes, ...repairedChanges], warnings },
    unresolvedFailures,
  );
};

const repairReplacement = async (
  failure: ReplacementFailure,
  patches: readonly ReplaceChange[],
  { policy, rules, request, session, timeoutMs, signal }: BatchReviewContext,
  baseline: ReadonlyMap<string, FileBaseline>,
) => {
  const { path } = failure;
  const repairRuleIds = new Set(patches.flatMap(({ ruleIds }) => ruleIds));
  const repairRules = rules.filter(({ id }) => repairRuleIds.has(id));
  const resources = request.ruleResources.filter(({ ruleId }) => repairRuleIds.has(ruleId));
  const repairPolicy = {
    ...policy,
    targets: [path],
    canWrite: (candidate: string) => candidate === path && policy.canWrite(candidate),
  };

  request.onProgress?.(`Repairing ${path}`);
  const repairResponse = await executeWithTimeout(
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

  const repaired = normalizeFormatResponse(
    repairResponse,
    repairRules,
    repairPolicy,
    request.ruleResources,
  );
  const changes = completedReplacements(repaired);
  const repairFailed =
    repaired.errors.length ||
    repaired.fileResults[0]?.status !== "completed" ||
    (changes.length === 0 && repaired.warnings.length === 0);
  if (repairFailed) {
    const reason = repaired.errors[0]?.message || repaired.fileResults[0]?.reason;
    return { failure: withRepairError(failure, reason || "No valid replacement was returned.") };
  }

  if (changes.length !== 0) {
    const verification = await planPartialFileReplacements(
      policy.projectRoot,
      changes,
      repairPolicy.canWrite,
      baseline,
    );
    const verificationFailure = verification.failures[0];
    if (verificationFailure) return { failure: verificationFailure, changes };
  }

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
