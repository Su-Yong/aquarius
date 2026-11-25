import { AquariusError, toRunError, type RunError } from "@aqtools/core/runtime";

import { applyReplacementPatches, ReplacementPatchError } from "./patch";
import {
  canonicalProjectRoot,
  fileIdentity,
  fileStatesEqual,
  normalizeRelativePath,
  pathKey,
  readProjectFileState,
  requireSourceState,
} from "./state";
import type { FileChange, ReplaceChange } from "./schema";
import type { FileBaseline, FileChangePlan, FileState, PlannedFile } from "./types";

interface SourceChanges {
  path: string;
  replacements: ReplaceChange[];
  delete: boolean;
  moveTo?: string;
}

export interface ReplacementFailure {
  path: string;
  error: RunError;
  repairable: boolean;
}

const textEncoder = new TextEncoder();

export const planFileChanges = async (
  root: string,
  changes: readonly FileChange[],
  canWrite: (relativePath: string) => boolean,
  baseline: ReadonlyMap<string, FileBaseline>,
): Promise<FileChangePlan> => {
  const projectRoot = await canonicalProjectRoot(root);
  const normalizedBaseline = normalizeBaseline(projectRoot, baseline);

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
    const sourceChanges: SourceChanges = { path: relativePath, replacements: [], delete: false };
    sources.set(key, sourceChanges);
    return sourceChanges;
  };

  for (const change of changes) {
    if (change.op === "replace") {
      const relativePath = writablePath(change.path);
      const source = sourceFor(relativePath);
      if (source.delete)
        fail("CHANGE_CONFLICT", `Cannot replace and delete the same file: ${relativePath}`);
      source.replacements.push(change);
    } else if (change.op === "delete") {
      const relativePath = writablePath(change.path);
      const source = sourceFor(relativePath);
      const conflictsWithDelete = source.delete || source.moveTo || source.replacements.length > 0;
      if (conflictsWithDelete) {
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
  const setPlanned = (file: PlannedFile): void => {
    const key = pathKey(file.path);
    if (planned.has(key))
      fail("CHANGE_CONFLICT", `Multiple final states target the same path: ${file.path}`);
    planned.set(key, file);
  };

  const sourceIdentities = new Map<string, string>();
  for (const source of sources.values()) {
    const before = await requireSourceState(projectRoot, source.path, normalizedBaseline);
    const identity = fileIdentity(before);
    if (identity) {
      const alias = sourceIdentities.get(identity);
      if (alias)
        fail("PATH_ALIAS_CONFLICT", `Changed paths name the same file: ${alias}, ${source.path}`);
      sourceIdentities.set(identity, source.path);
    }

    const transformed = applyReplacementPatches(source.path, before, source.replacements);
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

export const planPartialFileReplacements = async (
  root: string,
  changes: readonly ReplaceChange[],
  canWrite: (relativePath: string) => boolean,
  baseline: ReadonlyMap<string, FileBaseline>,
): Promise<{ plan: FileChangePlan; failures: ReplacementFailure[] }> => {
  const projectRoot = await canonicalProjectRoot(root);
  const normalizedBaseline = normalizeBaseline(projectRoot, baseline);

  const files: PlannedFile[] = [];
  const failures: ReplacementFailure[] = [];
  const replacements = Map.groupBy(changes, ({ path }) => pathKey(path));
  const sources: { path: string; before: FileState; changes: ReplaceChange[] }[] = [];
  const aliases = new Map<string, string[]>();

  const recordFailure = (path: string, cause: unknown): void => {
    const patchError = cause instanceof ReplacementPatchError ? cause : undefined;
    failures.push({
      path,
      error: toRunError(cause, undefined, patchError?.ruleIds),
      repairable: patchError !== undefined,
    });
  };

  for (const entries of replacements.values()) {
    const { path } = entries[0]!;
    try {
      const relativePath = normalizeRelativePath(projectRoot, path);
      if (path !== relativePath || !canWrite(relativePath)) {
        fail("CHANGE_OUTSIDE_SCOPE", `Change is outside the selected scope: ${path}`);
      }

      const before = await requireSourceState(projectRoot, relativePath, normalizedBaseline);
      const identity = fileIdentity(before);
      const expectedIdentity = normalizedBaseline.get(pathKey(relativePath))?.identity;
      if (expectedIdentity !== undefined && expectedIdentity !== identity) {
        fail("SOURCE_CHANGED", `File changed after the AI baseline was captured: ${relativePath}`);
      }

      sources.push({ path, before, changes: entries });
      if (identity) {
        const paths = aliases.get(identity);
        if (paths) paths.push(path);
        else aliases.set(identity, [path]);
      }
    } catch (cause) {
      recordFailure(path, cause);
    }
  }

  for (const { path, before, changes } of sources) {
    try {
      const paths = aliases.get(fileIdentity(before) ?? "");
      if (paths && paths.length > 1) {
        fail("PATH_ALIAS_CONFLICT", `Changed paths name the same file: ${paths.join(", ")}`);
      }

      const after = applyReplacementPatches(path, before, changes);
      if (!fileStatesEqual(before, after)) files.push({ path, before, after });
    } catch (cause) {
      recordFailure(path, cause);
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return { plan: { projectRoot, files }, failures };
};

const fail: (code: string, message: string) => never = (code, message) => {
  throw new AquariusError(code, message);
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
  const sortedPathKeys = [...new Set(paths.map(pathKey))].sort();

  for (let index = 0; index < sortedPathKeys.length; index += 1) {
    const parent = sortedPathKeys[index]!;
    for (let childIndex = index + 1; childIndex < sortedPathKeys.length; childIndex += 1) {
      const child = sortedPathKeys[childIndex]!;
      if (child.startsWith(`${parent}/`)) {
        fail(
          "PATH_CONFLICT",
          `A file path cannot also be another changed path's parent: ${parent}, ${child}`,
        );
      }
    }
  }
};

const normalizeBaseline = (
  projectRoot: string,
  baseline: ReadonlyMap<string, FileBaseline>,
): Map<string, FileBaseline> => {
  const normalized = new Map<string, FileBaseline>();
  for (const [input, value] of baseline) {
    const relativePath = normalizeRelativePath(projectRoot, input);
    normalized.set(pathKey(relativePath), value);
  }

  return normalized;
};
