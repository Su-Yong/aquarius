import { executeWithTimeout } from "../adapter/run";
import type { PathPolicy } from "../files/types";
import type { PreparedRule } from "../rules/types";
import { AquariusError, toRunError } from "../shared/errors";
import type { JsonObject, RunError, SkippedRule } from "../shared/types";
import { finalRuleReviews, notify, pendingFileReview } from "./analysis";
import { hasFailedReview } from "./results";
import type {
  AnalysisSnapshot,
  BatchReviewContext,
  FileResult,
  ReviewResponse,
  RuleReview,
  ToolExecutionHooks,
} from "./types";

interface BatchOptions<
  Details extends object,
  SnapshotDetails extends object,
> extends BatchReviewContext {
  hooks: ToolExecutionHooks<Details, SnapshotDetails>;
  writeScope: JsonObject;
  fileBatchSize: number;
  maxConcurrency: number;
  onUpdate?: (snapshot: AnalysisSnapshot & SnapshotDetails) => void;
  onWarning?: (message: string) => void;
}

interface Group<Details, SnapshotDetails> {
  paths: string[];
  started: boolean;
  interrupted?: boolean;
  response?: ReviewResponse & Details;
  snapshot?: AnalysisSnapshot & SnapshotDetails;
}

const reviewFiles = (
  paths: readonly string[],
  status: FileResult["status"],
  reason: string,
): FileResult[] => paths.map((path) => ({ path, status, reason }));

const summarizeBatchReasons = (reasons: readonly string[]): string => {
  const [first = "", ...others] = new Set(reasons);
  return others.length ? `${first} (+${others.length} more batch reasons)` : first;
};

const mergeSkippedRules = <Details, SnapshotDetails>(
  rules: readonly PreparedRule[],
  groups: readonly Group<Details, SnapshotDetails>[],
): SkippedRule[] =>
  rules.flatMap(({ id }) => {
    const reasons = groups.map(({ response }) =>
      response && !hasFailedReview(response)
        ? response.skippedRules.find(({ ruleId }) => ruleId === id)?.reason
        : undefined,
    );
    return reasons.length && reasons.every((reason) => reason !== undefined)
      ? [{ ruleId: id, reason: summarizeBatchReasons(reasons) }]
      : [];
  });

const mergeRuleReviews = <Details, SnapshotDetails>(
  rules: readonly PreparedRule[],
  groups: readonly Group<Details, SnapshotDetails>[],
  finalResponse?: ReviewResponse,
): RuleReview[] => {
  const finalReviews = finalResponse && finalRuleReviews(rules, finalResponse);
  const reviewsByGroup = groups.map(({ response, snapshot }) =>
    response
      ? finalRuleReviews(rules, response)
      : finalResponse
        ? undefined
        : snapshot?.ruleResults,
  );
  return rules.map(({ id }, index): RuleReview => {
    const finalReview = finalReviews?.[index];
    if (finalReview?.status === "failed") return finalReview;

    const reviews = reviewsByGroup.map((group) => group?.[index]);
    const failed = reviews.find((rule) => rule?.status === "failed");
    if (failed) return failed;
    if (
      reviews.every(
        (rule): rule is RuleReview & { status: "skipped" } => rule?.status === "skipped",
      )
    ) {
      return {
        ruleId: id,
        status: "skipped",
        reason: summarizeBatchReasons(reviews.map(({ reason }) => reason)),
      };
    }
    if (reviews.every((rule) => rule?.status === "skipped" || rule?.status === "completed")) {
      return { ruleId: id, status: "completed", reason: "" };
    }
    if (finalResponse) {
      return {
        ruleId: id,
        status: "failed",
        reason: "Rule review did not complete for every file group.",
      };
    }
    return reviews.some((rule) => rule && rule.status !== "pending")
      ? { ruleId: id, status: "in_progress", reason: "Reviewing remaining file groups." }
      : { ruleId: id, status: "pending", reason: "" };
  });
};

