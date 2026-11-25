import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, parse, posix, relative, resolve, sep } from "node:path";

import {
  isDefaultIgnored,
  isIgnoredByMatchers,
  loadExtractionGitignoreMatchers,
  loadManualIgnores,
  vcsIgnoreGlobs,
} from "../files/ignores";
import { isRegularPath } from "../files/paths";
import { discoverFiles } from "../files/targets";
import type { TargetOptions } from "../files/types";
import { AquariusError, errorMessage, isNodeError } from "../shared/errors";
import { isInside, safeRelativePath, toPosix } from "../shared/path";

export const DEFAULT_MAX_EXTRACTION_FILES = 300;

interface ExtractionTargetOptions extends Omit<TargetOptions, "noErrorOnUnmatchedPattern"> {
  cwd: string;
  maxFiles?: number;
  signal?: AbortSignal;
}

interface SourceTarget {
  path: string;
  isDirectory: boolean;
}

interface ExtractionTargets {
  sourceRoot: string;
  readableFiles: string[];
  totalDiscovered: number;
  sampledCount: number;
}

export const collectExtractionTargets = async (
  options: ExtractionTargetOptions,
): Promise<ExtractionTargets> => {
  const { signal, maxFiles = DEFAULT_MAX_EXTRACTION_FILES } = options;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new AquariusError("TARGET_LIMIT_INVALID", "--max-files must be a positive safe integer.");
  }
  assertActive(signal);

  const cwd = await realpath(options.cwd);
  const inputs = options.paths?.length ? options.paths : ["."];
  const targets = await Promise.all(inputs.map((path) => resolveSourceTarget(cwd, path)));
  const home = await realpath(homedir()).catch(() => resolve(homedir()));
  const sourceRoot = resolveSourceRoot(targets, home);
  assertActive(signal);
  const scopedTargets = targets.filter(
    ({ path, isDirectory }) =>
      !isDefaultIgnored(toPosix(isDirectory ? `${path}${sep}` : path), options),
  );
  const discoveryIgnores = options.withNodeModules
    ? vcsIgnoreGlobs
    : [...vcsIgnoreGlobs, "**/node_modules/**"];
  const [manualIgnores, gitMatchers, candidates] = await Promise.all([
    loadManualIgnores({ cwd }, options, sourceRoot),
    scopedTargets.length ? loadExtractionGitignoreMatchers(sourceRoot, home, discoveryIgnores) : [],
    discoverScopedFiles(sourceRoot, scopedTargets, discoveryIgnores),
  ]);

  const discovered: string[] = [];
  for (const path of candidates) {
    assertActive(signal);
    if (
      isDefaultIgnored(path, options) ||
      isIgnoredByMatchers(manualIgnores, sourceRoot, path) ||
      isIgnoredByMatchers(gitMatchers, sourceRoot, path)
    ) {
      continue;
    }
    if (await isReadableFile(sourceRoot, path)) discovered.push(path);
  }

  assertActive(signal);
  discovered.sort();
  const readableFiles =
    discovered.length > maxFiles ? sampleFiles(discovered, maxFiles) : discovered;

  return {
    sourceRoot,
    readableFiles,
    totalDiscovered: discovered.length,
    sampledCount: readableFiles.length,
  };
};

