import { AquariusError, callBridge, toRunError } from "@aquarius/core/internal";
import type {
  AiBridge,
  BridgeInput,
  JsonObject,
  PathPolicy,
  PreparedRule,
  RunError,
} from "@aquarius/core/internal";
import { createFormatAnalysis } from "./analysis";
import { buildFormatPrompt } from "./prompt";
import { normalizeFormatResponse } from "./results";
import type {
  FormatAnalysis,
  FormatAnalysisSnapshot,
  FormatResponse,
  FormatRuleReview,
} from "./types";

export const DEFAULT_FILE_BATCH_SIZE = 4;
export const DEFAULT_MAX_CONCURRENCY = 3;

interface BatchOptions {
  bridge: AiBridge;
  input: Omit<BridgeInput, "signal">;
  rules: readonly PreparedRule[];
  policy: PathPolicy;
  writeScope: JsonObject;
  fileBatchSize: number;
  maxConcurrency: number;
  timeoutMs: number;
  signal?: AbortSignal;
  analysis: FormatAnalysis;
  onWarning?: (message: string) => void;
}

const failedResponse = (paths: readonly string[], error: RunError): FormatResponse => ({
  changes: [],
  warnings: [],
  errors: [error],
  skippedRules: [],
  fileResults: paths.map((path) => ({ path, status: "failed", reason: error.message })),
  retryable: false,
});

const hasFailedReview = (response: FormatResponse): boolean =>
  response.errors.length > 0 || response.fileResults.some(({ status }) => status === "failed");

const mergeRuleReviews = (
  rules: readonly PreparedRule[],
  snapshots: readonly (FormatAnalysisSnapshot | undefined)[],
  receivedResponses: ReadonlySet<number>,
): FormatRuleReview[] =>
  rules.map(({ id }): FormatRuleReview => {
    const reports = snapshots.flatMap((snapshot, index) => {
      if (!snapshot) return [];
      if (snapshot.phase === "incomplete" && !receivedResponses.has(index)) {
        return [
          {
            ruleId: id,
            status: "failed" as const,
            reason: snapshot.errors[0]?.message ?? "File group review did not finish.",
          },
        ];
      }
      const report = snapshot.ruleResults.find(({ ruleId }) => ruleId === id);
      return report ? [report] : [];
    });
    const failure = reports.find(({ status }) => status === "failed");
    if (failure) return failure;
    const unfinished =
      reports.length < snapshots.length ||
      reports.some(({ status }) => status === "pending" || status === "in_progress");
    if (unfinished) {
      const started = reports.some(({ status }) => status !== "pending");
      return {
        ruleId: id,
        status: started ? "in_progress" : "pending",
        reason: started ? "Reviewing remaining file groups." : "",
      };
    }
    if (reports.every(({ status }) => status === "skipped")) {
      return {
        ruleId: id,
        status: "skipped",
        reason: [...new Set(reports.map(({ reason }) => reason))].join(" "),
      };
    }
    return { ruleId: id, status: "completed", reason: "" };
  });

