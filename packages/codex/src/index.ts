import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AquariusError,
  createReadonlySnapshot,
  defineAdapter,
  writeRuleResources,
  type AdapterExecuteRequest,
  type AdapterRunInfo,
  type SessionAdapter,
} from "@aquarius/core/adapter";
import { readEffectiveConfig, validateEffectiveConfig } from "./config-probe";
import { runExec } from "./exec";
import { resolveCodexExecutable } from "./executable";
import { codexOptionsSchema, type CodexSettings } from "./options";
import { buildCodexConfigOverrides, existingSensitivePaths, verifySandbox } from "./sandbox";
import { tomlString, tomlValue } from "./toml";

export {
  codexOptionsSchema,
  type AutoCompactScopeHint,
  type CodexOptions,
  type ReasoningEffortHint,
  type ReasoningSummaryHint,
  type ServiceTierHint,
  type VerbosityHint,
} from "./options";
export type { TomlValue } from "./toml";

const snapshotErrorCodes: Record<string, string> = {
  AI_ABORTED: "CODEX_ABORTED",
  FILE_PATH_INVALID: "CODEX_READABLE_PATH_INVALID",
  FILE_PATH_UNSUPPORTED: "CODEX_READABLE_PATH_UNSUPPORTED",
  FILE_SOURCE_CHANGED: "CODEX_SOURCE_CHANGED",
  SNAPSHOT_CONFLICT: "CODEX_READABLE_PATH_INVALID",
  SNAPSHOT_ROOT_INVALID: "CODEX_PROJECT_ROOT_INVALID",
};

const resourceErrorCodes: Record<string, string> = {
  AI_ABORTED: "CODEX_ABORTED",
  INVALID_RULE_RESOURCE: "CODEX_RULE_RESOURCES_INVALID",
  RULE_RESOURCE_CHANGED: "CODEX_RULE_RESOURCE_CHANGED",
  RULE_RESOURCE_CONFLICT: "CODEX_RULE_RESOURCE_CONFLICT",
};

const assertActive = (signal: AbortSignal): void => {
  if (signal.aborted) throw new AquariusError("CODEX_ABORTED", "Codex execution was aborted.");
};

const inheritSetting = <T>(option: T | null | undefined, effective: T | undefined): T | undefined =>
  option === null ? undefined : (option ?? effective);

const codexRunInfo = (settings: CodexSettings): AdapterRunInfo => {
  const details: Record<string, string> = {};
  if (settings.serviceTier !== undefined) details.serviceTier = settings.serviceTier;
  if (settings.reasoningEffort !== undefined)
    details["reasoning.effort"] = settings.reasoningEffort;
  if (settings.reasoningSummary !== undefined)
    details["reasoning.summary"] = settings.reasoningSummary;
  if (settings.verbosity !== undefined) details.verbosity = settings.verbosity;
  if (settings.contextWindow !== undefined)
    details["context.window"] = String(settings.contextWindow);
  return {
    adapter: "codex",
    ...(settings.model !== undefined && { model: settings.model }),
    ...(Object.keys(details).length > 0 && { details }),
  };
};

