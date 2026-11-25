import type {
  AdapterRunInfo,
  Analysis,
  AnalysisSnapshot,
  ReviewResponse,
  ToolExecutionOptions,
} from "@aquarius/core/runtime";

import type { FileChange } from "../changes/schema";

import type { FormatWarning } from "./schemas";

export type { FileChange } from "../changes/schema";
export type { FormatWarning } from "./schemas";

export interface FormatDetails {
  changes: FileChange[];
  warnings: FormatWarning[];
}

export type FormatResponse = ReviewResponse & FormatDetails;

export interface FormatSummary {
  totalFiles: number | null;
  completedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  activeRules: number;
}

export interface FormatResult extends Omit<ReviewResponse, "retryable"> {
  ai?: AdapterRunInfo;
  changedFiles: string[];
  proposedFiles: string[];
  wouldChangeFiles?: string[];
  restoredFiles?: string[];
  warnings: FormatWarning[];
  summary: FormatSummary;
}

export interface FormatSnapshotDetails {
  proposedFiles: string[];
  warnings: FormatWarning[];
}

export type FormatAnalysisSnapshot = AnalysisSnapshot & FormatSnapshotDetails;
export type FormatAnalysis = Analysis<FormatSnapshotDetails, FormatResponse>;

export interface FormatExecutionOptions extends ToolExecutionOptions<FormatSnapshotDetails> {
  check?: boolean;
  undo?: boolean;
}

export interface FormatExecutionResult {
  result: FormatResult;
  exitCode: number;
}
