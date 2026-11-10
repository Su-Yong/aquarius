import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { z } from "zod";
import {
  AquariusError,
  callBridge,
  captureBaseline,
  loadConfig,
  prepareRuleResources,
  prepareRules,
  resolveBridge,
  selectTargets,
  toRunError,
} from "@aquarius/core/internal";
import type {
  AiBridge,
  JsonObject,
  PreparedRuleResources,
  RulePlugin,
  TargetOptions,
} from "@aquarius/core/internal";
import { fixDiagnostics } from "./fix";
import { createLintAnalysis } from "./analysis";
import { DEFAULT_FILE_BATCH_SIZE, DEFAULT_MAX_CONCURRENCY, reviewLintBatches } from "./batches";
import { buildLintPrompt } from "./prompt";
import { normalizeLintResponse, summarizeLintResult } from "./results";
import { lintResponseSchema } from "./schemas";
import type { LintAnalysisSnapshot, LintExecutionResult, LintResult } from "./types";

export interface LintExecutionOptions extends TargetOptions {
  cwd: string;
  configPath?: string;
  fix?: boolean;
  fileBatchSize?: number;
  maxConcurrency?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onWarning?: (message: string) => void;
  onAnalysisUpdate?: (snapshot: LintAnalysisSnapshot) => void;
}

const emptyResult = (): LintResult => ({
  diagnostics: [],
  errors: [],
  skippedRules: [],
  fileResults: [],
  summary: {
    totalFiles: null,
    successFiles: 0,
    warningFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    activeRules: 0,
  },
});

const failFiles = (result: LintResult, reason: string): void => {
  result.fileResults = result.fileResults.map(({ path }) => ({
    path,
    status: "failed",
    reason,
  }));
  result.summary = summarizeLintResult(
    result,
    result.summary.activeRules,
    result.summary.totalFiles,
  );
};

export const executeLint = async (
  options: LintExecutionOptions,
  builtinPlugins: Record<string, RulePlugin> = {},
  suppliedBridge?: AiBridge,
): Promise<LintExecutionResult> => {
  let initial = emptyResult();
  let ruleResources: PreparedRuleResources | undefined;
  let analysis: ReturnType<typeof createLintAnalysis> | undefined;
  if (options.fix) initial.changedFiles = [];
  try {
    const config = await loadConfig("lint", { cwd: options.cwd, configPath: options.configPath });
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
    initial.errors.push(...prepared.errors);
    initial.summary.activeRules = prepared.rules.length;
    if (
      prepared.errors.some(({ code }) =>
        ["RULE_OPTIONS_INVALID", "RULE_SCHEMA_TRANSFORMED_OPTIONS"].includes(code),
      )
    ) {
      return { result: initial, exitCode: 2 };
    }

    options.onProgress?.("Selecting files");
    const policy = await selectTargets(config, options);
    initial.fileResults = policy.targets.map((path) => ({
      path,
      status: "failed",
      reason: "Analysis did not complete.",
    }));
    initial.summary = summarizeLintResult(initial, prepared.rules.length);
    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
    if (policy.targets.length === 0) {
      return { result: initial, exitCode: initial.errors.length ? 2 : 0 };
    }
    if (prepared.rules.length === 0) {
      if (initial.errors.length) {
        failFiles(initial, "Rule preparation did not complete.");
      } else {
        initial.fileResults = policy.targets.map((path) => ({
          path,
          status: "skipped",
          reason: "No active rules.",
        }));
        initial.summary = summarizeLintResult(initial, 0);
      }
      return { result: initial, exitCode: initial.errors.length ? 2 : 0 };
    }

    const beginAnalysis = () =>
      createLintAnalysis(prepared.rules, policy, {
        onUpdate: options.onAnalysisUpdate,
        onWarning: options.onWarning,
      });
    analysis = beginAnalysis();
    const baseline = options.fix
      ? await captureBaseline(config.projectRoot, policy.targets)
      : undefined;
    const bridge = suppliedBridge ?? (await resolveBridge(config));
    ruleResources = await prepareRuleResources({
      projectRoot: config.projectRoot,
      tool: "lint",
      rules: prepared.rules,
      signal: options.signal,
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
      prompt: buildLintPrompt(ruleResources.resources.files, policy, writeScope),
      ruleResources: ruleResources.resources,
      outputSchema: z.toJSONSchema(lintResponseSchema) as JsonObject,
      options: config.ai.options,
      onProgress: options.onProgress,
      onAnalysisUpdate: analysis.update,
    };
    const review = async (): Promise<LintResult> => {
      if (policy.targets.length > fileBatchSize) {
        return reviewLintBatches({
          bridge,
          input,
          rules: prepared.rules,
          policy,
          writeScope,
          fileBatchSize,
          maxConcurrency,
          timeoutMs: config.ai.timeoutMs,
          signal: options.signal,
          analysis: analysis!,
          onWarning: options.onWarning,
        });
      }
      const raw = await callBridge(
        bridge,
        { ...input, onAnalysisUpdate: analysis!.update },
        config.ai.timeoutMs,
        options.signal,
      );
      await analysis!.flush();
      return normalizeLintResponse(raw, prepared.rules, policy);
    };
    options.onProgress?.("Analyzing files with AI");
    let result = await review();
    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");

    options.onProgress?.("Checking results");
    result.errors.unshift(...prepared.errors);
    if (prepared.errors.length) failFiles(result, "Rule preparation did not complete.");
    initial = result;
    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
    if (options.fix) {
      result.changedFiles = [];
      if (
        !result.errors.length &&
        !result.fileResults.some(({ status }) => status === "failed") &&
        result.diagnostics.length
      ) {
        await analysis.finish(result, "provisional");
        options.onProgress?.("Fixing diagnostics");
        const fixed = await fixDiagnostics(
          result.diagnostics,
          ruleResources.resources,
          policy,
          config,
          bridge,
          baseline!,
          options.signal,
          options.onProgress,
        );
        const { changedFiles } = fixed;
        result.changedFiles = changedFiles;
        result.errors.push(...fixed.errors);
        if (fixed.errors.length) {
          failFiles(result, fixed.errors[0]!.message);
        }
        if (changedFiles.length) {
          result.diagnostics = [];
          options.onProgress?.("Checking fixes with AI");
          analysis = beginAnalysis();
          result = await review();
          if (options.signal?.aborted)
            throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
          result.changedFiles = changedFiles;
          initial = result;
        }
      }
    }
    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
    const exitCode =
      result.errors.length || result.fileResults.some(({ status }) => status === "failed")
        ? 2
        : result.diagnostics.some(({ severity }) => severity === "error")
          ? 1
          : 0;
    if (exitCode === 2) {
      await analysis.interrupt(result.errors);
    } else {
      await analysis.finish(result);
    }
    return { result, exitCode };
  } catch (cause) {
    const error = toRunError(cause);
    initial.errors.push(error);
    failFiles(initial, error.message);
    await analysis?.interrupt(initial.errors);
    return { result: initial, exitCode: options.signal?.aborted ? 130 : 2 };
  } finally {
    await ruleResources?.dispose();
  }
};
