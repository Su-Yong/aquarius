import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { AquariusError } from "./errors";
import { isInside, safeRelativePath } from "./path";

const sameFile = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const assertNotAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
};

export const readStableRegularFile = async (
  projectRoot: string,
  relativeFile: string,
  signal?: AbortSignal,
): Promise<{ content: Buffer; mode: number }> => {
  assertNotAborted(signal);
  const path = safeRelativePath(relativeFile);
  if (!path) {
    throw new AquariusError("FILE_PATH_INVALID", `Invalid project-relative file: ${relativeFile}`);
  }

  const root = await realpath(projectRoot);
  let current = root;
  for (const segment of path.split("/")) {
    assertNotAborted(signal);
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new AquariusError(
        "FILE_PATH_UNSUPPORTED",
        `File path contains a symbolic link: ${path}`,
      );
    }
  }

  const resolvedBefore = await realpath(current);
  if (!isInside(root, resolvedBefore) || relative(current, resolvedBefore) !== "") {
    throw new AquariusError(
      "FILE_PATH_INVALID",
      `File does not resolve to its project path: ${path}`,
    );
  }
  const pathBefore = await lstat(current, { bigint: true });
  if (!pathBefore.isFile()) {
    throw new AquariusError("FILE_PATH_UNSUPPORTED", `Expected a regular file: ${path}`);
  }

  // A replacement symlink or FIFO must not be followed or block the read.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(current, flags);
  try {
    const handleBefore = await handle.stat({ bigint: true });
    const resolvedOpened = await realpath(current);
    const pathOpened = await lstat(current, { bigint: true });
    if (
      resolvedOpened !== resolvedBefore ||
      !sameFile(pathBefore, handleBefore) ||
      !sameFile(pathOpened, handleBefore) ||
      !handleBefore.isFile()
    ) {
      throw new AquariusError("FILE_SOURCE_CHANGED", `File changed before reading: ${path}`);
    }

    assertNotAborted(signal);
    const content = await handle.readFile();
    const handleAfter = await handle.stat({ bigint: true });
    const resolvedAfter = await realpath(current);
    const pathAfter = await lstat(current, { bigint: true });
    if (
      resolvedBefore !== resolvedAfter ||
      !sameFile(handleBefore, handleAfter) ||
      !sameFile(pathAfter, handleAfter) ||
      handleBefore.size !== handleAfter.size ||
      handleBefore.mtimeNs !== handleAfter.mtimeNs ||
      handleBefore.ctimeNs !== handleAfter.ctimeNs ||
      handleBefore.mode !== handleAfter.mode ||
      BigInt(content.byteLength) !== handleBefore.size
    ) {
      throw new AquariusError("FILE_SOURCE_CHANGED", `File changed while reading: ${path}`);
    }
    assertNotAborted(signal);
    return { content, mode: Number(handleBefore.mode & 0o777n) };
  } finally {
    await handle.close();
  }
};
