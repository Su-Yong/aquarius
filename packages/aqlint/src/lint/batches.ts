import { AquariusError, callBridge, toRunError } from "@aquarius/core/internal";
import type {
  AiBridge,
  BridgeInput,
  JsonObject,
  PathPolicy,
  PreparedRule,
} from "@aquarius/core/internal";
import { createLintAnalysis } from "./analysis";
import { buildLintPrompt } from "./prompt";
import { groupDiagnostics, normalizeLintResponse, summarizeLintResult } from "./results";
import type { AnalysisUpdate } from "./schemas";
import type { LintAnalysisSnapshot, LintResult, RuleReview } from "./types";

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
  analysis: ReturnType<typeof createLintAnalysis>;
  onWarning?: (message: string) => void;
}

export const reviewLintBatches = async (options: BatchOptions): Promise<LintResult> => {
  const { rules, policy, input, analysis } = options;
  const batches: string[][] = [];
  for (let offset = 0; offset < policy.targets.length; offset += options.fileBatchSize) {
    batches.push(policy.targets.slice(offset, offset + options.fileBatchSize));
  }
  const results: LintResult[] = [];
  const reviewsByBatch = new Map<number, Map<string, RuleReview>>();
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let revision = 0;
  let nextBatch = 0;

  const runBatch = async (index: number): Promise<void> => {
    const batch = batches[index]!;
    const batchPolicy: PathPolicy = { ...policy, targets: batch };
    let batchResult: LintResult | undefined;
    let diagnosticCount = 0;
    const publish = (snapshot: LintAnalysisSnapshot): void => {
      const diagnostics: AnalysisUpdate["diagnostics"] = snapshot.diagnostics.map(
        (finding, id) => ({
          id: `${index}/diagnostic/${id}`,
          diagnostic: {
            ruleIds: finding.rules.map(({ rule }) => rule),
            message: finding.message,
            locations: finding.locations,
            evidence: finding.evidence,
          },
        }),
      );
      for (let id = diagnostics.length; id < diagnosticCount; id += 1) {
        diagnostics.push({ id: `${index}/diagnostic/${id}`, diagnostic: null });
      }
      diagnosticCount = snapshot.diagnostics.length;
      const failureReason = snapshot.errors[0]?.message ?? "File review did not finish.";
      reviewsByBatch.set(
        index,
        new Map<string, RuleReview>(
          snapshot.ruleResults.map((rule) => [
            rule.ruleId,
            snapshot.phase === "incomplete"
              ? { ruleId: rule.ruleId, status: "failed", reason: failureReason }
              : rule,
          ]),
        ),
      );
      const ruleResults = rules.map(({ id }): RuleReview => {
        const reviews = [...reviewsByBatch.values()].map((group) => group.get(id)!);
        const failed = reviews.find((rule) => rule.status === "failed");
        if (failed) return failed;
        const unfinished =
          reviews.length < batches.length ||
          reviews.some((rule) => rule.status === "pending" || rule.status === "in_progress");
        if (unfinished) {
          const active = reviews.findLast((rule) => rule.status !== "pending");
          if (!active) return { ruleId: id, status: "pending", reason: "" };
          return {
            ruleId: id,
            status: "in_progress",
            reason: active.status === "in_progress" ? active.reason : "Reviewing remaining files.",
          };
        }
        if (reviews.every((rule) => rule.status === "skipped")) {
          return {
            ruleId: id,
            status: "skipped",
            reason: [...new Set(reviews.map((rule) => rule.reason))].join(" "),
          };
        }
        return { ruleId: id, status: "completed", reason: "" };
      });
      let fileResults = snapshot.fileResults;
      if (snapshot.phase === "incomplete") {
        const findingPaths = new Set(
          snapshot.diagnostics.flatMap(({ locations }) => locations.map(({ path }) => path)),
        );
        const outcomes =
          batchResult?.fileResults ??
          snapshot.fileResults.map((file) => ({
            path: file.path,
            status: "failed" as const,
            reason: failureReason,
          }));
        fileResults = outcomes.map((file) => {
          if (file.status === "skipped" && findingPaths.has(file.path)) {
            return snapshot.fileResults.find(({ path }) => path === file.path)!;
          }
          return file;
        });
      }
      revision += 1;
      analysis.update({
        type: "aquarius.analysis_update",
        revision,
        diagnostics,
        fileResults,
        ruleResults,
      });
    };
    let previousErrors: LintResult["errors"] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      batchResult = undefined;
      const batchAnalysis = createLintAnalysis(rules, batchPolicy, {
        onUpdate: publish,
        onWarning: options.onWarning,
      });
      const feedback = previousErrors.length
        ? `The previous attempt left this file group incomplete: ${JSON.stringify(previousErrors)}. Re-examine the selected files and finish reviewing the rule index. Recover truncated reads with smaller ranges, and reach a supported conclusion from the available evidence. Do not invent a policy or violation when a rule prerequisite is absent.\n\n`
        : "";
      try {
        const raw = await callBridge(
          options.bridge,
          {
            ...input,
            prompt:
              feedback +
              buildLintPrompt(input.ruleResources.files, batchPolicy, options.writeScope),
            onAnalysisUpdate: batchAnalysis.update,
            onProgress: (message) =>
              input.onProgress?.(
                `File group ${index + 1}/${batches.length}${attempt ? " (retry)" : ""}: ${message}`,
              ),
          },
          options.timeoutMs,
          signal,
        );
        await batchAnalysis.flush();
        const result = await normalizeLintResponse(raw, rules, batchPolicy);
        batchResult = result;
        await batchAnalysis.finish(result);
        if (
          attempt === 0 &&
          result.errors.some(({ code }) => code.toUpperCase().includes("INCOMPLETE"))
        ) {
          previousErrors = result.errors;
          continue;
        }
        results[index] = result;
        return;
      } catch (cause) {
        await batchAnalysis.interrupt([toRunError(cause)]);
        throw cause;
      }
    }
  };

  const worker = async (): Promise<void> => {
    try {
      while (nextBatch < batches.length && !signal.aborted) {
        const index = nextBatch;
        nextBatch += 1;
        await runBatch(index);
      }
    } catch (cause) {
      controller.abort(cause);
      throw cause;
    }
  };
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(options.maxConcurrency, batches.length) }, worker),
  );
  await analysis.flush();
  const failure = workers.find((worker) => worker.status === "rejected");
  if (failure?.status === "rejected") throw controller.signal.reason ?? failure.reason;
  if (signal.aborted) throw new AquariusError("AI_ABORTED", "AI execution was cancelled.");

  const skippedRules: LintResult["skippedRules"] = [];
  for (const { id } of rules) {
    const reasons = results.map((result) =>
      result.errors.length === 0
        ? result.skippedRules.find(({ ruleId }) => ruleId === id)?.reason
        : undefined,
    );
    if (reasons.every((reason) => reason !== undefined)) {
      skippedRules.push({ ruleId: id, reason: [...new Set(reasons)].join(" ") });
    }
  }
  const result = {
    diagnostics: groupDiagnostics(results.flatMap((result) => result.diagnostics)),
    skippedRules,
    errors: results.flatMap((result) => result.errors),
    fileResults: results.flatMap((result) => result.fileResults),
  };
  return { ...result, summary: summarizeLintResult(result, rules.length, policy.targets.length) };
};
