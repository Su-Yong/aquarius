import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { AquariusError } from "@aquarius/core/runtime";
import type { FileBaseline, FileChangePlan, FileState, PlanSide } from "./types";

const fileIdentities = new WeakMap<FileState, string>();
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/i;

const fail: (code: string, message: string) => never = (code, message) => {
  throw new AquariusError(code, message);
};

export const slash = (value: string): string => {
  return value.split(path.sep).join("/");
};

export const pathKey = (relativePath: string): string => {
  return process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
};

const sha256 = (content: Uint8Array): string => {
  return createHash("sha256").update(content).digest("hex");
};

const fileMode = (mode: number): number => {
  return mode & 0o777;
};

export const fileIdentity = (state: FileState): string | undefined => {
  return fileIdentities.get(state);
};

export const fileStatesEqual = (left: FileState | null, right: FileState | null): boolean => {
  if (left === null || right === null) return left === right;
  return left.mode === right.mode && Buffer.from(left.content).equals(Buffer.from(right.content));
};

export const fileStatesAndIdentityEqual = (
  left: FileState | null,
  right: FileState | null,
): boolean => {
  if (!fileStatesEqual(left, right) || left === null || right === null) return left === right;
  const expectedIdentity = fileIdentities.get(right);
  return expectedIdentity === undefined || fileIdentities.get(left) === expectedIdentity;
};

export const canonicalProjectRoot = async (root: string): Promise<string> => {
  const resolved = path.resolve(root);
  let canonical: string;
  try {
    canonical = await realpath(resolved);
  } catch (error) {
    throw new AquariusError(
      "PROJECT_ROOT_INVALID",
      `Cannot resolve project root ${resolved}: ${String(error)}`,
    );
  }
  const stat = await lstat(canonical);
  if (!stat.isDirectory())
    fail("PROJECT_ROOT_INVALID", `Project root is not a directory: ${canonical}`);
  return canonical;
};

export const normalizeRelativePath = (root: string, input: string): string => {
  if (!input || input.includes("\0"))
    fail("PATH_INVALID", `Invalid project path: ${JSON.stringify(input)}`);
  if (path.isAbsolute(input) || path.posix.isAbsolute(input) || path.win32.isAbsolute(input)) {
    fail("PATH_OUTSIDE_ROOT", `Path must be relative to the project root: ${input}`);
  }
  const portable = input.replaceAll("\\", "/");
  const rawParts = portable.split("/");
  if (rawParts.some((part) => part === "." || part === "..")) {
    fail("PATH_INVALID", `Path cannot contain . or .. segments: ${input}`);
  }
  if (
    process.platform === "win32" &&
    rawParts.some(
      (part) =>
        /[<>:"|?*\u0000-\u001f]/.test(part) ||
        /[ .]$/.test(part) ||
        WINDOWS_RESERVED_NAME.test(part),
    )
  ) {
    fail("PATH_INVALID", `Path uses a reserved Windows name or alias: ${input}`);
  }
  const absolute = path.resolve(root, ...rawParts);
  const relative = path.relative(root, absolute);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail("PATH_OUTSIDE_ROOT", `Path escapes or names the project root: ${input}`);
  }
  return slash(relative);
};

export const absolutePath = (root: string, relativePath: string): string => {
  return path.resolve(root, ...relativePath.split("/"));
};

