import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { globby } from "globby";
import createIgnore, { type Ignore } from "ignore";

import { AquariusError, errorMessage, isNodeError } from "../shared/errors";
import { isInside, toPosix } from "../shared/path";
import type { LoadedConfig } from "../config/types";

import { tryLstat } from "./paths";
import type { TargetOptions } from "./types";

interface IgnoreMatcher {
  baseDirectory: string;
  matcher: Ignore;
}

const VCS_DIRECTORIES = [".git", ".svn", ".hg", ".jj"];
const LOCK_FILES = new Set([
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const MINIFIED_FILE_PATTERN = /[._-]min\./u;
const GIT_DIRECTORY_MARKER_PATTERN = /^gitdir:\s*(.+)\s*$/im;
const LINE_BREAK_PATTERN = /\r\n|\r|\n/;

export const vcsIgnoreGlobs = VCS_DIRECTORIES.map((name) => `**/${name}/**`).concat("**/.git");

export const isDefaultIgnored = (path: string, options: TargetOptions): boolean => {
  if (isInternalPath(path)) return true;
  const parts = path.split("/");
  if (!options.withNodeModules && parts.slice(0, -1).includes("node_modules")) return true;
  const fileName = parts.at(-1)!;
  return LOCK_FILES.has(fileName) || MINIFIED_FILE_PATTERN.test(fileName);
};

export const loadManualIgnores = async (
  config: LoadedConfig,
  options: TargetOptions,
): Promise<IgnoreMatcher[]> => {
  const matchers: IgnoreMatcher[] = [];

  for (const ignorePath of options.ignorePaths ?? []) {
    const path = resolve(config.cwd, ignorePath);
    const text = await readOptionalFile(path, true);
    if (text !== undefined) {
      const baseDirectory = await realpath(dirname(path));
      const patterns = splitPatterns(text);
      matchers.push(createMatcher(baseDirectory, patterns));
    }
  }

  if (options.ignorePatterns?.length) {
    matchers.push(createMatcher(config.cwd, options.ignorePatterns));
  }

  return matchers;
};

export const loadGitInfoExclude = async (
  projectRoot: string,
): Promise<IgnoreMatcher | undefined> => {
  const dotGit = join(projectRoot, ".git");
  const dotGitStats = await tryLstat(dotGit);
  if (!dotGitStats) return undefined;

  const gitDirectory = dotGitStats.isFile()
    ? resolveGitDirectory(projectRoot, await readFile(dotGit, "utf8"))
    : dotGit;
  if (gitDirectory === undefined) return undefined;

  const excludePath = join(gitDirectory, "info", "exclude");
  const text = await readOptionalFile(excludePath, false);
  return text === undefined ? undefined : createMatcher(projectRoot, splitPatterns(text));
};

export const loadGitignoreMatchers = async (projectRoot: string): Promise<IgnoreMatcher[]> => {
  const paths = await globby("**/.gitignore", {
    cwd: projectRoot,
    absolute: true,
    dot: true,
    followSymbolicLinks: false,
    gitignore: false,
    ignore: vcsIgnoreGlobs,
    onlyFiles: true,
  });
  const rootIgnore = join(projectRoot, ".gitignore");
  if (await tryLstat(rootIgnore)) paths.push(rootIgnore);

  const uniqueIgnorePaths = [...new Set(paths)].sort(
    (left, right) => left.split(sep).length - right.split(sep).length,
  );

  const matchers: IgnoreMatcher[] = [];
  for (const path of uniqueIgnorePaths) {
    const ignoreFileStats = await lstat(path);
    const projectPath = toPosix(relative(projectRoot, path));
    if (!ignoreFileStats.isFile() || isInternalPath(projectPath)) continue;
    if (isIgnoredByMatchers(matchers, projectRoot, projectPath)) continue;

    const baseDirectory = dirname(path);
    const ignoreText = await readFile(path, "utf8");
    const patterns = splitPatterns(ignoreText);
    matchers.push(createMatcher(baseDirectory, patterns));
  }

  return matchers;
};

export const isInternalPath = (path: string): boolean => {
  const parts = path.toLowerCase().split("/");
  return (
    parts.at(-1) === ".git" || parts.slice(0, -1).some((part) => VCS_DIRECTORIES.includes(part))
  );
};

export const createMatcher = (
  baseDirectory: string,
  patterns: readonly string[],
): IgnoreMatcher => ({
  baseDirectory: resolve(baseDirectory),
  matcher: createIgnore().add([...patterns]),
});

export const matchesIgnore = (rule: IgnoreMatcher, projectRoot: string, path: string): boolean => {
  const relativePath = pathFromMatcher(rule, projectRoot, path);
  return relativePath !== undefined && rule.matcher.ignores(relativePath);
};

export const isIgnoredByMatchers = (
  matchers: readonly IgnoreMatcher[],
  projectRoot: string,
  path: string,
): boolean => {
  let ignored = false;

  for (const matcher of matchers) {
    const relativePath = pathFromMatcher(matcher, projectRoot, path);
    if (relativePath === undefined) continue;
    const ignoreTest = matcher.matcher.test(relativePath);
    if (ignoreTest.ignored) ignored = true;
    else if (ignoreTest.unignored) ignored = false;
  }

  return ignored;
};

const resolveGitDirectory = (projectRoot: string, marker: string): string | undefined => {
  const match = GIT_DIRECTORY_MARKER_PATTERN.exec(marker);
  return match ? resolve(projectRoot, match[1]) : undefined;
};

const pathFromMatcher = (
  rule: IgnoreMatcher,
  projectRoot: string,
  projectPath: string,
): string | undefined => {
  const pathSegments = projectPath.split("/");
  const absolute = resolve(projectRoot, ...pathSegments);
  const path = relative(rule.baseDirectory, absolute);

  if (path === "" || !isInside(rule.baseDirectory, absolute)) {
    return undefined;
  }

  return toPosix(path);
};

const readOptionalFile = async (path: string, required: boolean): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (!required && isNodeError(error, "ENOENT")) return undefined;
    throw new AquariusError(
      "IGNORE_FILE_FAILED",
      `Cannot read ignore file ${path}: ${errorMessage(error)}`,
    );
  }
};

const splitPatterns = (text: string): string[] => text.split(LINE_BREAK_PATTERN);
