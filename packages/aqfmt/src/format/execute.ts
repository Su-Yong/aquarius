import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import {
  AquariusError,
  callBridge,
  loadConfig,
  prepareRuleResources,
  prepareRules,
  resolveBridge,
  selectTargets,
  toRunError,
  type AiBridge,
  type PreparedRuleResources,
  type RulePlugin,
} from "@aquarius/core/internal";
import { applyFileChanges, captureBaseline, planFileChanges } from "../changes/apply";
import { createGitUndoStore, undoLastFileChanges } from "../undo/store";
import { createFormatAnalysis } from "./analysis";
import { DEFAULT_FILE_BATCH_SIZE, DEFAULT_MAX_CONCURRENCY, reviewFormatBatches } from "./batches";
import { buildFormatPrompt } from "./prompt";
import { formatChangePaths, normalizeFormatResponse, summarizeFormatResult } from "./results";
import { formatResponseJsonSchema } from "./schemas";
import type {
  FormatAnalysis,
  FormatExecutionOptions,
  FormatExecutionResult,
  FormatResponse,
  FormatResult,
} from "./types";

const emptyResult = (): FormatResult => ({
  changedFiles: [],
  proposedFiles: [],
  skippedRules: [],
  warnings: [],
  errors: [],
  fileResults: [],
  summary: summarizeFormatResult([], 0, null),
});

