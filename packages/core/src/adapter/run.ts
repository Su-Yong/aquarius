import { AquariusError } from "../shared/errors";
import { formatDuration, progressText } from "../shared/progress-text";
import type { AdapterExecuteRequest, AdapterSession } from "./types";

const notifyObserver = <Value>(
  observer: ((value: Value) => void) | undefined,
  value: Value,
): void => {
  if (!observer) return;
  try {
    Promise.resolve(observer(value)).catch(() => {});
  } catch {}
};

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
  let settled = false;

  const onProgress = (message: string): void => {
    if (settled || controller.signal.aborted || typeof message !== "string") return;
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
  const abort = () =>
    controller.abort(new AquariusError("AI_ABORTED", "AI execution was cancelled."));
  external?.addEventListener("abort", abort, { once: true });
  if (external?.aborted) abort();

  const timer = setTimeout(() => {
    const elapsed = formatDuration(Date.now() - startedAt);
    const activity = lastActivity
      ? ` Last activity: ${lastActivity} (${formatDuration(Date.now() - lastActivityAt)} ago).`
      : " No adapter activity was reported.";
    controller.abort(
      new AquariusError(
        "AI_TIMEOUT",
        `AI execution timed out after ${elapsed} (ai.timeoutMs=${timeoutMs}).` +
          activity +
          " Increase ai.timeoutMs or narrow the selected files or rules.",
      ),
    );
  }, timeoutMs);
  // The runtime keeps the deadline alive so a pending adapter can return a structured timeout.
  if (!keepAlive) timer.unref();
  let rejectAbort: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const execute = async (): Promise<unknown> =>
      session.execute({
        ...request,
        signal: controller.signal,
        onProgress,
        onAnalysisUpdate,
      });
    return await Promise.race([cancelled, execute()]);
  } finally {
    settled = true;
    clearTimeout(timer);
    external?.removeEventListener("abort", abort);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
};