export const reviewFormatBatches = async (options: BatchOptions): Promise<FormatResponse> => {
  const { rules, policy, input, analysis, signal } = options;
  const batches: string[][] = [];
  for (let offset = 0; offset < policy.targets.length; offset += options.fileBatchSize) {
    batches.push(policy.targets.slice(offset, offset + options.fileBatchSize));
  }
  const results: (FormatResponse | undefined)[] = Array.from({ length: batches.length });
  const snapshots: (FormatAnalysisSnapshot | undefined)[] = Array.from({ length: batches.length });
  const receivedResponses = new Set<number>();
  let revision = 0;
  let nextBatch = 0;
  let stopped = false;

  const publish = (): void => {
    revision += 1;
    analysis.update({
      type: "aquarius.analysis_update",
      revision,
      fileResults: snapshots.flatMap(
        (current, batchIndex) => results[batchIndex]?.fileResults ?? current?.fileResults ?? [],
      ),
      ruleResults: mergeRuleReviews(rules, snapshots, receivedResponses),
      proposedFiles: [
        ...new Set(snapshots.flatMap((current) => current?.proposedFiles ?? [])),
      ].sort(),
      warnings: snapshots.flatMap((current) => current?.warnings ?? []),
    });
  };

  const runBatch = async (index: number): Promise<void> => {
    const paths = batches[index]!;
    const targets = new Set(paths);
    const batchPolicy: PathPolicy = {
      ...policy,
      targets: paths,
      canWrite: (path) => targets.has(path) && policy.canWrite(path),
    };
    let previousErrors: RunError[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (stopped || signal?.aborted) return;
      results[index] = undefined;
      receivedResponses.delete(index);
      const batchAnalysis = createFormatAnalysis(rules, batchPolicy, input.ruleResources, {
        onUpdate: (snapshot) => {
          snapshots[index] = snapshot;
          publish();
        },
        onWarning: options.onWarning,
      });
      if (stopped || signal?.aborted) return;
      const feedback = previousErrors.length
        ? `The previous attempt did not finish this file group: ${JSON.stringify(previousErrors)}. Review every assigned file and rule, and return a complete result. Replace the previous proposal rather than combining both attempts.\n\n`
        : "";
      try {
        const raw = await callBridge(
          options.bridge,
          {
            ...input,
            prompt:
              feedback +
              buildFormatPrompt(input.ruleResources.files, batchPolicy, options.writeScope),
            onAnalysisUpdate: batchAnalysis.update,
            onProgress: (message) => {
              const retry = attempt > 0 ? " (retry)" : "";
              input.onProgress?.(`File group ${index + 1}/${batches.length}${retry}: ${message}`);
            },
          },
          options.timeoutMs,
          signal,
        );
        await batchAnalysis.flush();
        const response = normalizeFormatResponse(raw, rules, batchPolicy, input.ruleResources);
        receivedResponses.add(index);
        results[index] = response;
        const retry = attempt === 0 && response.retryable && !stopped && !signal?.aborted;
        if (hasFailedReview(response) && !retry) stopped = true;
        await batchAnalysis.finish(response);
        if (!retry || stopped || signal?.aborted) return;
        previousErrors = response.errors;
      } catch (cause) {
        const error = toRunError(cause);
        receivedResponses.delete(index);
        results[index] = failedResponse(paths, error);
        stopped = true;
        await batchAnalysis.interrupt([error]);
        return;
      }
    }
  };

  const worker = async (): Promise<void> => {
    while (nextBatch < batches.length && !stopped && !signal?.aborted) {
      const index = nextBatch;
      nextBatch += 1;
      await runBatch(index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.maxConcurrency, batches.length) }, worker),
  );

  const unstartedReason = signal?.aborted
    ? "Not started because formatting was cancelled."
    : "Not started because another file group failed.";
  const responses = batches.map(
    (paths, index): FormatResponse =>
      results[index] ?? {
        changes: [],
        warnings: [],
        errors: [],
        skippedRules: [],
        fileResults: paths.map((path) => ({ path, status: "skipped", reason: unstartedReason })),
        retryable: false,
      },
  );
  for (const [index, response] of responses.entries()) {
    results[index] = response;
  }
  const errors = responses.flatMap((response) => response.errors);
  if (signal?.aborted && !errors.some(({ code }) => code === "AI_ABORTED")) {
    errors.push(toRunError(new AquariusError("AI_ABORTED", "Execution was cancelled.")));
  }
  const skippedRules: FormatResponse["skippedRules"] = [];
  for (const { id } of rules) {
    const reasons = responses.map(
      (response) => response.skippedRules.find(({ ruleId }) => ruleId === id)?.reason,
    );
    if (reasons.length > 0 && reasons.every((reason) => reason !== undefined)) {
      skippedRules.push({ ruleId: id, reason: [...new Set(reasons)].join(" ") });
    }
  }
  publish();
  await analysis.flush();
  return {
    changes: responses.flatMap((response) => response.changes),
    warnings: responses.flatMap((response) => response.warnings),
    errors,
    skippedRules,
    fileResults: responses.flatMap((response) => response.fileResults),
    retryable: false,
  };
};
