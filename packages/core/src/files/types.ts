export interface TargetOptions {
  paths?: string[];
  ignorePaths?: string[];
  ignorePatterns?: string[];
  withNodeModules?: boolean;
  noErrorOnUnmatchedPattern?: boolean;
}

export interface PathPolicy {
  projectRoot: string;
  targets: string[];
  readableFiles: string[];
  isIgnored: (relativePath: string) => boolean;
  canWrite: (relativePath: string) => boolean;
}
