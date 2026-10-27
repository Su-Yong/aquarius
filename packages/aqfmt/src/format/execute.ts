import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import {
  AquariusError,
  callBridge,
  loadConfig,
  prepareRules,
  resolveBridge,
  selectTargets,
  toRunError,
  type AiBridge,
  type RulePlugin,
} from "@aquarius/core/internal";
import { applyFileChanges, captureBaseline, planFileChanges } from "../changes/apply";
import { createGitUndoStore, undoLastFileChanges } from "../undo/store";
import { buildFormatPrompt } from "./prompt";
import { normalizeFormatResponse } from "./results";
import { formatResponseJsonSchema } from "./schemas";
import type {
  FormatExecutionOptions,
  FormatExecutionResult,
  FormatResult,
} from "./types";

const emptyResult = (): FormatResult => ({ changedFiles: [], warnings: [], errors: [] });

export const executeFormat = async (
  options: FormatExecutionOptions,
  builtinPlugins: Record<string, RulePlugin> = {},
  suppliedBridge?: AiBridge,
): Promise<FormatExecutionResult> => {
  const initial = emptyResult();

  try {
    if (options.undo && (options.check || options.paths?.length)) {
      throw new AquariusError("INVALID_ARGUMENTS", "--undo cannot be combined with --check or target paths.");
    }

    const config = await loadConfig("format", { cwd: options.cwd, configPath: options.configPath });
    if (options.undo) {
      const restoredFiles = await undoLastFileChanges(config.projectRoot);
      return {
        result: { changedFiles: [], restoredFiles, warnings: [], errors: [] },
        exitCode: 0,
      };
    }

    const selections = config.rules.filter((rule) => rule.severity !== "off");
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

    const baseline = await captureBaseline(config.projectRoot, policy.targets);
    const bridge = suppliedBridge ?? await resolveBridge(config);
    const prompt = buildFormatPrompt(prepared.rules, policy, {
      files: config.files,
      paths: options.paths?.length ? options.paths : ["."],
      pathsRelativeTo: relative(config.projectRoot, config.cwd).replaceAll("\\", "/") || ".",
    });
    const raw = await callBridge(bridge, {
      projectRoot: await realpath(config.projectRoot),
      readableFiles: policy.readableFiles,
      ignore: policy.ignoreRules,
      prompt,
      outputSchema: formatResponseJsonSchema,
      options: config.ai.options,
    }, config.ai.timeoutMs, options.signal);
    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");

    const response = normalizeFormatResponse(raw, prepared.rules, policy);
    const result: FormatResult = {
      changedFiles: [],
      warnings: response.warnings,
      errors: [...prepared.errors, ...response.errors],
    };
    if (response.errors.length) return { result, exitCode: 2 };

    const plan = await planFileChanges(config.projectRoot, response.changes, policy.canWrite, baseline);
    if (options.check) {
      result.wouldChangeFiles = plan.files.map((file) => file.path);
      return { result, exitCode: result.errors.length ? 2 : plan.files.length ? 1 : 0 };
    }
    if (options.signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");

    if (plan.files.length) {
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
  }
};
