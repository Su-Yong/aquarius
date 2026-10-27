import { z } from "zod";
import { codexBridge } from "./codex";
import { importProjectModule } from "../rules/modules";
import { AquariusError } from "../shared/errors";
import type { LoadedConfig } from "../config/types";
import type { AiBridge, BridgeInput } from "./types";

const bridgeSchema = z.object({
  id: z.string(),
  run: z.custom<AiBridge["run"]>((value) => typeof value === "function"),
});

export const resolveBridge = async (config: LoadedConfig): Promise<AiBridge> => {
  if (config.ai.adapter === "codex") return codexBridge;
  const loaded = await importProjectModule(config.ai.adapter, config.configDirectory);
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
  let timedOut = false;
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
      rejectAbort = () => reject(new AquariusError(
        timedOut ? "AI_TIMEOUT" : "AI_ABORTED",
        timedOut ? "AI execution exceeded its time limit." : "AI execution was cancelled.",
      ));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    if (controller.signal.aborted) return await cancelled;
    return await Promise.race([bridge.run({ ...input, signal: controller.signal }), cancelled]);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", abort);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
};
