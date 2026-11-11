import type { RunError, SkippedRule, TargetOptions } from "@aquarius/core/internal";
import type { FileChange, FormatFileResult, FormatWarning } from "./schemas";

export type { FileChange, FormatFileResult, FormatWarning } from "./schemas";

export interface FormatResponse {
  changes: FileChange[];
  warnings: FormatWarning[];
  errors: RunError[];
  skippedRules: SkippedRule[];
  fileResults: FormatFileResult[];
  retryable: boolean;
}

export interface FormatSummary {
  totalFiles: number | null;
  completedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  activeRules: number;
}

export interface FormatResult {
  changedFiles: string[];
  proposedFiles: string[];
  wouldChangeFiles?: string[];
  restoredFiles?: string[];
  warnings: FormatWarning[];
  errors: RunError[];
  skippedRules: SkippedRule[];
  summary: FormatSummary;
  fileResults: FormatFileResult[];
}

export type FormatReviewStatus = "pending" | "in_progress" | FormatFileResult["status"];

export interface FormatFileReview {
  path: string;
  status: FormatReviewStatus;
  reason: string;
}

export interface FormatRuleReview {
  ruleId: string;
  status: FormatReviewStatus;
  reason: string;
}

export interface FormatAnalysisSnapshot {
  phase: "provisional" | "final" | "incomplete";
  revision: number;
  fileResults: readonly FormatFileReview[];
  ruleResults: readonly FormatRuleReview[];
  proposedFiles: readonly string[];
  warnings: readonly FormatWarning[];
  errors: readonly RunError[];
}

export interface FormatAnalysis {
  update: (raw: unknown) => void;
  flush: () => Promise<void>;
  finish: (response: FormatResponse) => Promise<FormatAnalysisSnapshot>;
  interrupt: (errors?: readonly RunError[]) => Promise<FormatAnalysisSnapshot>;
}

export interface FormatExecutionOptions extends TargetOptions {
  cwd: string;
  configPath?: string;
  check?: boolean;
  undo?: boolean;
  fileBatchSize?: number;
  maxConcurrency?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onWarning?: (message: string) => void;
  onAnalysisUpdate?: (snapshot: FormatAnalysisSnapshot) => void;
}

export interface FormatExecutionResult {
  result: FormatResult;
  exitCode: number;
}
