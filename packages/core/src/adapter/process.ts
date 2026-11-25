import type { ChildProcess } from "node:child_process";

const terminating = new WeakSet<ChildProcess>();

const exited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

export const terminateChild = (child: ChildProcess): void => {
  if (exited(child) || terminating.has(child)) return;
  terminating.add(child);
  child.kill();
  const force = setTimeout(() => {
    if (!exited(child)) child.kill("SIGKILL");
  }, 1_000);
  force.unref();
  child.once("close", () => clearTimeout(force));
};

export const attachAbort = (child: ChildProcess, signal: AbortSignal): (() => void) => {
  const abort = () => terminateChild(child);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener("abort", abort);
};

export const waitForTermination = async (child: ChildProcess): Promise<void> => {
  if (exited(child)) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.removeListener("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, 2_000);
    timer.unref();
    child.once("close", finish);
  });
};
