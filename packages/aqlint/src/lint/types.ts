import type { ActiveSeverity, RunError } from "@aquarius/core/internal";
import type { EvidenceLocation, SourceLocation, UnknownFinding } from "./schemas";

export interface Diagnostic {
  rules: { rule: string; severity: ActiveSeverity }[];
  severity: ActiveSeverity;
  message: string;
  locations: SourceLocation[];
  evidence: EvidenceLocation[];
}

export interface LintResult {
  changedFiles?: string[];
  diagnostics: Diagnostic[];
  unknowns: UnknownFinding[];
  errors: RunError[];
}

export interface LintExecutionResult {
  result: LintResult;
  exitCode: number;
}
