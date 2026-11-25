import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { AquariusError, isNodeError } from "../shared/errors";
import { safeRelativePath } from "../shared/path";
import { readStableRegularFile } from "../shared/safe-fs";

export const snapshotRoot = async (viewRoot: string): Promise<string> => {
  if (!(await lstat(viewRoot)).isDirectory()) {
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

const normalizedFiles = (paths: readonly string[]): string[] => {
  const seen = new Set<string>();
  return paths.map((input) => {
    const path = safeRelativePath(input);
    if (!path) {
      throw new AquariusError(
        "FILE_PATH_INVALID",
        `Snapshot path must be a normalized project-relative path: ${input}`,
      );
    }
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) {
      throw new AquariusError("FILE_PATH_INVALID", `Duplicate snapshot path: ${path}`);
    }
    seen.add(key);
    return path;
  });
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
      if (!(await lstat(directory)).isDirectory()) {
        throw new AquariusError("SNAPSHOT_CONFLICT", `Snapshot directory conflicts with: ${path}`);
      }
    }
  }
};

export const createReadonlySnapshot = async (
  projectRoot: string,
  readableFiles: readonly string[],
  viewRoot: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<string[]> => {
  assertActive(signal);
  const source = await realpath(projectRoot);
  if (!(await lstat(source)).isDirectory()) {
    throw new AquariusError("SNAPSHOT_ROOT_INVALID", "Project root must be a regular directory.");
  }
  const destination = await snapshotRoot(viewRoot);
  if (destination === source) {
    throw new AquariusError(
      "SNAPSHOT_ROOT_INVALID",
      "Snapshot root must differ from the project root.",
    );
  }
  const files = normalizedFiles(readableFiles);

  for (const [index, path] of files.entries()) {
    assertActive(signal);
    const file = await readStableRegularFile(source, path, signal);
    const output = join(destination, path);
    const mode = process.platform === "win32" ? file.mode | 0o200 : file.mode & 0o555;
    await ensureSnapshotParents(destination, path);
    assertActive(signal);
    try {
      await writeSnapshotFile(output, file.content, mode, signal);
    } catch (error) {
      assertActive(signal);
      if (!isNodeError(error, "EEXIST")) throw error;
      throw new AquariusError("SNAPSHOT_CONFLICT", `Snapshot file already exists: ${path}`);
    }

    const count = index + 1;
    if (count === 1 || count % 100 === 0 || count === files.length) {
      onProgress?.(`Preparing snapshot ${count}/${files.length}: ${path}`);
    }
  }
  assertActive(signal);
  return files;
};
