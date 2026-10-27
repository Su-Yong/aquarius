import type { RunError, TargetOptions } from "@aquarius/core/internal";
import type { FileChange, FormatWarning } from "./schemas";

export type { FileChange, FormatWarning } from "./schemas";

export interface FormatResponse {
  changes: FileChange[];
  warnings: FormatWarning[];
  errors: RunError[];
}

export interface FormatResult {
  changedFiles: string[];
  wouldChangeFiles?: string[];
  restoredFiles?: string[];
  warnings: FormatWarning[];
  errors: RunError[];
}

export interface FormatExecutionOptions extends TargetOptions {
  cwd: string;
  configPath?: string;
  check?: boolean;
  undo?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface FormatExecutionResult {
  result: FormatResult;
  exitCode: number;
}

