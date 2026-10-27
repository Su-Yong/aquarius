import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { AquariusError } from "../shared/errors";
import type { FileChange } from "./schema";
import type { GitUndoStore } from "../undo/store";
import type { FileBaseline, FileChangePlan, FileState, PlannedFile } from "./types";

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const textEncoder = new TextEncoder();
const fileIdentities = new WeakMap<object, string>();
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/i;

type PlanSide = "before" | "after";

export class FileTransitionRecoveredError extends Error {
  constructor(readonly original: unknown) {
    super(`File transition failed and was restored: ${String(original)}`);
    this.name = "FileTransitionRecoveredError";
  }
}

interface SourceChanges {
  path: string;
  replacements: { oldText: string; newText: string }[];
  delete: boolean;
  moveTo?: string;
}

const fail: (code: string, message: string) => never = (code, message) => {
  throw new AquariusError(code, message);
};

const slash = (value: string): string => {
  return value.split(path.sep).join("/");
};

const pathKey = (relativePath: string): string => {
  return process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
};

const sha256 = (content: Uint8Array): string => {
  return createHash("sha256").update(content).digest("hex");
};

const fileMode = (mode: number): number => {
  return mode & 0o777;
};

const copyState = (state: FileState): FileState => {
  return { content: new Uint8Array(state.content), mode: state.mode };
};

export const fileStatesEqual = (left: FileState | null, right: FileState | null): boolean => {
  if (left === null || right === null) return left === right;
  return left.mode === right.mode && Buffer.from(left.content).equals(Buffer.from(right.content));
};

const fileStatesAndIdentityEqual = (left: FileState | null, right: FileState | null): boolean => {
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
    throw new AquariusError("PROJECT_ROOT_INVALID", `Cannot resolve project root ${resolved}: ${String(error)}`);
  }
  const stat = await lstat(canonical);
  if (!stat.isDirectory()) fail("PROJECT_ROOT_INVALID", `Project root is not a directory: ${canonical}`);
  return canonical;
};

export const normalizeRelativePath = (root: string, input: string): string => {
  if (!input || input.includes("\0")) fail("PATH_INVALID", `Invalid project path: ${JSON.stringify(input)}`);
  if (path.isAbsolute(input) || path.posix.isAbsolute(input) || path.win32.isAbsolute(input)) {
    fail("PATH_OUTSIDE_ROOT", `Path must be relative to the project root: ${input}`);
  }
  const portable = input.replaceAll("\\", "/");
  const rawParts = portable.split("/");
  if (rawParts.some((part) => part === "." || part === "..")) {
    fail("PATH_INVALID", `Path cannot contain . or .. segments: ${input}`);
  }
  if (process.platform === "win32" && rawParts.some((part) => (
    /[<>:"|?*\u0000-\u001f]/.test(part)
    || /[ .]$/.test(part)
    || WINDOWS_RESERVED_NAME.test(part)
  ))) {
    fail("PATH_INVALID", `Path uses a reserved Windows name or alias: ${input}`);
  }
  const absolute = path.resolve(root, ...rawParts);
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("PATH_OUTSIDE_ROOT", `Path escapes or names the project root: ${input}`);
  }
  return slash(relative);
};

const absolutePath = (root: string, relativePath: string): string => {
  return path.resolve(root, ...relativePath.split("/"));
};

