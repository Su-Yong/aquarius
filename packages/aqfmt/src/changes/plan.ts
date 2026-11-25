import { AquariusError } from "@aquarius/core/runtime";
import type { FileChange } from "./schema";
import {
  canonicalProjectRoot,
  fileIdentity,
  fileStatesEqual,
  normalizeRelativePath,
  pathKey,
  readProjectFileState,
  requireSourceState,
} from "./state";
import type { FileBaseline, FileChangePlan, FileState, PlannedFile } from "./types";

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const textEncoder = new TextEncoder();

interface SourceChanges {
  path: string;
  replacements: { oldText: string; newText: string }[];
  delete: boolean;
  moveTo?: string;
}

const fail: (code: string, message: string) => never = (code, message) => {
  throw new AquariusError(code, message);
};

const copyState = (state: FileState): FileState => {
  return { content: new Uint8Array(state.content), mode: state.mode };
};

const registerPath = (
  map: Map<string, string>,
  relativePath: string,
  description: string,
): void => {
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
        fail(
          "PATH_CONFLICT",
          `A file path cannot also be another changed path's parent: ${parent}, ${child}`,
        );
      }
    }
  }
};

const applyReplacements = (
  relativePath: string,
  state: FileState,
  replacements: SourceChanges["replacements"],
): FileState => {
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
      fail(
        "REPLACE_NOT_UNIQUE",
        `oldText must occur exactly once in the original file: ${relativePath}`,
      );
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
    if (!canWrite(relativePath))
      fail("PATH_NOT_WRITABLE", `Path is outside the writable target or ignored: ${relativePath}`);
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
      if (source.delete)
        fail("CHANGE_CONFLICT", `Cannot replace and delete the same file: ${relativePath}`);
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
      if (pathKey(from) === pathKey(to))
        fail("CHANGE_CONFLICT", `Move source and destination are the same: ${from}`);
      const source = sourceFor(from);
      if (source.delete || source.moveTo)
        fail("CHANGE_CONFLICT", `Move conflicts with another operation: ${from}`);
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
    if (planned.has(key))
      fail("CHANGE_CONFLICT", `Multiple final states target the same path: ${file.path}`);
    planned.set(key, file);
  };

  for (const source of sources.values()) {
    const before = await requireSourceState(projectRoot, source.path, normalizedBaseline);
    const identity = fileIdentity(before);
    if (identity) {
      const alias = sourceIdentities.get(identity);
      if (alias)
        fail("PATH_ALIAS_CONFLICT", `Changed paths name the same file: ${alias}, ${source.path}`);
      sourceIdentities.set(identity, source.path);
    }
    const transformed = applyReplacements(source.path, before, source.replacements);
    if (source.delete) {
      setPlanned({ path: source.path, before, after: null });
    } else if (source.moveTo) {
      if (normalizedBaseline.has(pathKey(source.moveTo))) {
        fail(
          "DESTINATION_EXISTED",
          `Move destination existed when the AI baseline was captured: ${source.moveTo}`,
        );
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
      fail(
        "DESTINATION_EXISTED",
        `Create destination existed when the AI baseline was captured: ${create.path}`,
      );
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
