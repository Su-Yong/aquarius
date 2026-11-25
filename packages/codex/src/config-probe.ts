import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  AquariusError,
  attachAbort,
  terminateChild,
  waitForTermination,
} from "@aquarius/core/adapter";
import { captureStderr, withDiagnostic } from "./diagnostic";
import {
  DISABLED_FEATURES,
  featureArguments,
  type CodexOptions,
  type CodexSettings,
} from "./options";
import { configArguments } from "./toml";

export const PROFILE_NAME = "aquarius-read";
const CONFIG_PROBE_TIMEOUT_MS = 15_000;

interface EffectiveConfigResponse {
  config?: Record<string, unknown>;
  origins?: Record<string, unknown>;
}

export const readEffectiveConfig = async (
  executable: string,
  cwd: string,
  overrides: readonly string[],
  signal: AbortSignal,
  features: CodexOptions["features"],
  diagnosticPaths: readonly string[],
): Promise<EffectiveConfigResponse> => {
  if (signal.aborted) throw new AquariusError("CODEX_ABORTED", "Codex execution was aborted.");
  const child = spawn(
    executable,
    [
      "app-server",
      "--listen",
      "stdio://",
      ...configArguments(overrides),
      ...featureArguments(features),
    ],
    { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const detachAbort = attachAbort(child, signal);
  const stderr = captureStderr(child.stderr);
  const probeError = (message: string, reason: unknown = stderr()) =>
    new AquariusError(
      "CODEX_CONFIG_PROBE_FAILED",
      withDiagnostic(message, reason, diagnosticPaths),
    );

  try {
    return await new Promise<EffectiveConfigResponse>((resolvePromise, rejectPromise) => {
      let settled = false;
      const reader = createInterface({ input: child.stdout });
      const timer = setTimeout(() => {
        finish(probeError("Codex effective configuration probe timed out."));
      }, CONFIG_PROBE_TIMEOUT_MS);
      timer.unref();

      const finish = (error?: Error, value?: EffectiveConfigResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reader.close();
        if (error) rejectPromise(error);
        else resolvePromise(value ?? {});
      };

      reader.on("line", (line) => {
        if (settled) return;
        let message: Record<string, unknown> | undefined;
        try {
          message = asRecord(JSON.parse(line));
        } catch {}
        if (!message) {
          finish(probeError("Codex config probe returned invalid JSON."));
          return;
        }
        if (message.id === 0) {
          if (message.error) {
            finish(
              probeError(
                "Codex rejected config probe initialization.",
                asRecord(message.error)?.message,
              ),
            );
            return;
          }
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(
            `${JSON.stringify({ method: "config/read", id: 2, params: { includeLayers: true, cwd } })}\n`,
          );
          return;
        }
        if (message.id === 2) {
          if (message.error)
            finish(
              probeError(
                "Codex rejected the effective configuration probe.",
                asRecord(message.error)?.message,
              ),
            );
          else finish(undefined, (message.result ?? {}) as EffectiveConfigResponse);
        }
      });
      child.once("error", (error) =>
        finish(probeError("Codex config probe could not start.", error.message)),
      );
      child.stdin.once("error", (error: NodeJS.ErrnoException) => {
        if (signal.aborted)
          finish(new AquariusError("CODEX_ABORTED", "Codex execution was aborted."));
        else if (error.code !== "EPIPE")
          finish(probeError("Codex config probe could not send a request."));
      });
      child.once("close", (code) => {
        if (settled) return;
        if (signal.aborted)
          finish(new AquariusError("CODEX_ABORTED", "Codex execution was aborted."));
        else
          finish(probeError(`Codex config probe exited before responding (${code ?? "signal"}).`));
      });
      child.stdin.write(
        `${JSON.stringify({ method: "initialize", id: 0, params: { clientInfo: { name: "aquarius", title: "Aquarius", version: "0.1.0" } } })}\n`,
      );
    });
  } finally {
    detachAbort();
    terminateChild(child);
    await waitForTermination(child);
  }
};

export const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

const originType = (origin: unknown): string | undefined => {
  return asRecord(asRecord(origin)?.name)?.type as string | undefined;
};

const configuredText = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim() || undefined : undefined;

const configuredCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

export const validateEffectiveConfig = (
  response: EffectiveConfigResponse,
): CodexSettings & { windowsSandbox?: string } => {
  const config = asRecord(response.config);
  if (!config)
    throw new AquariusError(
      "CODEX_POLICY_UNVERIFIED",
      "Codex did not return an effective configuration.",
    );
  const defaultPermissions = config.defaultPermissions ?? config.default_permissions;
  if (defaultPermissions !== PROFILE_NAME)
    throw new AquariusError(
      "CODEX_POLICY_UNVERIFIED",
      "Codex did not select the Aquarius permission profile.",
    );

  const profile = asRecord(asRecord(config.permissions)?.[PROFILE_NAME]);
  const filesystem = asRecord(profile?.filesystem);
  if (
    profile?.extends != null ||
    filesystem?.[":root"] !== "read" ||
    Object.entries(filesystem).some(
      ([path, access]) => path !== ":root" && path !== "glob_scan_max_depth" && access !== "deny",
    )
  ) {
    throw new AquariusError(
      "CODEX_POLICY_UNVERIFIED",
      "Codex did not retain the Aquarius read-only filesystem profile.",
    );
  }
  const network = asRecord(profile?.network);
  if (network?.enabled !== undefined && network.enabled !== false) {
    throw new AquariusError(
      "CODEX_POLICY_UNVERIFIED",
      "Codex did not retain the Aquarius network restriction.",
    );
  }
  const projectDocMaxBytes = config.projectDocMaxBytes ?? config.project_doc_max_bytes;
  const webSearch = config.webSearch ?? config.web_search;
  if (projectDocMaxBytes !== 0 || webSearch !== "disabled") {
    throw new AquariusError(
      "CODEX_POLICY_UNVERIFIED",
      "Codex project instructions or web search could not be disabled.",
    );
  }

  const features = asRecord(config.features) ?? {};
  for (const feature of DISABLED_FEATURES) {
    if (features[feature] !== false)
      throw new AquariusError(
        "CODEX_POLICY_UNVERIFIED",
        `Codex feature could not be disabled: ${feature}`,
      );
  }

  const mcpServers = asRecord(config.mcpServers ?? config.mcp_servers) ?? {};
  const origins = response.origins ?? {};
  for (const [key, origin] of Object.entries(origins)) {
    const source = originType(origin);
    if ((key === "sandbox_mode" || key.startsWith("sandbox_mode.")) && source !== "user") {
      throw new AquariusError(
        "CODEX_LEGACY_SANDBOX_ACTIVE",
        "A non-user legacy Codex sandbox setting would override read-deny permissions.",
      );
    }
    if (key.startsWith("mcp_servers.") && source !== "user") {
      throw new AquariusError(
        "CODEX_MCP_ACTIVE",
        "A non-user MCP server remains active in the effective Codex configuration.",
      );
    }
  }

  for (const serverName of Object.keys(mcpServers)) {
    const prefix = `mcp_servers.${serverName}.`;
    const sources = Object.entries(origins)
      .filter(([key]) => key.startsWith(prefix))
      .map(([, origin]) => originType(origin));
    if (sources.length === 0 || sources.some((source) => source !== "user")) {
      throw new AquariusError(
        "CODEX_MCP_ACTIVE",
        "Codex MCP isolation could not be verified before execution.",
      );
    }
  }

  const modelProvider = config.modelProvider ?? config.model_provider;
  if (modelProvider != null && modelProvider !== "openai") {
    throw new AquariusError(
      "CODEX_PROVIDER_UNSUPPORTED",
      "Codex uses a custom provider that cannot be isolated from user configuration.",
    );
  }
  const settings: CodexSettings = {
    model: configuredText(config.model),
    serviceTier: configuredText(config.serviceTier ?? config.service_tier),
    verbosity: configuredText(config.modelVerbosity ?? config.model_verbosity),
    reasoningEffort: configuredText(config.modelReasoningEffort ?? config.model_reasoning_effort),
    reasoningSummary: configuredText(
      config.modelReasoningSummary ?? config.model_reasoning_summary,
    ),
    contextWindow: configuredCount(config.modelContextWindow ?? config.model_context_window),
    autoCompactTokenLimit: configuredCount(
      config.modelAutoCompactTokenLimit ?? config.model_auto_compact_token_limit,
    ),
    autoCompactTokenLimitScope: configuredText(
      config.modelAutoCompactTokenLimitScope ?? config.model_auto_compact_token_limit_scope,
    ),
  };
  if (process.platform !== "win32") return settings;
  const windowsSandbox = asRecord(config.windows)?.sandbox;
  if (windowsSandbox !== "elevated" && windowsSandbox !== "mxc") {
    throw new AquariusError(
      "CODEX_POLICY_UNVERIFIED",
      "Codex has no Windows sandbox capable of enforcing read-deny permissions.",
    );
  }
  return { ...settings, windowsSandbox };
};