export const codexAdapter: SessionAdapter<ReturnType<typeof codexOptionsSchema.parse>> =
  defineAdapter({
    id: "codex",
    optionsSchema: codexOptionsSchema,
    async createSession(context) {
      const { readableFiles, ruleResources, signal, onProgress } = context;
      assertActive(signal);
      onProgress?.("Locating Codex");
      const {
        executable: explicit,
        ephemeral,
        model,
        serviceTier,
        verbosity,
        reasoning,
        context: modelContext,
        features,
        config,
      } = context.options;
      const executable = await resolveCodexExecutable(explicit);
      const projectRoot = await realpath(context.projectRoot);
      const runRoot = await mkdtemp(join(await realpath(tmpdir()), "aquarius-codex-"));
      const viewRoot = join(runRoot, "project");
      const cleanup = () => rm(runRoot, { recursive: true, force: true });

      try {
        assertActive(signal);
        await mkdir(viewRoot);
        onProgress?.(`Preparing snapshot (${readableFiles.length} context files)`);
        try {
          await createReadonlySnapshot(projectRoot, readableFiles, viewRoot, signal, onProgress);
        } catch (cause) {
          const code = cause instanceof AquariusError ? snapshotErrorCodes[cause.code] : undefined;
          if (code && cause instanceof Error) throw new AquariusError(code, cause.message);
          throw cause;
        }

        onProgress?.(`Preparing rule files (${ruleResources.length} rules)`);
        try {
          await writeRuleResources(ruleResources, viewRoot, signal);
        } catch (cause) {
          const code = cause instanceof AquariusError ? resourceErrorCodes[cause.code] : undefined;
          if (code && cause instanceof Error) throw new AquariusError(code, cause.message);
          throw new AquariusError(
            "CODEX_RULE_RESOURCES_FAILED",
            "Codex could not prepare its rule resource files.",
          );
        }

        const deniedPaths = await existingSensitivePaths(projectRoot);
        const diagnosticPaths = [viewRoot, runRoot, executable, ...deniedPaths];
        const overrides = [
          ...Object.entries(config ?? {}).map(([key, value]) => `${key}=${tomlValue(value)}`),
          ...buildCodexConfigOverrides(viewRoot, deniedPaths),
        ];
        onProgress?.("Checking Codex configuration");
        const effective = validateEffectiveConfig(
          await readEffectiveConfig(
            executable,
            viewRoot,
            overrides,
            signal,
            features,
            diagnosticPaths,
          ),
        );
        if (effective.windowsSandbox) {
          overrides.push(`windows.sandbox=${tomlString(effective.windowsSandbox)}`);
        }
        const settings: CodexSettings = {
          model: inheritSetting(model, effective.model),
          serviceTier: inheritSetting(serviceTier, effective.serviceTier),
          verbosity: inheritSetting(verbosity, effective.verbosity),
          reasoningEffort: inheritSetting(reasoning?.effort, effective.reasoningEffort),
          reasoningSummary: inheritSetting(reasoning?.summary, effective.reasoningSummary),
          contextWindow: inheritSetting(modelContext?.window, effective.contextWindow),
          autoCompactTokenLimit: inheritSetting(
            modelContext?.autoCompactTokenLimit,
            effective.autoCompactTokenLimit,
          ),
          autoCompactTokenLimitScope: inheritSetting(
            modelContext?.autoCompactTokenLimitScope,
            effective.autoCompactTokenLimitScope,
          ),
        };
        onProgress?.("Checking Codex read-only access");
        await verifySandbox(executable, viewRoot, projectRoot, overrides, signal);

        const active = new Set<Promise<unknown>>();
        const disposal = new AbortController();
        let disposed: Promise<void> | undefined;

        const execute = async (request: AdapterExecuteRequest): Promise<unknown> => {
          const requestSignal = AbortSignal.any([signal, request.signal, disposal.signal]);
          assertActive(requestSignal);
          const id = randomUUID();
          const schemaPath = join(runRoot, `schema-${id}.json`);
          const resultPath = join(runRoot, `result-${id}.json`);
          try {
            await writeFile(schemaPath, JSON.stringify(request.outputSchema), {
              flag: "wx",
              mode: 0o600,
            });
            return await runExec(
              executable,
              { ...request, readableFiles, ruleResources, signal: requestSignal },
              { ...settings, ephemeral, features },
              viewRoot,
              runRoot,
              schemaPath,
              resultPath,
              overrides,
              diagnosticPaths,
            );
          } finally {
            await Promise.all([rm(schemaPath, { force: true }), rm(resultPath, { force: true })]);
          }
        };

        return {
          info: codexRunInfo(settings),
          async execute(request: AdapterExecuteRequest) {
            const pending = execute(request);
            active.add(pending);
            try {
              return await pending;
            } finally {
              active.delete(pending);
            }
          },
          dispose() {
            if (!disposed) {
              disposal.abort();
              disposed = Promise.allSettled(active).then(cleanup);
            }
            return disposed;
          },
        };
      } catch (cause) {
        await cleanup().catch(() => {});
        throw cause;
      }
    },
  });

export default codexAdapter;