const assertSafePath = async (root: string, relativePath: string): Promise<string> => {
  const normalized = normalizeRelativePath(root, relativePath);
  const parts = normalized.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) fail("SYMLINK_UNSUPPORTED", `Symbolic links are not supported: ${normalized}`);
      if (index < parts.length - 1 && !stat.isDirectory()) {
        fail("PATH_PARENT_INVALID", `Path parent is not a directory: ${slash(path.relative(root, current))}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return absolutePath(root, normalized);
};

const assertStableParent = async (root: string, relativePath: string): Promise<void> => {
  const parent = path.posix.dirname(relativePath);
  const expected = parent === "." ? root : absolutePath(root, parent);
  let actual: string;
  try {
    actual = await realpath(expected);
  } catch (error) {
    throw new AquariusError("PATH_PARENT_INVALID", `Cannot resolve path parent for ${relativePath}: ${String(error)}`);
  }
  const normalize = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(path.resolve(actual)) !== normalize(path.resolve(expected))) {
    fail("SYMLINK_UNSUPPORTED", `Path parent changed through a symbolic link: ${relativePath}`);
  }
  const info = await lstat(expected);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail("PATH_PARENT_INVALID", `Path parent is not a stable directory: ${relativePath}`);
  }
};

const assertNoAlternateDataStreams = async (root: string, relativePaths: readonly string[]): Promise<void> => {
  if (process.platform !== "win32" || relativePaths.length === 0) return;
  const paths = [...new Set(relativePaths.map((relativePath) => absolutePath(root, relativePath)))];
  const command = [
    "$paths = @(ConvertFrom-Json ([Console]::In.ReadToEnd()))",
    "for ($index = 0; $index -lt $paths.Count; $index++) {",
    "  if (-not [IO.File]::Exists($paths[$index])) { continue }",
    "  try {",
    "    Get-Item -LiteralPath $paths[$index] -Stream * -ErrorAction Stop |",
    "      Where-Object Stream -ne ':$DATA' |",
    "      ForEach-Object { Write-Output ($index.ToString() + \"`t\" + $_.Stream) }",
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
    child.once("error", (error) => reject(new AquariusError(
      "FILE_METADATA_CHECK_FAILED",
      `Cannot inspect NTFS alternate data streams: ${String(error)}`,
    )));
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new AquariusError(
        "FILE_METADATA_CHECK_FAILED",
        `Cannot inspect NTFS alternate data streams: ${Buffer.concat(stderr).toString("utf8").trim()}`,
      ));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(paths));
  });
  const first = output.split(/\r?\n/).find((line) => line.trim() !== "");
  if (first) {
    const [indexText, stream = "unknown"] = first.split("\t", 2);
    const index = Number(indexText);
    const relativePath = Number.isInteger(index) && paths[index]
      ? slash(path.relative(root, paths[index]))
      : "unknown file";
    fail("FILE_METADATA_UNSUPPORTED", `NTFS alternate data stream ${stream} is not supported: ${relativePath}`);
  }
};

const readAbsoluteFileState = async (absolute: string, displayPath: string): Promise<FileState | null> => {
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
    if (!stat.isFile()) fail("FILE_TYPE_UNSUPPORTED", `Only regular files are supported: ${displayPath}`);
    const state = { content: new Uint8Array(await handle.readFile()), mode: fileMode(stat.mode) };
    fileIdentities.set(state, `${stat.dev}:${stat.ino}`);
    return state;
  } finally {
    await handle.close();
  }
};

export const readProjectFileState = async (root: string, relativePath: string): Promise<FileState | null> => {
  return await readAbsoluteFileState(await assertSafePath(root, relativePath), relativePath);
};

