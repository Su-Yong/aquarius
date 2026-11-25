import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";

import { AquariusError, isNodeError } from "../shared/errors";
import { safeRelativePath } from "../shared/path";
import { readStableRegularFile } from "../shared/safe-fs";

const SNAPSHOT_PROGRESS_INTERVAL = 100;

export const createReadonlySnapshot = async (
  projectRoot: string,
  readableFiles: readonly string[],
  viewRoot: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<string[]> => {
  assertActive(signal);
  const sourceRoot = await realpath(projectRoot);
  const sourceStats = await lstat(sourceRoot);
  if (!sourceStats.isDirectory()) {
    throw new AquariusError("SNAPSHOT_ROOT_INVALID", "Project root must be a regular directory.");
  }
  const destinationRoot = await snapshotRoot(viewRoot);
  if (destinationRoot === sourceRoot) {
    throw new AquariusError(
      "SNAPSHOT_ROOT_INVALID",
      "Snapshot root must differ from the project root.",
    );
  }
  const files = normalizeSnapshotPaths(readableFiles);

  for (const [index, path] of files.entries()) {
    assertActive(signal);
    const file = await readStableRegularFile(sourceRoot, path, signal);
    const outputPath = join(destinationRoot, path);
    const mode = process.platform === "win32" ? file.mode | 0o200 : file.mode & 0o555;
    await ensureSnapshotParents(destinationRoot, path);
    assertActive(signal);
    try {
      await writeSnapshotFile(outputPath, file.content, mode, signal);
    } catch (error) {
      assertActive(signal);
      if (!isNodeError(error, "EEXIST")) throw error;
      throw new AquariusError("SNAPSHOT_CONFLICT", `Snapshot file already exists: ${path}`);
    }

    const count = index + 1;
    const shouldReportProgress =
      count === 1 || count % SNAPSHOT_PROGRESS_INTERVAL === 0 || count === files.length;
    if (shouldReportProgress) {
      onProgress?.(`Preparing snapshot ${count}/${files.length}: ${path}`);
    }
  }
  assertActive(signal);
  return files;
};

export const snapshotRoot = async (viewRoot: string): Promise<string> => {
  const rootStats = await lstat(viewRoot);
  if (!rootStats.isDirectory()) {
    throw new AquariusError("SNAPSHOT_ROOT_INVALID", "Snapshot root must be a regular directory.");
  }
  return realpath(viewRoot);
};

export const writeSnapshotFile = async (
  path: string,
  content: string | Uint8Array,
  mode: number,
  signal?: AbortSignal,
): Promise<void> => {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(content, { signal });
    if (process.platform !== "win32") await handle.chmod(mode);
  } finally {
    await handle.close();
  }
};

const assertActive = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw new AquariusError("AI_ABORTED", "Snapshot creation was cancelled.");
  }
};

const normalizeSnapshotPaths = (paths: readonly string[]): string[] => {
  const seen = new Set<string>();
  const normalizeUniquePath = (input: string): string => {
    const path = safeRelativePath(input);
    if (!path) {
      throw new AquariusError(
        "FILE_PATH_INVALID",
        `Snapshot path must be a normalized project-relative path: ${input}`,
      );
    }
    const comparisonPath = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(comparisonPath)) {
      throw new AquariusError("FILE_PATH_INVALID", `Duplicate snapshot path: ${path}`);
    }
    seen.add(comparisonPath);
    return path;
  };
  return paths.map(normalizeUniquePath);
};

const ensureSnapshotParents = async (root: string, path: string): Promise<void> => {
  const parents = path.split("/").slice(0, -1);
  let directory = root;
  for (const parent of parents) {
    directory = join(directory, parent);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const directoryStats = await lstat(directory);
      if (!directoryStats.isDirectory()) {
        throw new AquariusError("SNAPSHOT_CONFLICT", `Snapshot directory conflicts with: ${path}`);
      }
    }
  }
};
