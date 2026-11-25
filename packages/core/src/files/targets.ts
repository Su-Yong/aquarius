import { realpath } from "node:fs/promises";
import { globby } from "globby";
import type { LoadedConfig } from "../config/types";
import { AquariusError, errorMessage } from "../shared/errors";
import { safeRelativePath } from "../shared/path";
import {
  createMatcher,
  isDefaultIgnored,
  isIgnoredByMatchers,
  isInternalPath,
  loadGitignoreMatchers,
  loadGitInfoExclude,
  loadManualIgnores,
  matchesIgnore,
  vcsIgnoreGlobs,
} from "./ignores";
import { hasSymlinkComponentSync, isRegularPath } from "./paths";
import { createScopes, matchesFilePatterns, matchesPath, scopeMatches } from "./scopes";
import type { PathPolicy, TargetOptions } from "./types";

export const selectTargets = async (
  config: LoadedConfig,
  options: TargetOptions = {},
): Promise<PathPolicy> => {
  const projectRoot = await realpath(config.projectRoot);
  const configIgnore = createMatcher(config.configDirectory, config.ignore);
  const { positive, negative } = await createScopes(config, options);
  const [manualIgnores, gitInfoIgnore, gitIgnoreMatchers, allFiles] = await Promise.all([
    loadManualIgnores(config, options),
    loadGitInfoExclude(projectRoot),
    loadGitignoreMatchers(projectRoot),
    discoverFiles(projectRoot),
  ]);

  const isIgnored = (path: string): boolean => !safeRelativePath(path) || isInternalPath(path);
  const isTargetPath = (path: string): boolean =>
    !isDefaultIgnored(path, options) &&
    matchesFilePatterns(path, config.files) &&
    !matchesIgnore(configIgnore, projectRoot, path) &&
    !isIgnoredByMatchers(manualIgnores, projectRoot, path) &&
    !negative.some((pattern) => matchesPath(path, pattern));
  const isGitIgnored = (path: string): boolean =>
    isIgnoredByMatchers(gitIgnoreMatchers, projectRoot, path) ||
    (gitInfoIgnore !== undefined && matchesIgnore(gitInfoIgnore, projectRoot, path));

  const readableFiles: string[] = [];
  for (const path of allFiles) {
    if (!isIgnored(path) && (await isRegularPath(projectRoot, path))) readableFiles.push(path);
  }
  const candidates = readableFiles.filter(isTargetPath);
  const gitDiscovered = candidates.filter((path) => !isGitIgnored(path));
  const selected = new Set<string>();
  const unmatched: string[] = [];

  for (const scope of positive) {
    const paths = scope.kind === "file" ? candidates : gitDiscovered;
    const matched = paths.filter((path) => scopeMatches(scope, path));
    for (const path of matched) selected.add(path);
    if (matched.length === 0) unmatched.push(scope.raw);
  }

  if (unmatched.length > 0 && !options.noErrorOnUnmatchedPattern) {
    throw new AquariusError("TARGET_UNMATCHED", `No files matched: ${unmatched.join(", ")}`);
  }

  const canWrite = (path: string): boolean => {
    if (isIgnored(path) || hasSymlinkComponentSync(projectRoot, path) || !isTargetPath(path)) {
      return false;
    }
    const matchingScopes = positive.filter((scope) => scopeMatches(scope, path));
    return (
      matchingScopes.length > 0 &&
      (matchingScopes.some((scope) => scope.kind === "file") || !isGitIgnored(path))
    );
  };

  return {
    projectRoot,
    targets: [...selected].sort(),
    readableFiles: readableFiles.sort(),
    isIgnored,
    canWrite,
  };
};

const discoverFiles = async (projectRoot: string): Promise<string[]> => {
  try {
    return await globby("**/*", {
      cwd: projectRoot,
      dot: true,
      followSymbolicLinks: false,
      gitignore: false,
      ignore: vcsIgnoreGlobs,
      onlyFiles: true,
    });
  } catch (error) {
    throw new AquariusError(
      "TARGET_DISCOVERY_FAILED",
      `Cannot discover project files: ${errorMessage(error)}`,
    );
  }
};