export const assertSafePath = async (root: string, relativePath: string): Promise<string> => {
  const normalized = normalizeRelativePath(root, relativePath);
  const parts = normalized.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        fail("SYMLINK_UNSUPPORTED", `Symbolic links are not supported: ${normalized}`);
      if (index < parts.length - 1 && !stat.isDirectory()) {
        fail(
          "PATH_PARENT_INVALID",
          `Path parent is not a directory: ${slash(path.relative(root, current))}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return absolutePath(root, normalized);
};

export const assertStableParent = async (root: string, relativePath: string): Promise<void> => {
  const parent = path.posix.dirname(relativePath);
  const expected = parent === "." ? root : absolutePath(root, parent);
  let actual: string;
  try {
    actual = await realpath(expected);
  } catch (error) {
    throw new AquariusError(
      "PATH_PARENT_INVALID",
      `Cannot resolve path parent for ${relativePath}: ${String(error)}`,
    );
  }
  const normalize = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(path.resolve(actual)) !== normalize(path.resolve(expected))) {
    fail("SYMLINK_UNSUPPORTED", `Path parent changed through a symbolic link: ${relativePath}`);
  }
  const info = await lstat(expected);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail("PATH_PARENT_INVALID", `Path parent is not a stable directory: ${relativePath}`);
  }
};

export const assertNoAlternateDataStreams = async (
  root: string,
  relativePaths: readonly string[],
): Promise<void> => {
  if (process.platform !== "win32" || relativePaths.length === 0) return;
  const paths = [...new Set(relativePaths.map((relativePath) => absolutePath(root, relativePath)))];
  const command = [
    "$paths = @(ConvertFrom-Json ([Console]::In.ReadToEnd()))",
    "for ($index = 0; $index -lt $paths.Count; $index++) {",
    "  if (-not [IO.File]::Exists($paths[$index])) { continue }",
    "  try {",
    "    Get-Item -LiteralPath $paths[$index] -Stream * -ErrorAction Stop |",
    "      Where-Object Stream -ne ':$DATA' |",
    '      ForEach-Object { Write-Output ($index.ToString() + "`t" + $_.Stream) }',
    "  } catch [System.Management.Automation.ItemNotFoundException] { }",
    "}",
  ].join("\n");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) =>
      reject(
        new AquariusError(
          "FILE_METADATA_CHECK_FAILED",
          `Cannot inspect NTFS alternate data streams: ${String(error)}`,
        ),
      ),
    );
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else
        reject(
          new AquariusError(
            "FILE_METADATA_CHECK_FAILED",
            `Cannot inspect NTFS alternate data streams: ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(paths));
  });
  const first = output.split(/\r?\n/).find((line) => line.trim() !== "");
  if (first) {
    const [indexText, stream = "unknown"] = first.split("\t", 2);
    const index = Number(indexText);
    const relativePath =
      Number.isInteger(index) && paths[index]
        ? slash(path.relative(root, paths[index]))
        : "unknown file";
    fail(
      "FILE_METADATA_UNSUPPORTED",
      `NTFS alternate data stream ${stream} is not supported: ${relativePath}`,
    );
  }
};

export const readAbsoluteFileState = async (
  absolute: string,
  displayPath: string,
): Promise<FileState | null> => {
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      fail("SYMLINK_UNSUPPORTED", `Symbolic links are not supported: ${displayPath}`);
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      fail("FILE_TYPE_UNSUPPORTED", `Only regular files are supported: ${displayPath}`);
    const state = { content: new Uint8Array(await handle.readFile()), mode: fileMode(stat.mode) };
    fileIdentities.set(state, `${stat.dev}:${stat.ino}`);
    return state;
  } finally {
    await handle.close();
  }
};

export const readProjectFileState = async (
  root: string,
  relativePath: string,
): Promise<FileState | null> => {
  return await readAbsoluteFileState(await assertSafePath(root, relativePath), relativePath);
};

export const requireSourceState = async (
  root: string,
  relativePath: string,
  baseline: ReadonlyMap<string, FileBaseline>,
): Promise<FileState> => {
  const state = await readProjectFileState(root, relativePath);
  if (state === null) fail("SOURCE_MISSING", `Source file does not exist: ${relativePath}`);
  const expected = baseline.get(pathKey(relativePath));
  if (!expected) fail("BASELINE_MISSING", `No pre-AI baseline was captured for: ${relativePath}`);
  if (expected.hash !== sha256(state.content) || expected.mode !== state.mode) {
    fail("SOURCE_CHANGED", `File changed after the AI baseline was captured: ${relativePath}`);
  }
  return state;
};

export const captureBaseline = async (
  root: string,
  paths: readonly string[],
): Promise<Map<string, FileBaseline>> => {
  const projectRoot = await canonicalProjectRoot(root);
  const result = new Map<string, FileBaseline>();
  const relativePaths = paths.map((input) => normalizeRelativePath(projectRoot, input));
  for (const relativePath of relativePaths) {
    const key = pathKey(relativePath);
    if (result.has(key)) fail("PATH_CONFLICT", `Duplicate baseline path: ${relativePath}`);
    const state = await readProjectFileState(projectRoot, relativePath);
    if (state === null) fail("SOURCE_MISSING", `Cannot capture a missing file: ${relativePath}`);
    result.set(key, {
      hash: sha256(state.content),
      mode: state.mode,
      identity: fileIdentity(state),
    });
  }
  return result;
};

export const currentStates = async (
  plan: FileChangePlan,
): Promise<Map<string, FileState | null>> => {
  const result = new Map<string, FileState | null>();
  for (const file of plan.files)
    result.set(pathKey(file.path), await readProjectFileState(plan.projectRoot, file.path));
  return result;
};

export const assertFilePlanState = async (plan: FileChangePlan, side: PlanSide): Promise<void> => {
  const current = await currentStates(plan);
  for (const file of plan.files) {
    if (!fileStatesAndIdentityEqual(current.get(pathKey(file.path)) ?? null, file[side])) {
      fail("FILE_CHANGED", `File no longer matches the expected ${side} state: ${file.path}`);
    }
  }
};