const resolveSourceTarget = async (cwd: string, raw: string): Promise<SourceTarget> => {
  if (raw.trim() === "") {
    throw new AquariusError("TARGET_PATH_INVALID", "Target paths cannot be empty.");
  }

  const { root } = parse(raw);
  const segments = raw
    .slice(root.length)
    .split(sep === "\\" ? /[/\\]+/u : /\/+/u)
    .filter(Boolean);
  let path = resolve(cwd, root);

  try {
    let stats = await lstat(path);
    for (const segment of segments) {
      if (!stats.isDirectory()) {
        throw new AquariusError("TARGET_PATH_INVALID", `Target crosses a non-directory: ${raw}`);
      }
      path = resolve(path, segment);
      stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        throw new AquariusError(
          "TARGET_SYMLINK_UNSUPPORTED",
          `Symbolic link targets are not supported: ${raw}`,
        );
      }
    }
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new AquariusError(
        "TARGET_PATH_INVALID",
        `Target is not a regular file or directory: ${raw}`,
      );
    }
    return { path: await realpath(path), isDirectory: stats.isDirectory() };
  } catch (error) {
    if (error instanceof AquariusError) throw error;
    if (isNodeError(error, "ENOENT")) {
      throw new AquariusError("TARGET_PATH_NOT_FOUND", `Target does not exist: ${raw}`);
    }
    throw new AquariusError(
      "TARGET_PATH_INVALID",
      `Cannot access target ${raw}: ${errorMessage(error)}`,
    );
  }
};

const resolveSourceRoot = (targets: readonly SourceTarget[], home: string): string => {
  const directories = targets.map(({ path, isDirectory }) => (isDirectory ? path : dirname(path)));
  let root = directories[0]!;

  for (const directory of directories.slice(1)) {
    while (!isInside(root, directory)) {
      const parent = dirname(root);
      if (parent === root) {
        throw new AquariusError("TARGET_ROOT_UNSAFE", "Targets do not share a local directory.");
      }
      root = parent;
    }
  }
  if (dirname(root) === root || isInside(root, home)) {
    throw new AquariusError("TARGET_ROOT_UNSAFE", `Common target root is too broad: ${root}`);
  }
  return root;
};

const discoverScopedFiles = async (
  sourceRoot: string,
  targets: readonly SourceTarget[],
  ignore: string[],
): Promise<Set<string>> => {
  const uniqueTargets = [...new Map(targets.map((target) => [target.path, target])).values()];
  const scopes = uniqueTargets.filter(
    ({ path }) =>
      !uniqueTargets.some(
        (other) => other.path !== path && other.isDirectory && isInside(other.path, path),
      ),
  );
  const filesByScope = await Promise.all(
    scopes.map(async ({ path, isDirectory }) => {
      const filePaths = isDirectory
        ? (await discoverFiles(path, ignore))
            .filter(safeRelativePath)
            .map((file) => join(path, file))
        : [path];
      return filePaths.map((file) => {
        const projectPath = relative(sourceRoot, file);
        return sep === "\\" ? toPosix(projectPath) : projectPath;
      });
    }),
  );
  return new Set(filesByScope.flat().filter(safeRelativePath));
};

const isReadableFile = async (root: string, path: string): Promise<boolean> => {
  if (!(await isRegularPath(root, path))) return false;
  try {
    await access(join(root, path), constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

const sampleFiles = (paths: readonly string[], count: number): string[] => {
  const groups = new Map<string, Map<string, string[]>>();
  for (const path of paths) {
    const directory = posix.dirname(path);
    const extension = extname(path);
    const extensions = groups.get(directory) ?? new Map<string, string[]>();
    const files = extensions.get(extension) ?? [];
    files.push(path);
    extensions.set(extension, files);
    groups.set(directory, extensions);
  }

  const directories = [...groups.values()].map((extensions) => interleave(extensions.values()));
  const sampled: string[] = [];
  for (const path of interleave(directories)) {
    sampled.push(path);
    if (sampled.length === count) break;
  }
  return sampled.sort();
};

function* interleave<T>(groups: Iterable<Iterable<T>>): Generator<T> {
  let remaining = [...groups].map((group) => group[Symbol.iterator]());
  while (remaining.length > 0) {
    const nextRound: typeof remaining = [];
    for (const iterator of remaining) {
      const next = iterator.next();
      if (next.done) continue;
      yield next.value;
      nextRound.push(iterator);
    }
    remaining = nextRound;
  }
}

const assertActive = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new AquariusError("AI_ABORTED", "Target collection was cancelled.");
};
