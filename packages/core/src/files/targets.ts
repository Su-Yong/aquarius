import { lstat, readFile, realpath } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, matchesGlob, posix, relative, resolve, sep } from "node:path";
import { globby, isDynamicPattern } from "globby";
import createIgnore, { type Ignore } from "ignore";
import { AquariusError } from "../shared/errors";
import type { IgnoreRule, PathPolicy, TargetOptions } from "./types";
import type { LoadedConfig } from "../config/types";

const FORMAT_VCS_DIRECTORIES = new Set([".git", ".svn", ".jj"]);
const CONTEXT_VCS_DIRECTORIES = new Set([".git", ".svn", ".hg", ".jj"]);
const LOCK_FILES = new Set([
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

type IgnoreMatcher = { baseDirectory: string; patterns: string[]; matcher: Ignore };
type Scope =
  | { kind: "file"; path: string; raw: string }
  | { kind: "directory"; path: string; raw: string }
  | { kind: "glob"; pattern: string; raw: string };

export const selectTargets = async (config: LoadedConfig, options: TargetOptions = {}): Promise<PathPolicy> => {
  const projectRoot = await realpath(config.projectRoot);
  const configIgnore = createMatcher(config.configDirectory, config.ignore);
  const ignoreRules: IgnoreRule[] = config.ignore.length === 0
    ? []
    : [{ baseDirectory: config.configDirectory, patterns: [...config.ignore] }];
  const manualIgnores = await loadManualIgnores(config, options);
  const gitInfoIgnore = config.tool === "format" ? await loadGitInfoExclude(projectRoot) : undefined;
  const gitIgnoreMatchers = await loadGitignoreMatchers(projectRoot);

  const allFiles = await discoverFiles(projectRoot);
  const gitDiscovered = new Set(allFiles.filter((path) => !isIgnoredByMatchers(gitIgnoreMatchers, projectRoot, path)));
  const regularFiles = new Set<string>();
  for (const path of allFiles) {
    if (await isRegularPath(projectRoot, path)) regularFiles.add(path);
  }

  const readableFiles = [...regularFiles]
    .filter((path) => !hasDirectory(path, CONTEXT_VCS_DIRECTORIES))
    .filter((path) => !matchesIgnore(configIgnore, projectRoot, path))
    .sort();

  const { positive, negative } = await createScopes(config, options);
  const selected = new Set<string>();
  const unmatched: string[] = [];

  for (const scope of positive) {
    const candidates = candidatesForScope(scope, regularFiles, gitDiscovered);
    let count = 0;
    for (const path of candidates) {
      if (!isAllowedTarget(path, scope, config, options, configIgnore, manualIgnores, gitInfoIgnore)) continue;
      if (negative.some((pattern) => matchesPath(path, pattern))) continue;
      selected.add(path);
      count += 1;
    }
    if (count === 0) unmatched.push(scope.raw);
  }

  if (unmatched.length > 0 && !options.noErrorOnUnmatchedPattern) {
    throw new AquariusError("TARGET_UNMATCHED", `No files matched: ${unmatched.join(", ")}`);
  }

  const canWrite = (relativePath: string): boolean => {
    const path = safeRelativePath(relativePath);
    if (!path || hasSymlinkComponentSync(projectRoot, path)) return false;
    if (!matchesFilePatterns(path, config.files)) return false;
    if (matchesIgnore(configIgnore, projectRoot, path)) return false;
    if (isIgnoredByMatchers(manualIgnores, projectRoot, path)) return false;
    if (isToolDefaultIgnored(path, config.tool, options)) return false;
    if (negative.some((pattern) => matchesPath(path, pattern))) return false;

    const matchingScopes = positive.filter((scope) => scopeMatches(scope, path));
    if (matchingScopes.length === 0) return false;
    const explicit = matchingScopes.some((scope) => scope.kind === "file");
    if (!explicit && isIgnoredByMatchers(gitIgnoreMatchers, projectRoot, path)) return false;
    if (!explicit && gitInfoIgnore && matchesIgnore(gitInfoIgnore, projectRoot, path)) return false;
    return true;
  };

  return {
    projectRoot,
    targets: [...selected].sort(),
    readableFiles,
    ignoreRules,
    isIgnored: (relativePath) => {
      const path = safeRelativePath(relativePath);
      return !path || matchesIgnore(configIgnore, projectRoot, path);
    },
    canWrite,
  };
};

const createScopes = async (
  config: LoadedConfig,
  options: TargetOptions,
): Promise<{ positive: Scope[]; negative: string[] }> => {
  const cwdFromRoot = relative(config.projectRoot, config.cwd);
  const defaultTarget = cwdFromRoot === ".." || cwdFromRoot.startsWith(`..${sep}`) || isAbsolute(cwdFromRoot)
    ? config.projectRoot
    : config.cwd;
  const inputs = options.paths && options.paths.length > 0 ? options.paths : [defaultTarget];
  const positive: Scope[] = [];
  const negative: string[] = [];

  for (const raw of inputs) {
    if (raw.trim() === "") throw new AquariusError("TARGET_PATH_INVALID", "Target paths cannot be empty");
    if (raw.startsWith("!")) {
      if (config.tool !== "format") {
        throw new AquariusError("TARGET_PATH_INVALID", `aqlint does not accept exclusion paths: ${raw}`);
      }
      negative.push(normalizePattern(config, raw.slice(1)));
      continue;
    }

    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(config.cwd, raw);
    const info = await tryLstat(absolute);
    if (info) {
      const path = toProjectRelative(config.projectRoot, absolute, info.isDirectory());
      if (await hasSymlinkComponent(config.projectRoot, path)) {
        throw new AquariusError("TARGET_SYMLINK_UNSUPPORTED", `Symbolic link targets are not supported: ${raw}`);
      }
      if (info.isFile()) positive.push({ kind: "file", path, raw });
      else if (info.isDirectory()) positive.push({ kind: "directory", path, raw });
      else throw new AquariusError("TARGET_PATH_INVALID", `Target is not a regular file or directory: ${raw}`);
      continue;
    }

    if (config.tool === "format" && isDynamicPattern(raw)) {
      positive.push({ kind: "glob", pattern: normalizePattern(config, raw), raw });
      continue;
    }
    if (config.tool === "lint" && isDynamicPattern(raw)) {
      throw new AquariusError("TARGET_PATH_INVALID", `aqlint does not accept glob targets: ${raw}`);
    }
    positive.push({ kind: "file", path: toProjectRelative(config.projectRoot, absolute), raw });
  }

  if (positive.length === 0) {
    throw new AquariusError("TARGET_PATH_INVALID", "At least one non-exclusion target is required");
  }
  return { positive, negative };
};

const candidatesForScope = (scope: Scope, allFiles: Set<string>, gitDiscovered: Set<string>): string[] => {
  if (scope.kind === "file") return allFiles.has(scope.path) ? [scope.path] : [];
  const source = gitDiscovered;
  if (scope.kind === "directory") {
    return [...source].filter((path) => isAtOrBelow(path, scope.path));
  }
  return [...source].filter((path) => matchesPath(path, scope.pattern));
};

const isAllowedTarget = (
  path: string,
  scope: Scope,
  config: LoadedConfig,
  options: TargetOptions,
  configIgnore: IgnoreMatcher,
  manualIgnores: IgnoreMatcher[],
  gitInfoIgnore: IgnoreMatcher | undefined,
): boolean => {
  if (!matchesFilePatterns(path, config.files)) return false;
  if (matchesIgnore(configIgnore, config.projectRoot, path)) return false;
  if (isIgnoredByMatchers(manualIgnores, config.projectRoot, path)) return false;
  if (isToolDefaultIgnored(path, config.tool, options)) return false;
  if (scope.kind !== "file" && gitInfoIgnore && matchesIgnore(gitInfoIgnore, config.projectRoot, path)) return false;
  return true;
};

const loadManualIgnores = async (config: LoadedConfig, options: TargetOptions): Promise<IgnoreMatcher[]> => {
  if (config.tool === "lint" && options.noIgnore) return [];
  const names = options.ignorePaths && options.ignorePaths.length > 0
    ? options.ignorePaths
    : [config.tool === "lint" ? ".eslintignore" : ".prettierignore"];
  const matchers: IgnoreMatcher[] = [];

  for (const name of names) {
    const explicit = Boolean(options.ignorePaths?.includes(name));
    const path = isAbsolute(name) ? name : resolve(config.cwd, name);
    const text = await readOptionalFile(path, explicit);
    if (text !== undefined) matchers.push(createMatcher(dirname(path), splitPatterns(text)));
  }
  if (config.tool === "lint" && options.ignorePatterns && options.ignorePatterns.length > 0) {
    matchers.push(createMatcher(config.cwd, options.ignorePatterns));
  }
  return matchers;
};

const loadGitInfoExclude = async (projectRoot: string): Promise<IgnoreMatcher | undefined> => {
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

const loadGitignoreMatchers = async (projectRoot: string): Promise<IgnoreMatcher[]> => {
  const paths = await globby("**/.gitignore", {
    cwd: projectRoot,
    absolute: true,
    dot: true,
    followSymbolicLinks: false,
    gitignore: false,
    ignore: ["**/.git/**"],
    onlyFiles: true,
  });
  const rootIgnore = join(projectRoot, ".gitignore");
  if (await tryLstat(rootIgnore)) paths.push(rootIgnore);
  const unique = [...new Set(paths)].sort((left, right) => left.split(sep).length - right.split(sep).length);
  const matchers: IgnoreMatcher[] = [];
  for (const path of unique) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    const projectPath = toPosix(relative(projectRoot, path));
    if (isIgnoredByMatchers(matchers, projectRoot, projectPath)) continue;
    matchers.push(createMatcher(dirname(path), splitPatterns(await readFile(path, "utf8"))));
  }
  return matchers;
};

const discoverFiles = async (projectRoot: string): Promise<string[]> => {
  try {
    return await globby("**/*", {
      cwd: projectRoot,
      absolute: false,
      dot: true,
      followSymbolicLinks: false,
      gitignore: false,
      ignore: ["**/.git", "**/.git/**"],
      onlyFiles: true,
      unique: true,
    });
  } catch (error) {
    throw new AquariusError("TARGET_DISCOVERY_FAILED", `Cannot discover project files: ${errorMessage(error)}`);
  }
};

const createMatcher = (baseDirectory: string, patterns: string[]): IgnoreMatcher => {
  return { baseDirectory: resolve(baseDirectory), patterns: [...patterns], matcher: createIgnore().add(patterns) };
};

const matchesIgnore = (rule: IgnoreMatcher, projectRoot: string, projectPath: string): boolean => {
  const absolute = resolve(projectRoot, ...projectPath.split("/"));
  const relativePath = relative(rule.baseDirectory, absolute);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return false;
  }
  return rule.matcher.ignores(toPosix(relativePath));
};

const isIgnoredByMatchers = (matchers: IgnoreMatcher[], projectRoot: string, path: string): boolean => {
  let ignored = false;
  for (const matcher of matchers) {
    const absolute = resolve(projectRoot, ...path.split("/"));
    const relativePath = relative(matcher.baseDirectory, absolute);
    if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) continue;
    const result = matcher.matcher.test(toPosix(relativePath));
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
};

const matchesFilePatterns = (path: string, patterns: string[]): boolean => {
  let matched = false;
  for (const raw of patterns) {
    const negative = raw.startsWith("!");
    const pattern = negative ? raw.slice(1) : raw;
    if (matchesPath(path, pattern)) matched = !negative;
  }
  return matched;
};

const matchesPath = (path: string, pattern: string): boolean => {
  const normalizedPattern = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  if (matchesGlob(path, normalizedPattern)) return true;
  return matchesGlob(maskDotSegments(path), normalizedPattern);
};

const maskDotSegments = (path: string): string => {
  return path.split("/").map((part) => part.startsWith(".") ? `\0${part.slice(1)}` : part).join("/");
};

const isToolDefaultIgnored = (path: string, tool: LoadedConfig["tool"], options: TargetOptions): boolean => {
  const parts = path.split("/");
  const name = parts.at(-1)!;
  if (tool === "lint") {
    return parts.includes(".git") || name.includes(".min.") || name.includes("-min.") || name.includes("_min.");
  }
  if (hasDirectory(path, FORMAT_VCS_DIRECTORIES)) return true;
  if (!options.withNodeModules && parts.includes("node_modules")) return true;
  return LOCK_FILES.has(name);
};

const scopeMatches = (scope: Scope, path: string): boolean => {
  if (scope.kind === "file") return scope.path === path;
  if (scope.kind === "directory") return isAtOrBelow(path, scope.path);
  return matchesPath(path, scope.pattern);
};

const isAtOrBelow = (path: string, directory: string): boolean => {
  return directory === "" || path === directory || path.startsWith(`${directory}/`);
};

const hasDirectory = (path: string, directories: Set<string>): boolean => {
  return path.split("/").slice(0, -1).some((part) => directories.has(part));
};

const normalizePattern = (config: LoadedConfig, input: string): string => {
  const normalized = toPosix(input);
  if (isAbsolute(input)) {
    const root = toPosix(resolve(config.projectRoot));
    const absolute = toPosix(resolve(input));
    if (absolute === root) return "**/*";
    if (!absolute.startsWith(`${root}/`)) {
      throw new AquariusError("TARGET_PATH_OUTSIDE_ROOT", `Target pattern escapes the project root: ${input}`);
    }
    return absolute.slice(root.length + 1);
  }
  const cwd = toPosix(relative(config.projectRoot, config.cwd));
  const combined = posix.normalize(cwd === "" ? normalized : `${cwd}/${normalized}`);
  if (combined === ".." || combined.startsWith("../")) {
    throw new AquariusError("TARGET_PATH_OUTSIDE_ROOT", `Target pattern escapes the project root: ${input}`);
  }
  return combined.replace(/^\.\//, "");
};

const toProjectRelative = (projectRoot: string, absolute: string, allowRoot = false): string => {
  const value = relative(projectRoot, absolute);
  if ((!allowRoot && value === "") || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new AquariusError("TARGET_PATH_OUTSIDE_ROOT", `Target escapes the project root: ${absolute}`);
  }
  return toPosix(value);
};

const safeRelativePath = (value: string): string | undefined => {
  if (value === "" || isAbsolute(value)) return undefined;
  const path = toPosix(value).replace(/^\.\//, "");
  if (path === "" || path === "." || path.split("/").includes("..")) return undefined;
  return path;
};

const isRegularPath = async (projectRoot: string, path: string): Promise<boolean> => {
  try {
    const info = await lstat(resolve(projectRoot, ...path.split("/")));
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
};

const hasSymlinkComponent = async (projectRoot: string, path: string): Promise<boolean> => {
  let current = projectRoot;
  for (const part of path.split("/")) {
    current = join(current, part);
    const info = await tryLstat(current);
    if (!info) return false;
    if (info.isSymbolicLink()) return true;
  }
  return false;
};

const hasSymlinkComponentSync = (projectRoot: string, path: string): boolean => {
  let current = projectRoot;
  for (const part of path.split("/")) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      return true;
    }
  }
  return false;
};

const tryLstat = async (path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> => {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
};

const readOptionalFile = async (path: string, required: boolean): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (!required && isNodeError(error, "ENOENT")) return undefined;
    throw new AquariusError("IGNORE_FILE_FAILED", `Cannot read ignore file ${path}: ${errorMessage(error)}`);
  }
};

const splitPatterns = (text: string): string[] => {
  return text.split(/\r\n|\r|\n/);
};

const toPosix = (path: string): string => {
  return path.replaceAll("\\", "/");
};

const isNodeError = (error: unknown, code: string): boolean => {
  return error instanceof Error && "code" in error && error.code === code;
};

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};