const requireSourceState = async (
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

export const captureBaseline = async (root: string, paths: readonly string[]): Promise<Map<string, FileBaseline>> => {
  const projectRoot = await canonicalProjectRoot(root);
  const result = new Map<string, FileBaseline>();
  const relativePaths = paths.map((input) => normalizeRelativePath(projectRoot, input));
  for (const relativePath of relativePaths) {
    const key = pathKey(relativePath);
    if (result.has(key)) fail("PATH_CONFLICT", `Duplicate baseline path: ${relativePath}`);
    const state = await readProjectFileState(projectRoot, relativePath);
    if (state === null) fail("SOURCE_MISSING", `Cannot capture a missing file: ${relativePath}`);
    result.set(key, { hash: sha256(state.content), mode: state.mode });
  }
  return result;
};

const registerPath = (map: Map<string, string>, relativePath: string, description: string): void => {
  const key = pathKey(relativePath);
  const previous = map.get(key);
  if (previous) fail("PATH_CONFLICT", `${description} conflicts with ${previous}: ${relativePath}`);
  map.set(key, description);
};

const assertNoPrefixConflicts = (paths: readonly string[]): void => {
  const sorted = [...new Set(paths.map(pathKey))].sort();
  for (let index = 0; index < sorted.length; index += 1) {
    const parent = sorted[index]!;
    for (let childIndex = index + 1; childIndex < sorted.length; childIndex += 1) {
      const child = sorted[childIndex]!;
      if (child.startsWith(`${parent}/`)) {
        fail("PATH_CONFLICT", `A file path cannot also be another changed path's parent: ${parent}, ${child}`);
      }
    }
  }
};

const applyReplacements = (relativePath: string, state: FileState, replacements: SourceChanges["replacements"]): FileState => {
  if (replacements.length === 0) return copyState(state);
  let original: string;
  try {
    original = textDecoder.decode(state.content);
  } catch {
    fail("FILE_ENCODING_UNSUPPORTED", `Replacement requires valid UTF-8 text: ${relativePath}`);
  }
  const located = replacements.map(({ oldText, newText }) => {
    if (!oldText) fail("REPLACE_TEXT_EMPTY", `oldText cannot be empty: ${relativePath}`);
    const start = original.indexOf(oldText);
    if (start < 0 || original.indexOf(oldText, start + oldText.length) >= 0) {
      fail("REPLACE_NOT_UNIQUE", `oldText must occur exactly once in the original file: ${relativePath}`);
    }
    return { start, end: start + oldText.length, newText };
  });
  located.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < located.length; index += 1) {
    if (located[index]!.start < located[index - 1]!.end) {
      fail("REPLACE_OVERLAP", `Replacement ranges overlap in the original file: ${relativePath}`);
    }
  }
  let transformed = original;
  for (const replacement of located.reverse()) {
    transformed = `${transformed.slice(0, replacement.start)}${replacement.newText}${transformed.slice(replacement.end)}`;
  }
  return { content: textEncoder.encode(transformed), mode: state.mode };
};

