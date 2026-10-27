import type { LintExecutionResult, LintResult } from "../lint/types";

export const safeText = (value: string): string =>
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");

export const printHuman = (execution: LintExecutionResult): void => {
  const result = execution.result as LintResult;
  for (const path of result.changedFiles ?? []) {
    console.log(safeText(`updated ${path}`));
  }
  for (const diagnostic of result.diagnostics) {
    const [location, ...additionalLocations] = diagnostic.locations;
    const rules = diagnostic.rules.map(({ rule, severity }) => `${rule}:${severity}`).join(", ");
    console.log(safeText(`${location!.path}:${location!.line}:${location!.column} ${diagnostic.severity} [${rules}] ${diagnostic.message}`));
    for (const additional of additionalLocations) {
      console.log(safeText(`  at ${additional.path}:${additional.line}:${additional.column}`));
    }
    for (const evidence of diagnostic.evidence) {
      console.log(safeText(`  evidence ${evidence.path}:${evidence.line}: ${evidence.message}`));
    }
  }
  for (const finding of result.unknowns) {
    const [location, ...additionalLocations] = finding.locations;
    console.log(safeText(`${location ? `${location.path}:${location.line}:${location.column} ` : ""}unknown [${finding.ruleIds.join(", ")}] ${finding.message}`));
    for (const additional of additionalLocations) {
      console.log(safeText(`  at ${additional.path}:${additional.line}:${additional.column}`));
    }
  }
  for (const error of result.errors) {
    const rules = error.ruleIds.length ? ` [${error.ruleIds.join(", ")}]` : "";
    console.error(safeText(`error ${error.code}${rules}: ${error.message}`));
  }
};
