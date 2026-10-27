export interface IgnoreRule {
  baseDirectory: string;
  patterns: string[];
}

export interface TargetOptions {
  paths?: string[];
  ignorePaths?: string[];
  ignorePatterns?: string[];
  noIgnore?: boolean;
  withNodeModules?: boolean;
  noErrorOnUnmatchedPattern?: boolean;
}

export interface PathPolicy {
  projectRoot: string;
  targets: string[];
  readableFiles: string[];
  ignoreRules: IgnoreRule[];
  isIgnored: (relativePath: string) => boolean;
  canWrite: (relativePath: string) => boolean;
}
