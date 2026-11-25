import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { BigIntStats } from "node:fs";

import { AquariusError } from "./errors";
import { isInside, safeRelativePath } from "./path";

export const readStableRegularFile = async (
  projectRoot: string,
  relativeFile: string,
  signal?: AbortSignal,
): Promise<{ content: Buffer; mode: number }> => {
  assertNotAborted(signal);
  const validatedPath = safeRelativePath(relativeFile);
  if (!validatedPath) {
    throw new AquariusError("FILE_PATH_INVALID", `Invalid project-relative file: ${relativeFile}`);
  }

  const root = await realpath(projectRoot);
  let currentPath = root;
  for (const segment of validatedPath.split("/")) {
    assertNotAborted(signal);
    currentPath = join(currentPath, segment);
    const segmentStats = await lstat(currentPath);
    if (segmentStats.isSymbolicLink()) {
      throw new AquariusError(
        "FILE_PATH_UNSUPPORTED",
        `File path contains a symbolic link: ${validatedPath}`,
      );
    }
  }

  const resolvedBefore = await realpath(currentPath);
  if (!isInside(root, resolvedBefore) || relative(currentPath, resolvedBefore) !== "") {
    throw new AquariusError(
      "FILE_PATH_INVALID",
      `File does not resolve to its project path: ${validatedPath}`,
    );
  }
  const pathBefore = await lstat(currentPath, { bigint: true });
  if (!pathBefore.isFile()) {
    throw new AquariusError("FILE_PATH_UNSUPPORTED", `Expected a regular file: ${validatedPath}`);
  }

  // A replacement symlink or FIFO must not be followed or block the read.
  const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(currentPath, openFlags);
  try {
    const handleBefore = await handle.stat({ bigint: true });
    const resolvedOpened = await realpath(currentPath);
    const pathOpened = await lstat(currentPath, { bigint: true });
    const changedBeforeRead =
      resolvedOpened !== resolvedBefore ||
      !sameFile(pathBefore, handleBefore) ||
      !sameFile(pathOpened, handleBefore) ||
      !handleBefore.isFile();
    if (changedBeforeRead) {
      throw new AquariusError(
        "FILE_SOURCE_CHANGED",
        `File changed before reading: ${validatedPath}`,
      );
    }

    assertNotAborted(signal);
    const content = await handle.readFile();
    const handleAfter = await handle.stat({ bigint: true });
    const resolvedAfter = await realpath(currentPath);
    const pathAfter = await lstat(currentPath, { bigint: true });
    const changedDuringRead =
      resolvedBefore !== resolvedAfter ||
      !sameFile(handleBefore, handleAfter) ||
      !sameFile(pathAfter, handleAfter) ||
      handleBefore.size !== handleAfter.size ||
      handleBefore.mtimeNs !== handleAfter.mtimeNs ||
      handleBefore.ctimeNs !== handleAfter.ctimeNs ||
      handleBefore.mode !== handleAfter.mode ||
      BigInt(content.byteLength) !== handleBefore.size;
    if (changedDuringRead) {
      throw new AquariusError(
        "FILE_SOURCE_CHANGED",
        `File changed while reading: ${validatedPath}`,
      );
    }
    assertNotAborted(signal);
    const permissionBits = handleBefore.mode & 0o777n;
    return { content, mode: Number(permissionBits) };
  } finally {
    await handle.close();
  }
};

const sameFile = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const assertNotAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
};
