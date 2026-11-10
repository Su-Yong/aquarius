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
import { buildFormatPrompt } from "./prompt";
import { normalizeFormatResponse } from "./results";
import { formatResponseJsonSchema } from "./schemas";
import type { FormatExecutionOptions, FormatExecutionResult, FormatResult } from "./types";

const emptyResult = (): FormatResult => ({
  changedFiles: [],
  skippedRules: [],
  warnings: [],
  errors: [],
});

export const executeFormat = async (
  options: FormatExecutionOptions,
  builtinPlugins: Record<string, RulePlugin> = {},
  suppliedBridge?: AiBridge,
): Promise<FormatExecutionResult> => {
  const initial = emptyResult();
  let preparedResources: PreparedRuleResources | undefined;

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
        result: { ...initial, restoredFiles },
        exitCode: 0,
      };
    }

    options.onProgress?.("Preparing rules");
    const prepared = await prepareRules(config, builtinPlugins);
    initial.errors.push(...prepared.errors);
    if (
      prepared.errors.some(({ code }) =>
        ["RULE_OPTIONS_INVALID", "RULE_SCHEMA_TRANSFORMED_OPTIONS"].includes(code),
      )
    ) {
      return { result: initial, exitCode: 2 };
    }
    if (prepared.rules.length === 0) {
      if (options.paths?.length) {
        await selectTargets(config, options);
      }
      return { result: initial, exitCode: initial.errors.length ? 2 : 0 };
    }

    options.onProgress?.("Selecting files");
    const policy = await selectTargets(config, options);
    if (policy.targets.length === 0) {
      return { result: initial, exitCode: initial.errors.length ? 2 : 0 };
    }
    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");

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
    const cwdRelative = relative(config.projectRoot, config.cwd).replaceAll("\\", "/");
    const pathsRelativeTo =
      !options.paths?.length &&
      (cwdRelative === ".." || cwdRelative.startsWith("../") || isAbsolute(cwdRelative))
        ? "."
        : cwdRelative || ".";
    const prompt = buildFormatPrompt(ruleResources.files, policy, {
      files: config.files,
      paths: options.paths?.length ? options.paths : ["."],
      pathsRelativeTo,
    });
    options.onProgress?.("Formatting files with AI");
    const raw = await callBridge(
      bridge,
      {
        projectRoot: await realpath(config.projectRoot),
        readableFiles: policy.readableFiles,
        ignore: policy.ignoreRules,
        prompt,
        ruleResources,
        outputSchema: formatResponseJsonSchema,
        options: config.ai.options,
        onProgress: options.onProgress,
      },
      config.ai.timeoutMs,
      options.signal,
    );
    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");

    options.onProgress?.("Checking changes");
    const response = normalizeFormatResponse(raw, prepared.rules, policy, ruleResources);
    const result: FormatResult = {
      changedFiles: [],
      skippedRules: response.skippedRules,
      warnings: response.warnings,
      errors: [...prepared.errors, ...response.errors],
    };
    if (response.errors.length) return { result, exitCode: 2 };

    const plan = await planFileChanges(
      config.projectRoot,
      response.changes,
      policy.canWrite,
      baseline,
    );
    if (options.check) {
      result.wouldChangeFiles = plan.files.map((file) => file.path);
      return { result, exitCode: result.errors.length ? 2 : plan.files.length ? 1 : 0 };
    }
    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");

    if (plan.files.length) {
      options.onProgress?.("Writing changes");
      const store = await createGitUndoStore(config.projectRoot);
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

    return { result, exitCode: result.errors.length ? 2 : 0 };
  } catch (cause) {
    initial.errors.push(toRunError(cause));
    return { result: initial, exitCode: options.signal?.aborted ? 130 : 2 };
  } finally {
    await preparedResources?.dispose();
  }
};
