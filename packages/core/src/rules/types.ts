import type { z } from "zod";
import type { JsonObject, RunError } from "../shared/types";

export type Severity = "off" | "warn" | "error";
export type ActiveSeverity = Exclude<Severity, "off">;
export type RuleScope = "file" | "module" | "project";
export type LintRuleSetting = Severity | [Severity, JsonObject];
export type FormatRuleSetting = boolean | JsonObject;
export type RuleSetting = LintRuleSetting | FormatRuleSetting;
export type RuleSettings = Record<string, RuleSetting>;

export interface LintInstructions {
  applicability: string;
  criteria: string;
  evidenceRequirements: string[];
  exceptions?: string[];
  procedure?: string[];
  examples?: {
    scenario: string;
    expected: "pass" | "violation" | "not_applicable";
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
}

export interface LintRule extends RuleBase {
  buildPrompt: (input: {
    options: Readonly<JsonObject>;
  }) => LintInstructions | Promise<LintInstructions>;
}

export interface FormatRule extends RuleBase {
  buildPrompt: (input: {
    options: Readonly<JsonObject>;
  }) => FormatInstructions | Promise<FormatInstructions>;
}

export interface RulePlugin {
  namespace: string;
  lintRules?: LintRule[];
  formatRules?: FormatRule[];
  presets?: Record<string, RuleSettings>;
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
