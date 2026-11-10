import { z } from "zod";
import { codexBridge } from "./codex";
import { importProjectModule } from "../rules/modules";
import { AquariusError } from "../shared/errors";
import { formatDuration, progressText } from "../shared/progress";
import type { LoadedConfig } from "../config/types";
import type { AiBridge, BridgeInput } from "./types";

const bridgeSchema = z.object({
  id: z.string(),
  run: z.custom<AiBridge["run"]>((value) => typeof value === "function"),
});

export const resolveBridge = async (config: LoadedConfig): Promise<AiBridge> => {
  const adapter = config.ai.adapter;
  if (!adapter) {
    throw new AquariusError(
      "AI_ADAPTER_REQUIRED",
      'Set ai.adapter in the project configuration, such as "codex" or "./bridge.mjs". No AI adapter is selected by default.',
    );
  }
  if (adapter === "codex") return codexBridge;
  const loaded = await importProjectModule(adapter, config.configDirectory);
  if (!bridgeSchema.safeParse(loaded).success) {
    throw new AquariusError("INVALID_AI_BRIDGE", "AI bridge must export an id and a run function.");
  }
  return loaded as AiBridge;
};

export const callBridge = async (
  bridge: AiBridge,
  input: Omit<BridgeInput, "signal">,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<unknown> => {
  const controller = new AbortController();
  const startedAt = Date.now();
  let lastActivity: string | undefined;
  let lastActivityAt = startedAt;
  let timedOut = false;
  let settled = false;
  const onProgress = (message: string): void => {
    if (settled || controller.signal.aborted) return;
    lastActivity = progressText(message);
    lastActivityAt = Date.now();
    input.onProgress?.(lastActivity);
  };
  const onAnalysisUpdate = (update: unknown): void => {
    if (settled || controller.signal.aborted) return;
    lastActivity = "Received a provisional analysis update";
    lastActivityAt = Date.now();
    // Observer failures must not terminate the adapter or discard its final result.
    try {
      Promise.resolve(input.onAnalysisUpdate?.(update)).catch(() => {});
    } catch {}
  };
  const timeoutMessage = (): string => {
    const elapsed = formatDuration(Date.now() - startedAt);
    const activity = lastActivity
      ? ` Last activity: ${lastActivity} (${formatDuration(Date.now() - lastActivityAt)} ago).`
      : " No adapter activity was reported.";
    return (
      `AI execution timed out after ${elapsed} (ai.timeoutMs=${timeoutMs}).` +
      activity +
      " Increase ai.timeoutMs or narrow the selected files or rules."
    );
  };
  const abort = () => controller.abort();
  external?.addEventListener("abort", abort, { once: true });
  if (external?.aborted) controller.abort();

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();

  let rejectAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () =>
        reject(
          new AquariusError(
            timedOut ? "AI_TIMEOUT" : "AI_ABORTED",
            timedOut ? timeoutMessage() : "AI execution was cancelled.",
          ),
        );
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    if (controller.signal.aborted) return await cancelled;
    return await Promise.race([
      bridge.run({ ...input, signal: controller.signal, onProgress, onAnalysisUpdate }),
      cancelled,
    ]);
  } finally {
    settled = true;
    clearTimeout(timer);
    external?.removeEventListener("abort", abort);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
};
