import { lstatSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { AquariusError, isNodeError } from "../shared/errors";
import { isInside, toPosix } from "../shared/path";

export const toProjectRelative = (
  projectRoot: string,
  absolute: string,
  allowRoot = false,
): string => {
  const path = relative(projectRoot, absolute);
  if ((!allowRoot && path === "") || !isInside(projectRoot, absolute)) {
    throw new AquariusError(
      "TARGET_PATH_OUTSIDE_ROOT",
      `Target escapes the project root: ${absolute}`,
    );
  }
  return toPosix(path);
};

export const isRegularPath = async (projectRoot: string, path: string): Promise<boolean> => {
  try {
    return (await lstat(resolve(projectRoot, ...path.split("/")))).isFile();
  } catch {
    return false;
  }
};

export const tryLstat = async (
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> => {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
};

export const hasSymlinkComponent = async (projectRoot: string, path: string): Promise<boolean> => {
  let current = projectRoot;
  for (const part of path.split("/")) {
    current = join(current, part);
    const info = await tryLstat(current);
    if (!info) return false;
    if (info.isSymbolicLink()) return true;
  }
  return false;
};

export const hasSymlinkComponentSync = (projectRoot: string, path: string): boolean => {
  let current = projectRoot;
  for (const part of path.split("/")) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      return !isNodeError(error, "ENOENT");
    }
  }
  return false;
};
