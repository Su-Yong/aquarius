import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod";
import {
  AquariusError,
  callBridge,
  captureBaseline,
  loadConfig,
  prepareRules,
  resolveBridge,
  selectTargets,
  toRunError,
} from "@aquarius/core/internal";
import type { AiBridge, JsonObject, RulePlugin, TargetOptions } from "@aquarius/core/internal";
import { fixDiagnostics } from "./fix";
import { buildLintPrompt } from "./prompt";
import { normalizeLintResponse } from "./results";
import { lintResponseSchema } from "./schemas";
import type { LintExecutionResult, LintResult } from "./types";

export interface LintExecutionOptions extends TargetOptions {
  cwd: string;
  configPath?: string;
  fix?: boolean;
  signal?: AbortSignal;
}

const emptyResult = (): LintResult => ({ diagnostics: [], unknowns: [], errors: [] });

export const executeLint = async (
  options: LintExecutionOptions,
  builtinPlugins: Record<string, RulePlugin> = {},
  suppliedBridge?: AiBridge,
): Promise<LintExecutionResult> => {
  let initial = emptyResult();
  if (options.fix) initial.changedFiles = [];
  try {
    const config = await loadConfig("lint", { cwd: options.cwd, configPath: options.configPath });
    const selections = config.rules.filter(({ severity }) => severity !== "off");
    if (selections.length === 0) {
      if (options.paths?.length) await selectTargets(config, options);
      return { result: initial, exitCode: 0 };
    }

    const prepared = await prepareRules(config, builtinPlugins);
    initial.errors.push(...prepared.errors);
    if (prepared.rules.length === 0) {
      return { result: initial, exitCode: initial.errors.length ? 2 : 0 };
    }

    const policy = await selectTargets(config, options);
    if (policy.targets.length === 0) {
      return { result: initial, exitCode: initial.errors.length ? 2 : 0 };
    }
    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");

    const baseline = options.fix ? await captureBaseline(config.projectRoot, policy.targets) : undefined;
    const bridge = suppliedBridge ?? await resolveBridge(config);
    const prompt = buildLintPrompt(prepared.rules, policy, {
      files: config.files,
      paths: options.paths?.length ? options.paths : ["."],
      pathsRelativeTo: relative(config.projectRoot, config.cwd).replaceAll("\\", "/") || ".",
    });
    const input = {
      projectRoot: await realpath(config.projectRoot),
      readableFiles: policy.readableFiles,
      ignore: policy.ignoreRules,
      prompt,
      outputSchema: z.toJSONSchema(lintResponseSchema) as JsonObject,
      options: config.ai.options,
    };
    const raw = await callBridge(bridge, input, config.ai.timeoutMs, options.signal);
    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");

    let result = await normalizeLintResponse(raw, prepared.rules, policy);
    result.errors.unshift(...prepared.errors);
    if (options.fix) {
      result.changedFiles = [];
      initial = result;
      if (!result.errors.length && result.diagnostics.length) {
        const changedFiles = await fixDiagnostics(result.diagnostics, prepared.rules, policy, config, bridge, baseline!, options.signal);
        result.changedFiles = changedFiles;
        if (changedFiles.length) {
          result.diagnostics = [];
          result.unknowns = [];
          const checked = await callBridge(bridge, input, config.ai.timeoutMs, options.signal);
          if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
          result = await normalizeLintResponse(checked, prepared.rules, policy);
          result.changedFiles = changedFiles;
          initial = result;
        }
      }
    }
    const exitCode = result.errors.length
      ? 2
      : result.diagnostics.some(({ severity }) => severity === "error")
        ? 1
        : 0;
    return { result, exitCode };
  } catch (cause) {
    initial.errors.push(toRunError(cause));
    return { result: initial, exitCode: options.signal?.aborted ? 130 : 2 };
  }
};
