import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { globby } from "globby";
import createIgnore, { type Ignore } from "ignore";
import type { LoadedConfig } from "../config/types";
import { AquariusError, errorMessage, isNodeError } from "../shared/errors";
import { isInside, toPosix } from "../shared/path";
import { tryLstat } from "./paths";
import type { TargetOptions } from "./types";

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

export const vcsIgnoreGlobs = VCS_DIRECTORIES.map((name) => `**/${name}/**`).concat("**/.git");

type IgnoreMatcher = { baseDirectory: string; matcher: Ignore };

export const isInternalPath = (path: string): boolean => {
  const parts = path.toLowerCase().split("/");
  return (
    parts.at(-1) === ".git" || parts.slice(0, -1).some((part) => VCS_DIRECTORIES.includes(part))
  );
};

export const isDefaultIgnored = (path: string, options: TargetOptions): boolean => {
  if (isInternalPath(path)) return true;
  const parts = path.split("/");
  if (!options.withNodeModules && parts.slice(0, -1).includes("node_modules")) return true;
  const name = parts.at(-1)!;
  return LOCK_FILES.has(name) || /[._-]min\./u.test(name);
};

export const createMatcher = (
  baseDirectory: string,
  patterns: readonly string[],
): IgnoreMatcher => ({
  baseDirectory: resolve(baseDirectory),
  matcher: createIgnore().add([...patterns]),
});

export const loadManualIgnores = async (
  config: LoadedConfig,
  options: TargetOptions,
): Promise<IgnoreMatcher[]> => {
  const matchers: IgnoreMatcher[] = [];
  for (const name of options.ignorePaths ?? []) {
    const path = resolve(config.cwd, name);
    const text = await readOptionalFile(path, true);
    if (text !== undefined) {
      matchers.push(createMatcher(await realpath(dirname(path)), splitPatterns(text)));
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
  const info = await tryLstat(dotGit);
  if (!info) return undefined;
  let gitDirectory = dotGit;
  if (info.isFile()) {
    const marker = await readFile(dotGit, "utf8");
    const match = /^gitdir:\s*(.+)\s*$/im.exec(marker);
    if (!match) return undefined;
    gitDirectory = resolve(projectRoot, match[1]);
  }
  const text = await readOptionalFile(join(gitDirectory, "info", "exclude"), false);
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
  const unique = [...new Set(paths)].sort(
    (left, right) => left.split(sep).length - right.split(sep).length,
  );
  const matchers: IgnoreMatcher[] = [];
  for (const path of unique) {
    const info = await lstat(path);
    const projectPath = toPosix(relative(projectRoot, path));
    if (!info.isFile() || isInternalPath(projectPath)) continue;
    if (isIgnoredByMatchers(matchers, projectRoot, projectPath)) continue;
    matchers.push(createMatcher(dirname(path), splitPatterns(await readFile(path, "utf8"))));
  }
  return matchers;
};

const pathFromMatcher = (
  rule: IgnoreMatcher,
  projectRoot: string,
  projectPath: string,
): string | undefined => {
  const absolute = resolve(projectRoot, ...projectPath.split("/"));
  const path = relative(rule.baseDirectory, absolute);
  if (path === "" || !isInside(rule.baseDirectory, absolute)) {
    return undefined;
  }
  return toPosix(path);
};

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
    const result = matcher.matcher.test(relativePath);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
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

const splitPatterns = (text: string): string[] => text.split(/\r\n|\r|\n/);
