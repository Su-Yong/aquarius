import { AquariusError } from "../shared/errors";
import { formatDuration, progressText } from "../shared/progress-text";

import type { AdapterExecuteRequest, AdapterSession } from "./types";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const executeWithTimeout = async (
  session: AdapterSession,
  request: Omit<AdapterExecuteRequest, "signal">,
  timeoutMs: number,
  external?: AbortSignal,
  { keepAlive = false } = {},
): Promise<unknown> => {
  const controller = new AbortController();
  const startedAt = Date.now();
  let lastActivity: string | undefined;
  let lastActivityAt = startedAt;

  const abort = () =>
    controller.abort(new AquariusError("AI_ABORTED", "AI execution was cancelled."));
  external?.addEventListener("abort", abort, { once: true });
  if (external?.aborted) abort();

  const handleTimeout = (): void => {
    const elapsedMs = Date.now() - startedAt;
    const elapsed = formatDuration(elapsedMs);
    const activity = lastActivity
      ? ` Last activity: ${lastActivity} (${formatDuration(Date.now() - lastActivityAt)} ago).`
      : " No adapter activity was reported.";

    const timeoutMessage =
      `AI execution timed out after ${elapsed} (ai.timeoutMs=${timeoutMs}).` +
      activity +
      " Increase ai.timeoutMs or narrow the selected files or rules.";

    controller.abort(new AquariusError("AI_TIMEOUT", timeoutMessage));
  };
  const scheduleTimeout = (remainingMs: number): NodeJS.Timeout => {
    // Node turns delays above the signed 32-bit limit into a one-millisecond timeout.
    const timeout =
      remainingMs > MAX_TIMER_DELAY_MS
        ? setTimeout(() => {
            timer = scheduleTimeout(remainingMs - MAX_TIMER_DELAY_MS);
          }, MAX_TIMER_DELAY_MS)
        : setTimeout(handleTimeout, remainingMs);
    if (!keepAlive) timeout.unref();
    return timeout;
  };
  let timer = scheduleTimeout(timeoutMs);

  let settled = false;
  const onProgress = (message: string): void => {
    const shouldIgnoreProgress =
      settled || controller.signal.aborted || typeof message !== "string";
    if (shouldIgnoreProgress) return;

    lastActivity = progressText(message);
    lastActivityAt = Date.now();
    notifyObserver(request.onProgress, lastActivity);
  };
  const onAnalysisUpdate = (update: unknown): void => {
    if (settled || controller.signal.aborted) return;
    lastActivity = "Received a provisional analysis update";
    lastActivityAt = Date.now();
    notifyObserver(request.onAnalysisUpdate, update);
  };

  const execute = async (): Promise<unknown> =>
    session.execute({
      ...request,
      signal: controller.signal,
      onProgress,
      ...(request.onAnalysisUpdate && { onAnalysisUpdate }),
    });

  let rejectAbort: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();

    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });

    return await Promise.race([cancelled, execute()]);
  } finally {
    settled = true;
    clearTimeout(timer);
    external?.removeEventListener("abort", abort);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
};

const notifyObserver = <Value>(
  observer: ((value: Value) => void) | undefined,
  value: Value,
): void => {
  if (!observer) return;
  try {
    Promise.resolve(observer(value)).catch(() => {});
  } catch {}
};
