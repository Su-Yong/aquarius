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
  return [...new Set(existing)].sort();
};

const filesystemOverride = (deniedPaths: readonly string[]): string => {
  const entries = [`${tomlString(":root")}=${tomlString("read")}`];
  for (const deniedPath of deniedPaths)
    entries.push(`${tomlString(deniedPath)}=${tomlString("deny")}`);
  return `permissions.${PROFILE_NAME}.filesystem={${entries.join(",")}}`;
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
  const detachAbort = attachAbort(child, AbortSignal.any([signal, timeout]));
  try {
    const status = await new Promise<number | null>((resolvePromise, rejectPromise) => {
      child.once("error", () =>
        rejectPromise(
          new AquariusError("CODEX_SANDBOX_PROBE_FAILED", "Codex sandbox probe could not start."),
        ),
      );
      child.once("close", resolvePromise);
    });
    if (timeout.aborted && !signal.aborted) {
      throw new AquariusError("CODEX_SANDBOX_PROBE_FAILED", "Codex sandbox probe timed out.");
    }
    return status;
  } finally {
    detachAbort();
    terminateChild(child);
    await waitForTermination(child);
  }
};

export const verifySandbox = async (
  executable: string,
  viewRoot: string,
  projectRoot: string,
  overrides: readonly string[],
  signal: AbortSignal,
): Promise<void> => {
  let probeCommand: string[];
  if (process.platform === "win32") {
    const probeScript = join(dirname(viewRoot), "sandbox-probe.ps1");
    await writeFile(
      probeScript,
      "$ErrorActionPreference = 'Stop'\nGet-ChildItem -LiteralPath $args[0] -Force | Out-Null\n",
      { flag: "wx" },
    );
    probeCommand = [
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      probeScript,
    ];
  } else {
    probeCommand = ["/bin/sh", "-c", 'ls -A -- "$1" >/dev/null', "aquarius-probe"];
  }
  const base = [
    "sandbox",
    "-C",
    viewRoot,
    "-P",
    PROFILE_NAME,
    "--include-managed-config",
    ...configArguments(
      overrides.filter(
        (override) =>
          override.startsWith(`permissions.${PROFILE_NAME}.`) ||
          override.startsWith("windows.sandbox="),
      ),
    ),
    ...probeCommand,
  ];
  const allowed = await runSandboxCommand(executable, [...base, viewRoot], viewRoot, signal);
  if (signal.aborted) throw new AquariusError("CODEX_ABORTED", "Codex execution was aborted.");
  if (allowed !== 0)
    throw new AquariusError(
      "CODEX_SANDBOX_PROBE_FAILED",
      "Codex could not read the approved snapshot through its sandbox.",
    );
  const denied = await runSandboxCommand(executable, [...base, projectRoot], viewRoot, signal);
  if (signal.aborted) throw new AquariusError("CODEX_ABORTED", "Codex execution was aborted.");
  if (denied === 0 || denied === null)
    throw new AquariusError(
      "CODEX_SANDBOX_PROBE_FAILED",
      "Codex sandbox could not verify that the original project root was blocked.",
    );
};
