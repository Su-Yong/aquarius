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
  const isOutsideAllowedRoot = (!allowRoot && path === "") || !isInside(projectRoot, absolute);
  if (isOutsideAllowedRoot) {
    throw new AquariusError(
      "TARGET_PATH_OUTSIDE_ROOT",
      `Target escapes the project root: ${absolute}`,
    );
  }
  return toPosix(path);
};

export const isRegularPath = async (projectRoot: string, path: string): Promise<boolean> => {
  try {
    const pathSegments = path.split("/");
    const absolutePath = resolve(projectRoot, ...pathSegments);
    const stats = await lstat(absolutePath);
    return stats.isFile();
  } catch {
    return false;
  }
};

export const hasSymlinkComponent = async (projectRoot: string, path: string): Promise<boolean> => {
  let currentPath = projectRoot;
  for (const part of path.split("/")) {
    currentPath = join(currentPath, part);
    const stats = await tryLstat(currentPath);
    if (!stats) return false;
    if (stats.isSymbolicLink()) return true;
  }
  return false;
};

export const hasSymlinkComponentSync = (projectRoot: string, path: string): boolean => {
  let currentPath = projectRoot;
  for (const part of path.split("/")) {
    currentPath = join(currentPath, part);
    try {
      if (lstatSync(currentPath).isSymbolicLink()) return true;
    } catch (error) {
      return !isNodeError(error, "ENOENT");
    }
  }
  return false;
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
