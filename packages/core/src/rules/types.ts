import type { z } from "zod";
import type { JsonObject, RunError } from "../shared/types";

export type Severity = "off" | "warn" | "error";
export type ActiveSeverity = Exclude<Severity, "off">;
export type RuleScope = "file" | "module" | "project";

export interface LintInstructions {
  applicability: string;
  criteria: string;
  evidenceRequirements: string[];
  exceptions?: string[];
  procedure?: string[];
  examples?: {
    scenario: string;
    expected: "pass" | "violation" | "unknown" | "not_applicable";
    reason: string;
  }[];
}

export interface FormatInstructions {
  applicability: string;
  transformation: string;
  constraints: string[];
  examples?: { before: string; after: string; reason: string }[];
}

export interface RuleBase {
  id: string;
  description: string;
  scope: RuleScope;
  optionsSchema?: z.ZodType;
  defaultOptions?: JsonObject;
}

export interface LintRule extends RuleBase {
  defaultSeverity: ActiveSeverity;
  buildPrompt: (input: { options: Readonly<JsonObject> }) => LintInstructions | Promise<LintInstructions>;
}

export interface FormatRule extends RuleBase {
  buildPrompt: (input: { options: Readonly<JsonObject> }) => FormatInstructions | Promise<FormatInstructions>;
}

export interface RulePlugin {
  namespace: string;
  lintRules?: LintRule[];
  formatRules?: FormatRule[];
}

export interface RuleSelection {
  rule: string;
  severity?: Severity;
  options?: JsonObject;
}

export interface PreparedRule {
  id: string;
  scope: RuleScope;
  severity?: ActiveSeverity;
  instructions: LintInstructions | FormatInstructions;
}

export interface PreparedRules {
  rules: PreparedRule[];
  errors: RunError[];
}
