import type {
  ActiveSeverity,
  AdapterRunInfo,
  AnalysisSnapshot,
  ReviewResponse,
} from "@aquarius/core/runtime";
import type { EvidenceLocation, SourceLocation } from "./schemas";

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

export interface LintFindings {
  diagnostics: Diagnostic[];
}

export type LintResponse = ReviewResponse & LintFindings;

export interface LintResult extends Omit<LintResponse, "retryable"> {
  ai?: AdapterRunInfo;
  summary: LintSummary;
}

export type LintAnalysisSnapshot = AnalysisSnapshot & LintFindings;

export interface LintExecutionResult {
  result: LintResult;
  exitCode: number;
}