export const planFileChanges = async (
  root: string,
  changes: readonly FileChange[],
  canWrite: (relativePath: string) => boolean,
  baseline: ReadonlyMap<string, FileBaseline>,
): Promise<FileChangePlan> => {
  const projectRoot = await canonicalProjectRoot(root);
  const normalizedBaseline = new Map<string, FileBaseline>();
  for (const [input, value] of baseline) {
    normalizedBaseline.set(pathKey(normalizeRelativePath(projectRoot, input)), value);
  }

  const sources = new Map<string, SourceChanges>();
  const creates = new Map<string, { path: string; content: string }>();
  const destinations = new Map<string, string>();
  const allPaths: string[] = [];

  const writablePath = (input: string): string => {
    const relativePath = normalizeRelativePath(projectRoot, input);
    if (!canWrite(relativePath)) fail("PATH_NOT_WRITABLE", `Path is outside the writable target or ignored: ${relativePath}`);
    allPaths.push(relativePath);
    return relativePath;
  };
  const sourceFor = (relativePath: string): SourceChanges => {
    const key = pathKey(relativePath);
    const existing = sources.get(key);
    if (existing) return existing;
    const created = { path: relativePath, replacements: [], delete: false };
    sources.set(key, created);
    return created;
  };

  for (const change of changes) {
    if (change.op === "replace") {
      const relativePath = writablePath(change.path);
      const source = sourceFor(relativePath);
      if (source.delete) fail("CHANGE_CONFLICT", `Cannot replace and delete the same file: ${relativePath}`);
      source.replacements.push({ oldText: change.oldText, newText: change.newText });
    } else if (change.op === "delete") {
      const relativePath = writablePath(change.path);
      const source = sourceFor(relativePath);
      if (source.delete || source.moveTo || source.replacements.length > 0) {
        fail("CHANGE_CONFLICT", `Delete conflicts with another operation: ${relativePath}`);
      }
      source.delete = true;
    } else if (change.op === "move") {
      const from = writablePath(change.from);
      const to = writablePath(change.to);
      if (pathKey(from) === pathKey(to)) fail("CHANGE_CONFLICT", `Move source and destination are the same: ${from}`);
      const source = sourceFor(from);
      if (source.delete || source.moveTo) fail("CHANGE_CONFLICT", `Move conflicts with another operation: ${from}`);
      source.moveTo = to;
      registerPath(destinations, to, `move from ${from}`);
    } else {
      const relativePath = writablePath(change.path);
      registerPath(destinations, relativePath, "create");
      creates.set(pathKey(relativePath), { path: relativePath, content: change.content });
    }
  }

  for (const [key, source] of sources) {
    if (creates.has(key) || destinations.has(key)) {
      fail("CHANGE_CONFLICT", `A source path is also a create or move destination: ${source.path}`);
    }
  }
  assertNoPrefixConflicts(allPaths);
  const planned = new Map<string, PlannedFile>();
  const sourceIdentities = new Map<string, string>();
  const setPlanned = (file: PlannedFile): void => {
    const key = pathKey(file.path);
    if (planned.has(key)) fail("CHANGE_CONFLICT", `Multiple final states target the same path: ${file.path}`);
    planned.set(key, file);
  };

  for (const source of sources.values()) {
    const before = await requireSourceState(projectRoot, source.path, normalizedBaseline);
    const identity = fileIdentities.get(before);
    if (identity) {
      const alias = sourceIdentities.get(identity);
      if (alias) fail("PATH_ALIAS_CONFLICT", `Changed paths name the same file: ${alias}, ${source.path}`);
      sourceIdentities.set(identity, source.path);
    }
    const transformed = applyReplacements(source.path, before, source.replacements);
    if (source.delete) {
      setPlanned({ path: source.path, before, after: null });
    } else if (source.moveTo) {
      if (normalizedBaseline.has(pathKey(source.moveTo))) {
        fail("DESTINATION_EXISTED", `Move destination existed when the AI baseline was captured: ${source.moveTo}`);
      }
      if ((await readProjectFileState(projectRoot, source.moveTo)) !== null) {
        fail("DESTINATION_EXISTS", `Move destination already exists: ${source.moveTo}`);
      }
      setPlanned({ path: source.path, before, after: null });
      setPlanned({ path: source.moveTo, before: null, after: transformed });
    } else if (!fileStatesEqual(before, transformed)) {
      setPlanned({ path: source.path, before, after: transformed });
    }
  }

  const createMode = 0o666 & ~process.umask();
  for (const create of creates.values()) {
    if (normalizedBaseline.has(pathKey(create.path))) {
      fail("DESTINATION_EXISTED", `Create destination existed when the AI baseline was captured: ${create.path}`);
    }
    if ((await readProjectFileState(projectRoot, create.path)) !== null) {
      fail("DESTINATION_EXISTS", `Create destination already exists: ${create.path}`);
    }
    setPlanned({
      path: create.path,
      before: null,
      after: { content: textEncoder.encode(create.content), mode: createMode },
    });
  }

  return {
    projectRoot,
    files: [...planned.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
};

const stateAt = (file: PlannedFile, side: PlanSide): FileState | null => {
  return file[side];
};

const currentStates = async (plan: FileChangePlan): Promise<Map<string, FileState | null>> => {
  const result = new Map<string, FileState | null>();
  for (const file of plan.files) result.set(pathKey(file.path), await readProjectFileState(plan.projectRoot, file.path));
  return result;
};

export const assertFilePlanState = async (plan: FileChangePlan, side: PlanSide): Promise<void> => {
  const current = await currentStates(plan);
  for (const file of plan.files) {
    if (!fileStatesAndIdentityEqual(current.get(pathKey(file.path)) ?? null, stateAt(file, side))) {
      fail("FILE_CHANGED", `File no longer matches the expected ${side} state: ${file.path}`);
    }
  }
};

const missingParentDirectories = async (root: string, files: readonly PlannedFile[], side: PlanSide): Promise<string[]> => {
  const missing = new Map<string, string>();
  for (const file of files) {
    if (stateAt(file, side) === null) continue;
    let parent = path.posix.dirname(file.path);
    while (parent !== ".") {
      const key = pathKey(parent);
      if (missing.has(key)) {
        parent = path.posix.dirname(parent);
        continue;
      }
      const absolute = await assertSafePath(root, parent);
      try {
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink()) fail("SYMLINK_UNSUPPORTED", `Symbolic links are not supported: ${parent}`);
        if (!stat.isDirectory()) fail("PATH_PARENT_INVALID", `Path parent is not a directory: ${parent}`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing.set(key, parent);
      }
      parent = path.posix.dirname(parent);
    }
  }
  return [...missing.values()].sort((left, right) => left.split("/").length - right.split("/").length);
};

const createDirectories = async (root: string, directories: readonly string[], createdOutput: string[]): Promise<void> => {
  const created: string[] = [];
  try {
    for (const relativePath of directories) {
      const absolute = await assertSafePath(root, relativePath);
      try {
        await mkdir(absolute);
        created.push(relativePath);
        createdOutput.push(relativePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          fail("PATH_PARENT_INVALID", `Path parent became unsafe: ${relativePath}`);
        }
      }
    }
  } catch (error) {
    try {
      await removeEmptyDirectories(root, created);
    } catch (cleanupError) {
      throw new AquariusError(
        "DIRECTORY_ROLLBACK_INCOMPLETE",
        `Directory creation failed (${String(error)}) and cleanup failed (${String(cleanupError)}).`,
      );
    }
    throw error;
  }
};

export const removeEmptyDirectories = async (root: string, directories: readonly string[]): Promise<void> => {
  const sorted = [...new Set(directories)].sort(
    (left, right) => right.split("/").length - left.split("/").length,
  );
  for (const relativePath of sorted) {
    try {
      const absolute = await assertSafePath(root, relativePath);
      await rmdir(absolute);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "SYMLINK_UNSUPPORTED") {
        throw error;
      }
    }
  }
};

const stageFile = async (root: string, relativePath: string, state: FileState): Promise<string> => {
  const target = absolutePath(root, relativePath);
  const temporary = path.join(path.dirname(target), `.aqfmt-${randomUUID()}.tmp`);
  await assertStableParent(root, relativePath);
  const handle = await open(temporary, "wx", state.mode);
  try {
    await handle.writeFile(state.content);
    await handle.chmod(state.mode);
    await handle.sync();
    await handle.close();
    await assertStableParent(root, relativePath);
    return temporary;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const cleanupTemporaryFiles = async (files: Iterable<string>): Promise<void> => {
  for (const file of files) {
    try {
      await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
};

const siblingArtifact = (root: string, relativePath: string, suffix: string): string => {
  const target = absolutePath(root, relativePath);
  return path.join(path.dirname(target), `.aqfmt-${randomUUID()}.${suffix}`);
};

const assertPlanContentState = async (plan: FileChangePlan, side: PlanSide): Promise<void> => {
  const current = await currentStates(plan);
  for (const file of plan.files) {
    if (!fileStatesEqual(current.get(pathKey(file.path)) ?? null, stateAt(file, side))) {
      fail("FILE_CHANGED", `File no longer matches the expected ${side} content: ${file.path}`);
    }
  }
};

const restoreMovedSources = async (
  plan: FileChangePlan,
  activeFiles: readonly PlannedFile[],
  from: PlanSide,
  to: PlanSide,
  backups: ReadonlyMap<string, string>,
  installed: ReadonlyMap<string, string>,
): Promise<void> => {
  await assertNoAlternateDataStreams(plan.projectRoot, activeFiles.map(({ path }) => path));
  for (const file of [...activeFiles].reverse()) {
    const key = pathKey(file.path);
    const target = absolutePath(plan.projectRoot, file.path);
    const backup = backups.get(key);
    const current = await readProjectFileState(plan.projectRoot, file.path);
    if (backup) {
      let displaced: string | undefined;
      if (current !== null) {
        const installedIdentity = installed.get(key);
        if (
          !installedIdentity
          || fileIdentities.get(current) !== installedIdentity
          || !fileStatesEqual(current, stateAt(file, to))
        ) {
          fail("FILE_CHANGED", `A user file appeared while restoring ${file.path}; backup was preserved at ${backup}`);
        }
        displaced = siblingArtifact(plan.projectRoot, file.path, "rollback");
        await assertStableParent(plan.projectRoot, file.path);
        await rename(target, displaced);
        await assertStableParent(plan.projectRoot, file.path);
      }
      try {
        await link(backup, target);
        await assertStableParent(plan.projectRoot, file.path);
        await unlink(backup);
      } catch (error) {
        if (displaced && (await readProjectFileState(plan.projectRoot, file.path)) === null) {
          await link(displaced, target).catch(() => undefined);
        }
        throw error;
      }
      if (displaced) await unlink(displaced);
    } else if (stateAt(file, from) === null && current !== null) {
      const installedIdentity = installed.get(key);
      if (
        !installedIdentity
        || fileIdentities.get(current) !== installedIdentity
        || !fileStatesEqual(current, stateAt(file, to))
      ) {
        fail("FILE_CHANGED", `A user file replaced the created path during rollback: ${file.path}`);
      }
      const discarded = siblingArtifact(plan.projectRoot, file.path, "rollback");
      await assertStableParent(plan.projectRoot, file.path);
      await rename(target, discarded);
      await assertStableParent(plan.projectRoot, file.path);
      await unlink(discarded);
    }
  }
  await assertPlanContentState(plan, from);
};

export const transitionFilePlan = async (
  plan: FileChangePlan,
  from: PlanSide,
  to: PlanSide,
  allowMixedKnownStates = false,
  createdDirectoriesOutput: string[] = [],
): Promise<string[]> => {
  const canonical = await canonicalProjectRoot(plan.projectRoot);
  if (canonical !== plan.projectRoot) fail("PROJECT_ROOT_CHANGED", "The project root changed after planning");

  const verifySource = async (): Promise<Map<string, FileState | null>> => {
    const current = await currentStates(plan);
    for (const file of plan.files) {
      const actual = current.get(pathKey(file.path)) ?? null;
      const matchesFrom = fileStatesAndIdentityEqual(actual, stateAt(file, from));
      const matchesTo = fileStatesEqual(actual, stateAt(file, to));
      if (!matchesFrom && (!allowMixedKnownStates || !matchesTo)) {
        fail("FILE_CHANGED", `File changed while applying the transaction: ${file.path}`);
      }
    }
    return current;
  };

  await verifySource();
  const directoryCandidates = await missingParentDirectories(plan.projectRoot, plan.files, to);
  const createdStart = createdDirectoriesOutput.length;
  await createDirectories(plan.projectRoot, directoryCandidates, createdDirectoriesOutput);
  const createdDirectories = createdDirectoriesOutput.slice(createdStart);
  const staged = new Map<string, string>();
  const backups = new Map<string, string>();
  const installed = new Map<string, string>();
  let activeFiles: PlannedFile[] = [];
  let finalStateVerified = false;
  try {
    for (const file of plan.files) {
      const target = stateAt(file, to);
      if (target !== null) staged.set(pathKey(file.path), await stageFile(plan.projectRoot, file.path, target));
    }
    const current = await verifySource();
    activeFiles = plan.files.filter((file) => (
      !fileStatesEqual(current.get(pathKey(file.path)) ?? null, stateAt(file, to))
    ));
    for (const file of activeFiles) {
      const source = stateAt(file, from);
      if (source === null) continue;
      const target = absolutePath(plan.projectRoot, file.path);
      const backup = siblingArtifact(plan.projectRoot, file.path, "backup");
      await assertStableParent(plan.projectRoot, file.path);
      await rename(target, backup);
      backups.set(pathKey(file.path), backup);
      await assertStableParent(plan.projectRoot, file.path);
      const moved = await readAbsoluteFileState(backup, file.path);
      if (!fileStatesAndIdentityEqual(moved, source)) {
        fail("FILE_CHANGED", `File changed while it was being secured for update: ${file.path}`);
      }
    }
    const backupPaths = [...backups.values()].map((backup) => slash(path.relative(plan.projectRoot, backup)));
    await assertNoAlternateDataStreams(plan.projectRoot, backupPaths);
    for (const file of activeFiles) {
      const temporary = staged.get(pathKey(file.path));
      if (!temporary) continue;
      const stagedState = await readAbsoluteFileState(temporary, file.path);
      const stagedIdentity = stagedState && fileIdentities.get(stagedState);
      if (!stagedIdentity) fail("FILE_IDENTITY_UNAVAILABLE", `Cannot identify staged file: ${file.path}`);
      await assertStableParent(plan.projectRoot, file.path);
      await link(temporary, absolutePath(plan.projectRoot, file.path));
      installed.set(pathKey(file.path), stagedIdentity);
      await assertStableParent(plan.projectRoot, file.path);
      await unlink(temporary);
      staged.delete(pathKey(file.path));
    }
    await cleanupTemporaryFiles(staged.values());
    staged.clear();
    await assertNoAlternateDataStreams(plan.projectRoot, [...backupPaths, ...plan.files.map(({ path }) => path)]);
    for (const file of activeFiles) {
      const backup = backups.get(pathKey(file.path));
      if (!backup) continue;
      const secured = await readAbsoluteFileState(backup, file.path);
      if (!fileStatesAndIdentityEqual(secured, stateAt(file, from))) {
        fail("FILE_CHANGED", `The secured source was edited during the transaction: ${file.path}`);
      }
    }
    await assertPlanContentState(plan, to);
    finalStateVerified = true;
    for (const backup of backups.values()) await unlink(backup);
    return createdDirectories;
  } catch (error) {
    let cleanupError: unknown;
    try {
      await cleanupTemporaryFiles(staged.values());
      if (!finalStateVerified) {
        await restoreMovedSources(plan, activeFiles, from, to, backups, installed);
        await removeEmptyDirectories(plan.projectRoot, createdDirectories);
      }
    } catch (caught) {
      cleanupError = caught;
    }
    if (cleanupError) {
      throw new AquariusError(
        "FILE_TRANSACTION_INCOMPLETE",
        `File transition failed (${String(error)}) and local recovery failed (${String(cleanupError)}).`,
      );
    }
    if (!finalStateVerified) throw new FileTransitionRecoveredError(error);
    throw error;
  }
};

export const applyFileChanges = async (
  plan: FileChangePlan,
  store: GitUndoStore | null,
): Promise<{ changedFiles: string[]; undoAvailable: boolean }> => {
  if (plan.files.length === 0) return { changedFiles: [], undoAvailable: store !== null };
  await assertFilePlanState(plan, "before");
  const directoryCandidates = await missingParentDirectories(plan.projectRoot, plan.files, "after");
  const transaction = store ? await store.begin(plan, directoryCandidates) : null;
  let createdDirectories: string[] = [];
  try {
    await transitionFilePlan(plan, "before", "after", false, createdDirectories);
    if (transaction) await transaction.commit(createdDirectories);
  } catch (error) {
    if (transaction?.committed) throw error;
    if (error instanceof FileTransitionRecoveredError) {
      try {
        await removeEmptyDirectories(plan.projectRoot, createdDirectories);
        if (transaction) await transaction.abort();
      } catch (cleanupError) {
        if (transaction) await transaction.preserve().catch(() => undefined);
        throw new AquariusError(
          "APPLY_ROLLBACK_INCOMPLETE",
          `File change was restored but cleanup failed (${String(cleanupError)}). Recovery data was preserved.`,
        );
      }
      throw error.original;
    }
    if (error instanceof AquariusError && error.code === "FILE_TRANSACTION_INCOMPLETE") {
      if (transaction) await transaction.preserve().catch(() => undefined);
      throw new AquariusError(
        "APPLY_ROLLBACK_INCOMPLETE",
        `${error.message}${transaction ? " Recovery data was preserved." : " Git recovery data is unavailable."}`,
      );
    }
    try {
      await transitionFilePlan(plan, "after", "before", true);
      await removeEmptyDirectories(plan.projectRoot, createdDirectories);
      if (transaction) await transaction.abort();
    } catch (rollbackError) {
      if (transaction) await transaction.preserve();
      throw new AquariusError(
        "APPLY_ROLLBACK_INCOMPLETE",
        `File change failed (${String(error)}) and rollback was incomplete (${String(rollbackError)}).${
          transaction ? " Recovery data was preserved." : " Git recovery data is unavailable."
        }`,
      );
    }
    throw error;
  }
  return { changedFiles: plan.files.map((file) => file.path), undoAvailable: store !== null };
};
