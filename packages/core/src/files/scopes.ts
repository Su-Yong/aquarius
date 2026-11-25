import { isAbsolute, matchesGlob, posix, relative, resolve } from "node:path";

import { isDynamicPattern } from "globby";

import { AquariusError } from "../shared/errors";
import { isInside, toPosix } from "../shared/path";
import type { LoadedConfig } from "../config/types";

import { hasSymlinkComponent, toProjectRelative, tryLstat } from "./paths";
import type { TargetOptions } from "./types";

type Scope =
  | { kind: "file"; path: string; raw: string }
  | { kind: "directory"; path: string; raw: string }
  | { kind: "glob"; pattern: string; raw: string };

export const createScopes = async (
  config: LoadedConfig,
  options: TargetOptions,
): Promise<{ positive: Scope[]; negative: string[] }> => {
  const defaultTarget = isInside(config.projectRoot, config.cwd) ? config.cwd : config.projectRoot;
  const inputs = options.paths?.length ? options.paths : [defaultTarget];
  const positive: Scope[] = [];
  const negative: string[] = [];

  for (const raw of inputs) {
    if (raw.trim() === "") {
      throw new AquariusError("TARGET_PATH_INVALID", "Target paths cannot be empty");
    }
    if (raw.startsWith("!")) {
      if (raw.slice(1).trim() === "") {
        throw new AquariusError("TARGET_PATH_INVALID", "Target exclusions cannot be empty");
      }
      negative.push(normalizePattern(config, raw.slice(1)));
      continue;
    }

    const absolute = resolve(config.cwd, raw);
    const targetStats = await tryLstat(absolute);
    if (targetStats) {
      const path = toProjectRelative(config.projectRoot, absolute, targetStats.isDirectory());
      if (await hasSymlinkComponent(config.projectRoot, path)) {
        throw new AquariusError(
          "TARGET_SYMLINK_UNSUPPORTED",
          `Symbolic link targets are not supported: ${raw}`,
        );
      }
      if (targetStats.isFile()) {
        positive.push({ kind: "file", path, raw });
        continue;
      }
      if (targetStats.isDirectory()) {
        positive.push({ kind: "directory", path, raw });
        continue;
      }
      throw new AquariusError(
        "TARGET_PATH_INVALID",
        `Target is not a regular file or directory: ${raw}`,
      );
    }

    if (isDynamicPattern(raw)) {
      positive.push({ kind: "glob", pattern: normalizePattern(config, raw), raw });
      continue;
    }
    positive.push({ kind: "file", path: toProjectRelative(config.projectRoot, absolute), raw });
  }

  if (positive.length === 0) {
    throw new AquariusError("TARGET_PATH_INVALID", "At least one non-exclusion target is required");
  }
  return { positive, negative };
};

export const scopeMatches = (scope: Scope, path: string): boolean => {
  if (scope.kind === "file") return scope.path === path;
  if (scope.kind === "directory") {
    const matchesDirectory =
      scope.path === "" || path === scope.path || path.startsWith(`${scope.path}/`);
    return matchesDirectory;
  }
  return matchesPath(path, scope.pattern);
};

export const matchesFilePatterns = (path: string, patterns: readonly string[]): boolean => {
  let matched = false;
  for (const raw of patterns) {
    const isExclusion = raw.startsWith("!");
    const pattern = isExclusion ? raw.slice(1) : raw;
    if (matchesPath(path, pattern)) matched = !isExclusion;
  }
  return matched;
};

export const matchesPath = (path: string, pattern: string): boolean => {
  const normalizedPattern = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  if (matchesGlob(path, normalizedPattern)) return true;
  // Node's glob matcher does not match dot-prefixed segments with a wildcard.
  return matchesGlob(maskDotSegments(path), normalizedPattern);
};

const maskDotSegments = (path: string): string =>
  path
    .split("/")
    .map((part) => (part.startsWith(".") ? `\0${part.slice(1)}` : part))
    .join("/");

const normalizePattern = (config: LoadedConfig, input: string): string => {
  if (isAbsolute(input)) {
    const absolute = resolve(input);
    if (!isInside(config.projectRoot, absolute)) {
      throw new AquariusError(
        "TARGET_PATH_OUTSIDE_ROOT",
        `Target pattern escapes the project root: ${input}`,
      );
    }
    const projectPath = relative(config.projectRoot, absolute);
    return toPosix(projectPath) || "**/*";
  }

  const normalizedInput = toPosix(input);
  const relativeCwd = toPosix(relative(config.projectRoot, config.cwd));
  const projectPattern = relativeCwd === "" ? normalizedInput : `${relativeCwd}/${normalizedInput}`;
  const normalizedPattern = posix.normalize(projectPattern);
  const escapesProjectRoot =
    normalizedPattern === ".." ||
    normalizedPattern.startsWith("../") ||
    posix.isAbsolute(normalizedPattern);
  if (escapesProjectRoot) {
    throw new AquariusError(
      "TARGET_PATH_OUTSIDE_ROOT",
      `Target pattern escapes the project root: ${input}`,
    );
  }
  const currentDirectoryPrefix = /^\.\//;
  return normalizedPattern.replace(currentDirectoryPrefix, "");
};
