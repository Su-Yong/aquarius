import { DEFAULT_MAX_CONCURRENCY } from "../execution/runner";
import { AquariusError } from "../shared/errors";
import type { AdapterRunInfo, AdapterSessionContext } from "../adapter/types";
import type { ProjectConfig } from "../config/types";
import type { RunError, ToolKind } from "../shared/types";

import { buildExtractionCatalog } from "./catalog";
import { resolveExtractionConfig, type ExtractionConfigOptions } from "./config-context";
import { compressPresets } from "./presets";
import { createExtractionRunner } from "./runner";
import { collectExtractionTargets } from "./targets";
import { validateAndRepairVerdicts } from "./validate-repair";
import {
  assembleExtractedConfig,
  preflightExtractedConfigOutput,
  saveExtractedConfig,
} from "./write";
import type { ExtractionVerdict } from "./schemas";

export interface ExtractConfigOptions extends ExtractionConfigOptions {
  paths?: string[];
  ignorePaths?: string[];
  ignorePatterns?: string[];
  withNodeModules?: boolean;
  maxFiles?: number;
  maxConcurrency?: number;
  write?: boolean;
  output?: string;
  force?: boolean;
  merge?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface ExtractConfigResult {
  config: ProjectConfig;
  report: {
    sourceRoot: string;
    totalDiscovered: number;
    sampledCount: number;
    ai: AdapterRunInfo;
    findings: ExtractionVerdict[];
    warnings: RunError[];
    outputPath?: string;
  };
}

export const extractConfig = async (
  tool: ToolKind,
  options: ExtractConfigOptions,
): Promise<ExtractConfigResult> => {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  if (options.maxConcurrency !== undefined && !isPositiveInteger(options.maxConcurrency)) {
    throw new AquariusError(
      "INVALID_ARGUMENTS",
      "--max-concurrency must be a positive safe integer.",
    );
  }
  if (options.timeoutMs !== undefined && !isPositiveInteger(options.timeoutMs)) {
    throw new AquariusError("INVALID_ARGUMENTS", "--timeout-ms must be a positive safe integer.");
  }

  options.onProgress?.("Resolving plugins and AI adapter");
  const resolved = await resolveExtractionConfig(tool, options);
  const { config, plugins, candidates } = resolved;
  const sourceOptions = { ...options, cwd: config.cwd, signal };
  signal.throwIfAborted();
  await preflightExtractedConfigOutput(tool, sourceOptions);

  options.onProgress?.("Selecting source files");
  const { sourceRoot, readableFiles, totalDiscovered, sampledCount } =
    await collectExtractionTargets(sourceOptions);
  if (readableFiles.length === 0) {
    throw new AquariusError(
      "EXTRACT_NO_SOURCE_FILES",
      `No readable source files found in ${sourceRoot}.`,
    );
  }

  const { ai, findings, warnings, rules } = await analyzeExtraction(
    resolved,
    {
      projectRoot: sourceRoot,
      readableFiles,
      signal,
      onProgress: options.onProgress,
    },
    options.maxConcurrency,
  );
  signal.throwIfAborted();
  const insufficient = new Set(
    findings.filter(({ status }) => status === "insufficient_evidence").map(({ ruleId }) => ruleId),
  );
  const excluded = new Set(warnings.flatMap(({ ruleIds }) => ruleIds));
  const compressed = await compressPresets({
    config,
    plugins,
    candidates,
    rules,
    insufficient,
    excluded,
    signal,
  });
  const extracted = assembleExtractedConfig({
    tool,
    existing: resolved.existing,
    ai: resolved.ai,
    plugins: config.plugins,
    ...compressed,
  });
  const saved = await saveExtractedConfig(tool, extracted, {
    ...sourceOptions,
    observedRules: rules,
  });

  if (sampledCount < totalDiscovered) {
    warnings.unshift({
      code: "EXTRACT_FILES_SAMPLED",
      message: `Sampled ${sampledCount} of ${totalDiscovered} source files by directory and extension.`,
      ruleIds: [],
    });
  }

  return {
    config: saved.config,
    report: {
      sourceRoot,
      totalDiscovered,
      sampledCount,
      ai,
      findings,
      warnings,
      outputPath: saved.outputPath,
    },
  };
};

const analyzeExtraction = async (
  { config, plugins, candidates, adapter }: Awaited<ReturnType<typeof resolveExtractionConfig>>,
  source: Pick<AdapterSessionContext, "projectRoot" | "readableFiles" | "signal" | "onProgress">,
  maxConcurrency: number | undefined,
): Promise<Awaited<ReturnType<typeof validateAndRepairVerdicts>> & { ai: AdapterRunInfo }> => {
  const ai = { adapter: adapter.adapter.id };
  if (candidates.size === 0) return { ai, findings: [], warnings: [], rules: {} };

  const { signal } = source;
  source.onProgress?.(`Preparing catalog for ${candidates.size} rules`);
  const context: AdapterSessionContext = {
    ...source,
    ruleResources: await buildExtractionCatalog(config.tool, candidates),
    options: adapter.options,
  };
  signal.throwIfAborted();
  const session = await adapter.adapter.createSession(context);
  let validation: Awaited<ReturnType<typeof validateAndRepairVerdicts>>;
  let disposalFailure: { cause: unknown } | undefined;
  try {
    const runner = createExtractionRunner({
      tool: config.tool,
      session,
      context,
      timeoutMs: config.ai.timeoutMs,
      maxConcurrency: maxConcurrency ?? config.ai.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    });
    const { verdicts, ruleIds } = await runner.analyze();
    const analyzedCandidates = new Map([...candidates].filter(([id]) => ruleIds.has(id)));
    validation = await validateAndRepairVerdicts({
      config,
      plugins,
      candidates: analyzedCandidates,
      verdicts,
      repair: (issues) => runner.repair(issues, ruleIds),
      signal,
    });
  } finally {
    try {
      await session.dispose();
    } catch (cause) {
      disposalFailure = { cause };
    }
  }
  if (disposalFailure && !signal.aborted) throw disposalFailure.cause;
  return { ai: session.info ?? ai, ...validation };
};

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
