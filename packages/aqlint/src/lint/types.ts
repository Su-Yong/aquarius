import type { ActiveSeverity, RunError, SkippedRule } from "@aquarius/core/internal";
import type { EvidenceLocation, FileResult, SourceLocation } from "./schemas";

export interface Diagnostic {
  rules: { rule: string; severity: ActiveSeverity }[];
  severity: ActiveSeverity;
  message: string;
  locations: SourceLocation[];
  evidence: EvidenceLocation[];
}

export interface LintSummary {
  totalFiles: number | null;
  successFiles: number;
  warningFiles: number;
  skippedFiles: number;
  failedFiles: number;
  activeRules: number;
}

export interface LintResult {
  changedFiles?: string[];
  diagnostics: Diagnostic[];
  errors: RunError[];
  skippedRules: SkippedRule[];
  summary: LintSummary;
  fileResults: FileResult[];
}

export type ReviewStatus = "pending" | "in_progress" | FileResult["status"];

export interface FileReview {
  path: string;
  status: ReviewStatus;
  reason: string;
}

export interface RuleReview {
  ruleId: string;
  status: ReviewStatus;
  reason: string;
}

export interface LintAnalysisSnapshot {
  phase: "provisional" | "final" | "incomplete";
  revision: number;
  diagnostics: readonly Diagnostic[];
  fileResults: readonly FileReview[];
  ruleResults: readonly RuleReview[];
  errors: readonly RunError[];
}

export interface LintExecutionResult {
  result: LintResult;
  exitCode: number;
}
