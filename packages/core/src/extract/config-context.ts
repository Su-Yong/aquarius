import { fstatSync } from "node:fs";
import { stat } from "node:fs/promises";

import { resolveAdapter } from "../adapter/resolve";
import {
  findProjectConfig,
  normalizeConfig,
  readConfig,
  resolveDirectory,
  validateConfig,
} from "../config/load";
import { loadRulePlugins } from "../rules/prepare";
import { AquariusError } from "../shared/errors";
import type { ProjectConfig } from "../config/types";
import type { FormatRule, LintRule } from "../rules/types";
import type { JsonObject, ToolKind } from "../shared/types";

export interface ExtractionConfigOptions {
  cwd: string;
  configPath?: string;
  plugins?: string[];
  adapter?: string;
  aiOptions?: JsonObject;
  timeoutMs?: number;
  stdoutFd?: number;
}

export const resolveExtractionConfig = async (tool: ToolKind, options: ExtractionConfigOptions) => {
  const cwd = await resolveDirectory(options.cwd);
  const configPath = await findProjectConfig(
    tool,
    cwd,
    options.configPath,
    redirectedConfig(options.stdoutFd),
  );
  const existing =
    configPath === undefined ? undefined : validateConfig(tool, await readConfig(configPath));
  const pluginNames = options.plugins?.length ? options.plugins : existing?.plugins;
  if (!pluginNames?.length) {
    throw new AquariusError(
      "EXTRACT_PLUGIN_REQUIRED",
      "Specify at least one --plugin to extract configuration.",
    );
  }

  const ai: NonNullable<ProjectConfig["ai"]> = { ...existing?.ai };
  if (options.adapter !== undefined && options.adapter !== ai.adapter) {
    ai.adapter = options.adapter;
    delete ai.options;
  }
  if (options.aiOptions !== undefined) ai.options = options.aiOptions;
  if (options.timeoutMs !== undefined) ai.timeoutMs = options.timeoutMs;
  if (!ai.adapter) {
    throw new AquariusError(
      "AI_ADAPTER_REQUIRED",
      "Specify --adapter or set ai.adapter in the project configuration.",
    );
  }

  const config = normalizeConfig(tool, cwd, validateConfig(tool, { plugins: pluginNames, ai }));
  const registry = await loadRulePlugins(config);
  if (registry.errors.length > 0) {
    throw new AquariusError(
      registry.errors[0]!.code,
      registry.errors.map(({ message }) => message).join("\n"),
    );
  }

  const adapter = await resolveAdapter(config);
  const candidates: Map<string, FormatRule | LintRule> =
    tool === "lint" ? registry.lintRules : registry.formatRules;
  candidates.delete("aquarius/custom/semantic-policy");

  return {
    config,
    existing,
    ai,
    adapter,
    candidates,
    plugins: Object.fromEntries(registry.modules),
  };
};

const redirectedConfig = (stdoutFd: number | undefined) => {
  if (stdoutFd === undefined) return undefined;
  const output = fstatSync(stdoutFd);
  if (!output.isFile() || output.size !== 0) return undefined;

  // A shell redirection creates or truncates stdout's destination before the CLI starts.
  return async (candidate: string): Promise<boolean> => {
    const input = await stat(candidate);
    return input.dev === output.dev && input.ino === output.ino && input.size === 0;
  };
};