export const reviewBatches = async <Details extends object, SnapshotDetails extends object>(
  options: BatchOptions<Details, SnapshotDetails>,
) => {
  const { hooks, request, rules, policy } = options;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  const groups: Group<Details, SnapshotDetails>[] = [];
  for (let offset = 0; offset < policy.targets.length; offset += options.fileBatchSize) {
    groups.push({
      paths: policy.targets.slice(offset, offset + options.fileBatchSize),
      started: false,
    });
  }
  let revision = 0;
  let nextGroup = 0;

  const groupOutcome = ({
    paths,
    started,
    response,
  }: Group<Details, SnapshotDetails>): FileResult[] => {
    if (response) return response.fileResults;
    if (options.signal.aborted) {
      return started
        ? reviewFiles(paths, "failed", "AI execution was cancelled.")
        : reviewFiles(paths, "skipped", "Not started because execution was cancelled.");
    }
    const reason = started
      ? "Cancelled because another file group failed."
      : "Not started because another file group failed.";
    return reviewFiles(paths, "skipped", reason);
  };
  const groupReviews = (group: Group<Details, SnapshotDetails>) => {
    if (group.response || signal.aborted) return groupOutcome(group);
    return group.snapshot?.fileResults ?? group.paths.map(pendingFileReview);
  };
  const publish = (response?: ReviewResponse & Details): void => {
    if (!options.onUpdate) return;
    const snapshots = groups.flatMap(({ snapshot }) => (snapshot ? [snapshot] : []));
    const failed = response && hasFailedReview(response);
    let details: SnapshotDetails;
    if (response && hooks.finalDetails) {
      const final = hooks.finalDetails(response);
      const unfinished = groups.flatMap(({ response, interrupted, snapshot }) =>
        snapshot && (!response || interrupted) ? [snapshot] : [],
      );
      details = unfinished.length ? hooks.mergeAnalysis([final, ...unfinished]) : final;
    } else {
      details = hooks.mergeAnalysis(snapshots);
    }
    const snapshot: AnalysisSnapshot & SnapshotDetails = {
      ...details,
      phase: response ? (failed ? "incomplete" : "final") : "provisional",
      revision: ++revision,
      fileResults: response?.fileResults ?? groups.flatMap(groupReviews),
      ruleResults: mergeRuleReviews(rules, groups, response),
      errors: response?.errors ?? [],
    };
    notify(options.onUpdate, structuredClone(snapshot), () =>
      notify(
        options.onWarning,
        "The provisional analysis observer failed; analysis will continue.",
      ),
    );
  };

  const runGroup = async (group: Group<Details, SnapshotDetails>, index: number): Promise<void> => {
    const targets = new Set(group.paths);
    const groupPolicy: PathPolicy = {
      ...policy,
      targets: group.paths,
      canWrite: (path) => targets.has(path) && policy.canWrite(path),
    };
    let previousErrors: RunError[] = [];
    for (let attempt = 0; attempt < 2 && !signal.aborted; attempt += 1) {
      const analysis = hooks.createAnalysis(rules, groupPolicy, request.ruleResources, {
        onWarning: options.onWarning,
        onUpdate: (snapshot) => {
          group.snapshot = snapshot;
          publish();
        },
      });
      const feedback = previousErrors.length
        ? `The previous attempt left this file group incomplete: ${JSON.stringify(previousErrors)}. Review every assigned file and rule and return a complete result. Replace the previous response rather than combining both attempts.\n\n`
        : "";
      const progressPrefix =
        groups.length > 1
          ? `File group ${index + 1}/${groups.length}${attempt ? " (retry)" : ""}: `
          : "";
      if (signal.aborted) return;
      group.started = true;
      try {
        const raw = await executeWithTimeout(
          options.session,
          {
            ...request,
            prompt:
              feedback + hooks.buildPrompt(request.ruleResources, groupPolicy, options.writeScope),
            onAnalysisUpdate: analysis.update,
            onProgress: (message) => request.onProgress?.(`${progressPrefix}${message}`),
          },
          options.timeoutMs,
          signal,
          { keepAlive: true },
        );

        if (signal.aborted) return;
        const response = await hooks.normalize(raw, rules, groupPolicy, request.ruleResources);
        if (signal.aborted) return;
        if (attempt === 0 && response.retryable) {
          previousErrors = response.errors;
          await analysis.flush();
          continue;
        }

        group.response = hooks.afterBatch
          ? await hooks.afterBatch(response, {
              policy: groupPolicy,
              rules,
              session: options.session,
              request,
              signal,
              timeoutMs: options.timeoutMs,
            })
          : response;
        if (!hooks.continueOnBatchFailure && hasFailedReview(group.response)) controller.abort();
        await analysis.finish(group.response);
        return;
      } catch (cause) {
        if (signal.aborted) {
          await analysis.flush();
          return;
        }
        const error = toRunError(cause);
        group.interrupted = true;
        group.response = {
          ...hooks.empty,
          fileResults: reviewFiles(group.paths, "failed", error.message),
          errors: [error],
          skippedRules: [],
          retryable: false,
        };
        if (!hooks.continueOnBatchFailure) controller.abort();
        await analysis.interrupt([error]);
        return;
      }
    }
  };

  const worker = async (): Promise<void> => {
    while (nextGroup < groups.length && !signal.aborted) {
      const index = nextGroup;
      nextGroup += 1;
      await runGroup(groups[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.maxConcurrency, groups.length) }, worker),
  );

  const responses = groups.flatMap(({ response }) => (response ? [response] : []));
  const errors = responses.flatMap((response) => response.errors);
  if (options.signal.aborted && !errors.some(({ code }) => code === "AI_ABORTED")) {
    errors.push(toRunError(new AquariusError("AI_ABORTED", "Execution was cancelled.")));
  }
  const response: ReviewResponse & Details = {
    ...hooks.merge(responses),
    fileResults: groups.flatMap(groupOutcome),
    errors,
    skippedRules: mergeSkippedRules(rules, groups),
    retryable: false,
  };
  return { response, finish: (final: ReviewResponse & Details) => publish(final) };
};
