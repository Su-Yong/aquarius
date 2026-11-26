import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "vitest";

export const liveTest = process.env.AQUARIUS_PRODUCT_LIVE === "1" ? test : test.skip;
export const repositoryRoot = resolve(import.meta.dirname, "..");

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

export const runCli = async (
  cli: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<CliResult> => {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return await new Promise<CliResult>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (status) =>
      resolvePromise({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        elapsedMs: Date.now() - startedAt,
      }),
    );
  });
};

export const createProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "aquarius-product-live-"));
  execFileSync("git", ["init", "-q", root], { windowsHide: true });
  await Promise.all([
    mkdir(join(root, "lint")),
    mkdir(join(root, "format")),
    mkdir(join(root, "ignored")),
  ]);
  const scope = join(root, "node_modules", "@aqtools");
  await mkdir(scope, { recursive: true });
  for (const name of ["rules", "codex", "antigravity"]) {
    await symlink(join(repositoryRoot, "packages", name), join(scope, name), "junction");
  }
  await writeFile(join(root, "ignored", "private.txt"), "AQUARIUS_PRODUCT_LIVE_IGNORED_42d1\n");
  return root;
};

export const removeProject = async (root: string): Promise<void> => {
  const candidate = resolve(root);
  const tempRoot = resolve(tmpdir());
  if (
    dirname(candidate) !== tempRoot ||
    !basename(candidate).startsWith("aquarius-product-live-")
  ) {
    throw new Error("Refusing to remove a directory not created by this test.");
  }
  await rm(candidate, { recursive: true, force: true });
};

export const parseJson = (stdout: string): Record<string, unknown> => {
  return JSON.parse(stdout) as Record<string, unknown>;
};
