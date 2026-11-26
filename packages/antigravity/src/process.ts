import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

import { terminateChild } from "@aqtools/core/adapter";

export const spawnAntigravity = (
  executable: string,
  args: string[],
  cwd: string,
): { child: ChildProcessWithoutNullStreams; terminate: () => void } => {
  const options = { cwd, windowsHide: true };
  if (process.platform !== "win32" || !/\.(?:bat|cmd)$/iu.test(executable)) {
    const child = spawn(executable, args, options);
    return { child, terminate: () => terminateChild(child) };
  }

  const systemDirectory = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const command = [executable, ...args].map(quoteBatchArgument).join(" ");
  const child = spawn(
    join(systemDirectory, "cmd.exe"),
    ["/d", "/s", "/v:off", "/c", `"${command}"`],
    {
      ...options,
      windowsVerbatimArguments: true,
    },
  );
  let terminating = false;
  const terminate = () => {
    if (
      terminating ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      child.pid === undefined
    )
      return;
    terminating = true;

    // Terminating cmd.exe by itself would leave the native agy process running.
    const killTree = spawn(
      join(systemDirectory, "taskkill.exe"),
      ["/pid", String(child.pid), "/t", "/f"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    killTree.once("error", () => terminateChild(child));
    killTree.once("close", () => terminateChild(child));
  };
  return { child, terminate };
};

const quoteBatchArgument = (value: string): string => {
  // cmd.exe expands percent expressions inside quotes and batch wrappers may reparse arguments.
  if (/["%!\p{Cc}]/u.test(value)) {
    throw new Error(
      "An Antigravity batch launcher argument contains characters that cannot be passed safely.",
    );
  }
  return `"${value.replace(/\\+$/u, "$&$&")}"`;
};
