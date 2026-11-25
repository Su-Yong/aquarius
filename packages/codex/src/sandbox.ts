import { spawn } from "node:child_process";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  AquariusError,
  attachAbort,
  terminateChild,
  waitForTermination,
} from "@aquarius/core/adapter";

import { PROFILE_NAME } from "./config-probe";
import { configArguments, tomlString } from "./toml";

const SANDBOX_PROBE_TIMEOUT_MS = 15_000;

export const existingSensitivePaths = async (projectRoot: string): Promise<string[]> => {
  const codexHome = process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : join(homedir(), ".codex");
  const candidates = new Set([
    projectRoot,
    join(codexHome, "auth.json"),
    join(homedir(), ".aws"),
    join(homedir(), ".azure"),
    join(homedir(), ".config", "gcloud"),
    join(homedir(), ".docker"),
    join(homedir(), ".gnupg"),
    join(homedir(), ".kube"),
    join(homedir(), ".ssh"),
    join(homedir(), ".git-credentials"),
    join(homedir(), ".netrc"),
    join(homedir(), ".npmrc"),
  ]);
  const existing: string[] = [];
  for (const candidate of candidates) {
    try {
      await lstat(candidate);
      existing.push(await realpath(candidate));
    } catch {
      // Missing paths cannot expose current credentials to the sandboxed command.
    }
  }
  const uniquePaths = new Set(existing);
  return [...uniquePaths].sort();
};

export const buildCodexConfigOverrides = (
  viewRoot: string,
  deniedPaths: readonly string[],
): string[] => {
  const projectTrust = `projects={${tomlString(viewRoot)}={trust_level=${tomlString("untrusted")}}}`;
  return [
    `default_permissions=${tomlString(PROFILE_NAME)}`,
    filesystemOverride(deniedPaths),
    `permissions.${PROFILE_NAME}.network.enabled=false`,
    projectTrust,
    "project_doc_max_bytes=0",
    `web_search=${tomlString("disabled")}`,
    "mcp_servers={}",
    "analytics={enabled=false}",
    "notify=[]",
    `shell_environment_policy={inherit=${tomlString("core")},ignore_default_excludes=false}`,
  ];
};

export const verifySandbox = async (
  executable: string,
  viewRoot: string,
  projectRoot: string,
  overrides: readonly string[],
  signal: AbortSignal,
): Promise<void> => {
  const windowsProbeScript =
    process.platform === "win32" ? join(dirname(viewRoot), "sandbox-probe.ps1") : undefined;
  if (windowsProbeScript !== undefined) {
    await writeFile(
      windowsProbeScript,
      "$ErrorActionPreference = 'Stop'\nGet-ChildItem -LiteralPath $args[0] -Force | Out-Null\n",
      { flag: "wx" },
    );
  }
  const probeCommand = buildProbeCommand(windowsProbeScript);
  const sandboxOverrides = overrides.filter(
    (override) =>
      override.startsWith(`permissions.${PROFILE_NAME}.`) || override.startsWith("windows.sandbox="),
  );
  const overrideArguments = configArguments(sandboxOverrides);
  const sandboxArguments = [
    "sandbox",
    "-C",
    viewRoot,
    "-P",
    PROFILE_NAME,
    "--include-managed-config",
    ...overrideArguments,
    ...probeCommand,
  ];
  const snapshotExitCode = await runSandboxCommand(
    executable,
    [...sandboxArguments, viewRoot],
    viewRoot,
    signal,
  );
  if (signal.aborted) throw new AquariusError("CODEX_ABORTED", "Codex execution was aborted.");
  if (snapshotExitCode !== 0)
    throw new AquariusError(
      "CODEX_SANDBOX_PROBE_FAILED",
      "Codex could not read the approved snapshot through its sandbox.",
    );
  const projectExitCode = await runSandboxCommand(
    executable,
    [...sandboxArguments, projectRoot],
    viewRoot,
    signal,
  );
  if (signal.aborted) throw new AquariusError("CODEX_ABORTED", "Codex execution was aborted.");
  if (projectExitCode === 0 || projectExitCode === null)
    throw new AquariusError(
      "CODEX_SANDBOX_PROBE_FAILED",
      "Codex sandbox could not verify that the original project root was blocked.",
    );
};

const filesystemOverride = (deniedPaths: readonly string[]): string => {
  const rootEntry = `${tomlString(":root")}=${tomlString("read")}`;
  const deniedEntries = Array.from(
    deniedPaths,
    (deniedPath) => `${tomlString(deniedPath)}=${tomlString("deny")}`,
  );
  const entries = [rootEntry, ...deniedEntries];
  return `permissions.${PROFILE_NAME}.filesystem={${entries.join(",")}}`;
};

const buildProbeCommand = (windowsProbeScript: string | undefined): string[] => {
  if (windowsProbeScript === undefined)
    return ["/bin/sh", "-c", 'ls -A -- "$1" >/dev/null', "aquarius-probe"];
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return [
    powershell,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    windowsProbeScript,
  ];
};

const runSandboxCommand = async (
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<number | null> => {
  if (signal.aborted) throw new AquariusError("CODEX_ABORTED", "Codex execution was aborted.");
  const child = spawn(executable, args, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  const timeout = AbortSignal.timeout(SANDBOX_PROBE_TIMEOUT_MS);
  const probeSignal = AbortSignal.any([signal, timeout]);
  const detachAbort = attachAbort(child, probeSignal);
  try {
    const registerProbeListeners = (
      resolveExit: (exitCode: number | null) => void,
      rejectProbe: (error: AquariusError) => void,
    ) => {
      const rejectOnSpawnError = () =>
        rejectProbe(
          new AquariusError("CODEX_SANDBOX_PROBE_FAILED", "Codex sandbox probe could not start."),
        );
      child.once("error", rejectOnSpawnError);
      child.once("close", resolveExit);
    };
    const exitCode = await new Promise<number | null>(registerProbeListeners);
    if (timeout.aborted && !signal.aborted) {
      throw new AquariusError("CODEX_SANDBOX_PROBE_FAILED", "Codex sandbox probe timed out.");
    }
    return exitCode;
  } finally {
    detachAbort();
    terminateChild(child);
    await waitForTermination(child);
  }
};
