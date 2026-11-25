import { isAbsolute, matchesGlob, posix, relative, resolve } from "node:path";
import { isDynamicPattern } from "globby";
import type { LoadedConfig } from "../config/types";
import { AquariusError } from "../shared/errors";
import { isInside, toPosix } from "../shared/path";
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
    const info = await tryLstat(absolute);
    if (info) {
      const path = toProjectRelative(config.projectRoot, absolute, info.isDirectory());
      if (await hasSymlinkComponent(config.projectRoot, path)) {
        throw new AquariusError(
          "TARGET_SYMLINK_UNSUPPORTED",
          `Symbolic link targets are not supported: ${raw}`,
        );
      }
      if (info.isFile()) positive.push({ kind: "file", path, raw });
      else if (info.isDirectory()) positive.push({ kind: "directory", path, raw });
      else {
        throw new AquariusError(
          "TARGET_PATH_INVALID",
          `Target is not a regular file or directory: ${raw}`,
        );
      }
      continue;
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
    return scope.path === "" || path === scope.path || path.startsWith(`${scope.path}/`);
  }
  return matchesPath(path, scope.pattern);
};

export const matchesFilePatterns = (path: string, patterns: readonly string[]): boolean => {
  let matched = false;
  for (const raw of patterns) {
    const negative = raw.startsWith("!");
    const pattern = negative ? raw.slice(1) : raw;
    if (matchesPath(path, pattern)) matched = !negative;
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
    return toPosix(relative(config.projectRoot, absolute)) || "**/*";
  }

  const normalized = toPosix(input);
  const cwd = toPosix(relative(config.projectRoot, config.cwd));
  const combined = posix.normalize(cwd === "" ? normalized : `${cwd}/${normalized}`);
  if (combined === ".." || combined.startsWith("../") || posix.isAbsolute(combined)) {
    throw new AquariusError(
      "TARGET_PATH_OUTSIDE_ROOT",
      `Target pattern escapes the project root: ${input}`,
    );
  }
  return combined.replace(/^\.\//, "");
};
