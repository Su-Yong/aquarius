import type { ChildProcess } from "node:child_process";

const FORCE_KILL_DELAY_MS = 1_000;
const TERMINATION_WAIT_TIMEOUT_MS = 2_000;
const terminatingChildren = new WeakSet<ChildProcess>();

export const terminateChild = (child: ChildProcess): void => {
  if (hasChildExited(child) || terminatingChildren.has(child)) return;

  terminatingChildren.add(child);
  child.kill();

  const forceKillTimer = setTimeout(() => {
    if (!hasChildExited(child)) child.kill("SIGKILL");
  }, FORCE_KILL_DELAY_MS);
  forceKillTimer.unref();

  const cancelForceKill = () => clearTimeout(forceKillTimer);
  child.once("close", cancelForceKill);
};

export const attachAbort = (child: ChildProcess, signal: AbortSignal): (() => void) => {
  const abort = () => terminateChild(child);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener("abort", abort);
};

export const waitForTermination = async (child: ChildProcess): Promise<void> => {
  if (hasChildExited(child)) return;

  const watchForTermination = (resolve: () => void) => {
    const finish = () => {
      clearTimeout(timer);
      child.removeListener("close", finish);
      resolve();
    };

    const timer = setTimeout(finish, TERMINATION_WAIT_TIMEOUT_MS);
    timer.unref();
    child.once("close", finish);
  };

  await new Promise<void>(watchForTermination);
};

const hasChildExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;
