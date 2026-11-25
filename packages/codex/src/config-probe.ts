import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import {
  AquariusError,
  attachAbort,
  terminateChild,
  waitForTermination,
} from "@aqtools/core/adapter";

import { captureStderr, withDiagnostic } from "./diagnostic";
import {
  DISABLED_FEATURES,
  featureArguments,
  type CodexOptions,
  type CodexSettings,
} from "./options";
import { configArguments } from "./toml";

interface EffectiveConfigResponse {
  config?: Record<string, unknown>;
  origins?: Record<string, unknown>;
}

export const PROFILE_NAME = "aquarius-read";
const CONFIG_PROBE_TIMEOUT_MS = 15_000;

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
  const readStderr = captureStderr(child.stderr);

  const probeError = (message: string, reason: unknown = readStderr()) => {
    const diagnosticMessage = withDiagnostic(message, reason, diagnosticPaths);
    return new AquariusError("CODEX_CONFIG_PROBE_FAILED", diagnosticMessage);
  };

  try {
    const runProbe = (
      resolvePromise: (value: EffectiveConfigResponse | PromiseLike<EffectiveConfigResponse>) => void,
      rejectPromise: (reason?: unknown) => void,
    ) => {
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

      const onResponseLine = (line: string) => {
        if (settled) return;
        const message = parseProbeMessage(line);
        if (!message) {
          finish(probeError("Codex config probe returned invalid JSON."));
          return;
        }

        if (message.id === 0) {
          if (message.error) {
            const errorMessage = asRecord(message.error)?.message;
            finish(probeError("Codex rejected config probe initialization.", errorMessage));
            return;
          }

          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          const configRequest = {
            method: "config/read",
            id: 2,
            params: { includeLayers: true, cwd },
          };
          child.stdin.write(`${JSON.stringify(configRequest)}\n`);
          return;
        }

        if (message.id !== 2) return;
        if (message.error) {
          const errorMessage = asRecord(message.error)?.message;
          finish(probeError("Codex rejected the effective configuration probe.", errorMessage));
          return;
        }

        finish(undefined, (message.result ?? {}) as EffectiveConfigResponse);
      };
      reader.on("line", onResponseLine);

      const onSpawnError = (error: Error) =>
        finish(probeError("Codex config probe could not start.", error.message));
      child.once("error", onSpawnError);

      const onStdinError = (error: NodeJS.ErrnoException) => {
        if (signal.aborted)
          finish(new AquariusError("CODEX_ABORTED", "Codex execution was aborted."));
        else if (error.code !== "EPIPE")
          finish(probeError("Codex config probe could not send a request."));
      };
      child.stdin.once("error", onStdinError);

      const onClose = (code: number | null) => {
        if (settled) return;
        if (signal.aborted) {
          finish(new AquariusError("CODEX_ABORTED", "Codex execution was aborted."));
          return;
        }

        const message = `Codex config probe exited before responding (${code ?? "signal"}).`;
        finish(probeError(message));
      };
      child.once("close", onClose);

      const initializeRequest = {
        method: "initialize",
        id: 0,
        params: { clientInfo: { name: "aquarius", title: "Aquarius", version: "0.1.0" } },
      };
      child.stdin.write(`${JSON.stringify(initializeRequest)}\n`);
    };

    return await new Promise<EffectiveConfigResponse>(runProbe);
  } finally {
    detachAbort();
    terminateChild(child);
    await waitForTermination(child);
  }
};

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

  const permissions = asRecord(config.permissions);
  const profile = asRecord(permissions?.[PROFILE_NAME]);
  const filesystem = asRecord(profile?.filesystem);
  const allowsUnexpectedFilesystemAccess = ([path, access]: [string, unknown]) => {
    const isUnexpectedAccess =
      path !== ":root" && path !== "glob_scan_max_depth" && access !== "deny";
    return isUnexpectedAccess;
  };
  const hasUnexpectedFilesystemProfile =
    profile?.extends != null ||
    filesystem?.[":root"] !== "read" ||
    Object.entries(filesystem).some(allowsUnexpectedFilesystemAccess);
  if (hasUnexpectedFilesystemProfile) {
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

export const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  const isRecord = value && typeof value === "object" && !Array.isArray(value);
  return isRecord ? (value as Record<string, unknown>) : undefined;
};

const originType = (origin: unknown): string | undefined => {
  const originRecord = asRecord(origin);
  const originName = asRecord(originRecord?.name);
  return originName?.type as string | undefined;
};

const configuredText = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim() || undefined : undefined;

const configuredCount = (value: unknown): number | undefined => {
  const isPositiveSafeInteger = typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  return isPositiveSafeInteger ? value : undefined;
};

const parseProbeMessage = (line: string): Record<string, unknown> | undefined => {
  try {
    const parsedMessage: unknown = JSON.parse(line);
    return asRecord(parsedMessage);
  } catch {
    return undefined;
  }
};
