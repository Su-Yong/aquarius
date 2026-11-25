import { relative } from "node:path";
import { resolveAdapter } from "../adapter/resolve";
import { buildRuleResources } from "../adapter/rule-resources";
import { executeWithTimeout } from "../adapter/run";
import type { AdapterRunInfo, AdapterSessionContext } from "../adapter/types";
import { loadConfig } from "../config/load";
import { selectTargets } from "../files/targets";
import { prepareRules } from "../rules/prepare";
import { AquariusError, toRunError } from "../shared/errors";
import { isInside, toPosix } from "../shared/path";
import { notify } from "./analysis";
import { reviewBatches } from "./batches";
import { hasFailedReview } from "./results";
import type { RunError } from "../shared/types";
import type { ReviewResponse, ToolExecutionHooks, ToolExecutionOptions } from "./types";

export const DEFAULT_FILE_BATCH_SIZE = 4;
export const DEFAULT_MAX_CONCURRENCY = 3;

const cancelled = () => new AquariusError("AI_ABORTED", "Execution was cancelled.");

const assertNotCancelled = (signal: AbortSignal): void => {
  if (signal.aborted) throw cancelled();
};

export const runToolExecution = async <Details extends object, SnapshotDetails extends object>(
  options: ToolExecutionOptions<SnapshotDetails>,
  hooks: ToolExecutionHooks<Details, SnapshotDetails>,
): Promise<{
  response: ReviewResponse & Details;
  activeRules: number;
  totalFiles: number | null;
  ai?: AdapterRunInfo;
  exitCode: 0 | 2 | 130;
}> => {
  const signal = options.signal ?? new AbortController().signal;
  const progress = (message: string): void => notify(options.onProgress, message);
  const { tool, unreviewedFile, preparationFailedFile } = hooks;
  let activeRules = 0;
  let totalFiles: number | null = null;
  let ai: AdapterRunInfo | undefined;
  let requestStarted = false;
  let reviewed = false;
  let disposalError: RunError | undefined;
  let response: ReviewResponse & Details = {
    ...hooks.empty,
    errors: [],
    skippedRules: [],
    fileResults: [],
    retryable: false,
  };
  let analysis: ReturnType<typeof hooks.createAnalysis> | undefined;
  let finishBatches: ((result: ReviewResponse & Details) => void) | undefined;
  const result = () => ({
    response,
    activeRules,
    totalFiles,
    ...(ai && { ai }),
    exitCode: signal.aborted
      ? (130 as const)
      : hasFailedReview(response)
        ? (2 as const)
        : (0 as const),
  });

  try {
    const config = await loadConfig(tool, { cwd: options.cwd, configPath: options.configPath });
    const fileBatchSize =
      options.fileBatchSize ?? config.ai.fileBatchSize ?? DEFAULT_FILE_BATCH_SIZE;
    const maxConcurrency =
      options.maxConcurrency ?? config.ai.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    for (const [name, value] of Object.entries({ fileBatchSize, maxConcurrency })) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new AquariusError("INVALID_ARGUMENTS", `${name} must be a positive safe integer.`);
      }
    }

    progress("Preparing rules");
    const { rules, errors: preparationErrors } = await prepareRules(config, options.plugins);
    activeRules = rules.length;
    response.errors = preparationErrors;
    const preparationFailed = preparationErrors.length > 0;
    const nextStep = preparationFailed ? hooks.onPreparationError(preparationErrors) : "review";
    if (nextStep === "stop") {
      assertNotCancelled(signal);
      return result();
    }

    progress("Selecting files");
    const policy = await selectTargets(config, options);
    totalFiles = policy.targets.length;
    const initialOutcome = preparationFailed
      ? preparationFailedFile
      : activeRules === 0
        ? { status: "skipped" as const, reason: "No active rules." }
        : unreviewedFile;
    response.fileResults = policy.targets.map((path) => ({ path, ...initialOutcome }));
    assertNotCancelled(signal);
    if (totalFiles === 0 || activeRules === 0 || nextStep === "select") {
      return result();
    }

    const resolved = await resolveAdapter(config, options.adapter);
    const ruleResources = buildRuleResources(tool, rules);
    const fileOnly = rules.every(({ scope }) => scope === "file");
    const batched = fileOnly && (totalFiles > fileBatchSize || hooks.retrySingleFileGroup);
    if (!batched) {
      analysis = hooks.createAnalysis(rules, policy, ruleResources, {
        onUpdate: options.onAnalysisUpdate,
        onWarning: options.onWarning,
      });
    }
    assertNotCancelled(signal);
    await hooks.beforeReview?.(policy);
    assertNotCancelled(signal);

    const { projectRoot } = policy;
    const writeScope = {
      files: config.files,
      paths: options.paths?.length ? options.paths : ["."],
      pathsRelativeTo: isInside(projectRoot, config.cwd)
        ? toPosix(relative(projectRoot, config.cwd)) || "."
        : ".",
    };
    const context: Omit<AdapterSessionContext, "signal"> = {
      projectRoot,
      readableFiles: policy.readableFiles,
      ruleResources,
      options: resolved.options,
      onProgress: progress,
    };

    const session = await resolved.adapter.createSession({ ...context, signal });
    try {
      ai = session.info;
      if (ai) notify(options.onAdapterInfo, ai);
      assertNotCancelled(signal);
      progress(hooks.reviewProgress);
      assertNotCancelled(signal);
      requestStarted = true;
      const request = { ...context, outputSchema: hooks.outputSchema };
      if (batched) {
        const batches = await reviewBatches({
          session,
          request,
          rules,
          policy,
          hooks,
          writeScope,
          fileBatchSize,
          maxConcurrency,
          timeoutMs: config.ai.timeoutMs,
          signal,
          onUpdate: options.onAnalysisUpdate,
          onWarning: options.onWarning,
        });
        response = batches.response;
        finishBatches = batches.finish;
        if (!signal.aborted && hooks.afterBatches) {
          response = await hooks.afterBatches(response, {
            session,
            request,
            rules,
            policy,
            timeoutMs: config.ai.timeoutMs,
            signal,
          });
        }
      } else {
        const raw = await executeWithTimeout(
          session,
          {
            ...request,
            prompt: hooks.buildPrompt(ruleResources, policy, writeScope),
            onAnalysisUpdate: analysis?.update,
          },
          config.ai.timeoutMs,
          signal,
          { keepAlive: true },
        );
        await analysis?.flush();
        assertNotCancelled(signal);
        response = await hooks.normalize(raw, rules, policy, ruleResources);
      }
      reviewed = true;
    } finally {
      try {
        await session.dispose();
      } catch (cause) {
        disposalError = toRunError(cause);
      }
    }
    const hadDisposalError = disposalError !== undefined;
    if (disposalError) {
      response.errors = [...response.errors, disposalError];
      disposalError = undefined;
    }
    if (preparationFailed) {
      response.errors = [...preparationErrors, ...response.errors];
      response.fileResults = response.fileResults.map((file) => ({
        ...file,
        ...preparationFailedFile,
      }));
    }
    if (!signal.aborted) progress("Checking results");
    if (signal.aborted && !response.errors.some(({ code }) => code === "AI_ABORTED")) {
      if (unreviewedFile.status === "failed" && !finishBatches) reviewed = false;
      throw cancelled();
    }
    if (
      hooks.afterReview &&
      !signal.aborted &&
      !hadDisposalError &&
      !preparationFailed &&
      (!hasFailedReview(response) || (fileOnly && hooks.afterReviewOnFailure))
    ) {
      response = await hooks.afterReview(response, policy, rules);
    }
    if (finishBatches) finishBatches(response);
    else await analysis?.finish(response);
    if (signal.aborted && !response.errors.some(({ code }) => code === "AI_ABORTED")) {
      throw cancelled();
    }
    return result();
  } catch (cause) {
    const error = toRunError(cause);
    response.errors = [...response.errors, error, ...(disposalError ? [disposalError] : [])];
    if (!reviewed && (requestStarted || unreviewedFile.status === "failed")) {
      response.fileResults = response.fileResults.map((file) => ({
        ...file,
        status: "failed",
        reason: error.message,
      }));
    }
    if (finishBatches) finishBatches(response);
    else await analysis?.interrupt(response.errors);
    return result();
  }
};