export const executeFormat = async (
  options: FormatExecutionOptions,
  builtinPlugins: Record<string, RulePlugin> = {},
  suppliedBridge?: AiBridge,
): Promise<FormatExecutionResult> => {
  const result = emptyResult();
  let preparedResources: PreparedRuleResources | undefined;
  let analysis: FormatAnalysis | undefined;
  let requestStarted = false;
  let response: FormatResponse | undefined;

  try {
    if (options.undo && (options.check || options.paths?.length)) {
      throw new AquariusError(
        "INVALID_ARGUMENTS",
        "--undo cannot be combined with --check or target paths.",
      );
    }

    const config = await loadConfig("format", { cwd: options.cwd, configPath: options.configPath });
    if (options.undo) {
      options.onProgress?.("Restoring files");
      const restoredFiles = await undoLastFileChanges(config.projectRoot);
      return {
        result: { ...result, restoredFiles },
        exitCode: 0,
      };
    }

    const fileBatchSize =
      options.fileBatchSize ?? config.ai.fileBatchSize ?? DEFAULT_FILE_BATCH_SIZE;
    const maxConcurrency =
      options.maxConcurrency ?? config.ai.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    for (const [name, value] of Object.entries({ fileBatchSize, maxConcurrency })) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new AquariusError("INVALID_ARGUMENTS", `${name} must be a positive safe integer.`);
      }
    }

    options.onProgress?.("Preparing rules");
    const prepared = await prepareRules(config, builtinPlugins);
    result.errors.push(...prepared.errors);
    result.summary.activeRules = prepared.rules.length;

    options.onProgress?.("Selecting files");
    const policy = await selectTargets(config, options);
    let skipReason = "Formatting did not start.";
    if (prepared.errors.length) {
      skipReason = "Rule preparation failed; formatting did not start.";
    } else if (prepared.rules.length === 0) {
      skipReason = "No active rules.";
    }
    result.fileResults = policy.targets.map((path) => ({
      path,
      status: "skipped",
      reason: skipReason,
    }));
    result.summary = summarizeFormatResult(result.fileResults, prepared.rules.length);
    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
    if (prepared.errors.length || prepared.rules.length === 0 || policy.targets.length === 0) {
      return { result, exitCode: result.errors.length ? 2 : 0 };
    }

    const baseline = await captureBaseline(config.projectRoot, policy.targets);
    const bridge = suppliedBridge ?? (await resolveBridge(config));
    preparedResources = await prepareRuleResources({
      projectRoot: config.projectRoot,
      tool: "format",
      rules: prepared.rules,
      signal: options.signal,
      onWarning: options.onWarning,
    });
    const ruleResources = preparedResources.resources;
    analysis = createFormatAnalysis(prepared.rules, policy, ruleResources, {
      onUpdate: options.onAnalysisUpdate,
      onWarning: options.onWarning,
    });
    const cwdRelative = relative(config.projectRoot, config.cwd).replaceAll("\\", "/");
    const pathsRelativeTo =
      !options.paths?.length &&
      (cwdRelative === ".." || cwdRelative.startsWith("../") || isAbsolute(cwdRelative))
        ? "."
        : cwdRelative || ".";
    const writeScope = {
      files: config.files,
      paths: options.paths?.length ? options.paths : ["."],
      pathsRelativeTo,
    };
    const input = {
      projectRoot: await realpath(config.projectRoot),
      readableFiles: policy.readableFiles,
      ignore: policy.ignoreRules,
      prompt: buildFormatPrompt(ruleResources.files, policy, writeScope),
      ruleResources,
      outputSchema: formatResponseJsonSchema,
      options: config.ai.options,
      onProgress: options.onProgress,
      onAnalysisUpdate: analysis.update,
    };
    options.onProgress?.("Formatting files with AI");
    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
    requestStarted = true;
    if (prepared.rules.every(({ scope }) => scope === "file")) {
      response = await reviewFormatBatches({
        bridge,
        input,
        rules: prepared.rules,
        policy,
        writeScope,
        fileBatchSize,
        maxConcurrency,
        timeoutMs: config.ai.timeoutMs,
        signal: options.signal,
        analysis,
        onWarning: options.onWarning,
      });
    } else {
      const raw = await callBridge(bridge, input, config.ai.timeoutMs, options.signal);
      await analysis.flush();
      response = normalizeFormatResponse(raw, prepared.rules, policy, ruleResources);
    }

    options.onProgress?.("Checking changes");
    result.skippedRules = response.skippedRules;
    result.warnings = [...response.warnings];
    result.errors.push(...response.errors);
    result.fileResults = response.fileResults;
    result.proposedFiles = formatChangePaths(response.changes);
    result.summary = summarizeFormatResult(result.fileResults, prepared.rules.length);
    if (options.signal?.aborted) {
      if (!result.errors.some(({ code }) => code === "AI_ABORTED")) {
        result.errors.push(toRunError(new AquariusError("AI_ABORTED", "Execution was cancelled.")));
      }
      await analysis.interrupt(result.errors);
      return { result, exitCode: 130 };
    }
    if (result.errors.length || result.fileResults.some(({ status }) => status === "failed")) {
      await analysis.interrupt(result.errors);
      return { result, exitCode: 2 };
    }

    const plan = await planFileChanges(
      config.projectRoot,
      response.changes,
      policy.canWrite,
      baseline,
    );
    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
    if (options.check) {
      result.wouldChangeFiles = plan.files.map((file) => file.path);
      await analysis.finish(response);
      if (options.signal?.aborted)
        throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
      return { result, exitCode: plan.files.length ? 1 : 0 };
    }
    if (plan.files.length) {
      options.onProgress?.("Writing changes");
      const store = await createGitUndoStore(config.projectRoot);
      if (options.signal?.aborted)
        throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
      const applied = await applyFileChanges(plan, store);
      result.changedFiles = applied.changedFiles;
      if (!applied.undoAvailable) {
        result.warnings.push({
          code: "UNDO_UNAVAILABLE",
          ruleIds: [],
          paths: [],
          message: "Formatting completed without Git undo support.",
        });
      }
    }

    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
    await analysis.finish({ ...response, warnings: result.warnings });
    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
    return { result, exitCode: 0 };
  } catch (cause) {
    const error = toRunError(cause);
    result.errors.push(error);
    if (requestStarted && !response) {
      result.fileResults = result.fileResults.map(({ path }) => ({
        path,
        status: "failed",
        reason: error.message,
      }));
    } else if (!requestStarted) {
      result.fileResults = result.fileResults.map(({ path }) => ({
        path,
        status: "skipped",
        reason: `Formatting did not start: ${error.message}`,
      }));
    }
    result.summary = summarizeFormatResult(
      result.fileResults,
      result.summary.activeRules,
      result.summary.totalFiles,
    );
    await analysis?.interrupt(result.errors);
    return { result, exitCode: options.signal?.aborted ? 130 : 2 };
  } finally {
    await preparedResources?.dispose();
  }
};
