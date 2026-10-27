import { statusText, terminalColors } from "@aquarius/core/internal";
import type { LintExecutionResult, LintResult } from "../lint/types";

export const safeText = (value: string): string =>
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");

export const printHuman = (execution: LintExecutionResult): void => {
  const result = execution.result as LintResult;
  const color = terminalColors(process.stdout);
  const errorColor = terminalColors(process.stderr);
  const locationText = (location: { path: string; line: number; column?: number }) =>
    color.cyan(safeText(`${location.path}:${location.line}${location.column === undefined ? "" : `:${location.column}`}`));
  if (process.stdout.isTTY && execution.exitCode === 0 && !result.changedFiles?.length && !result.diagnostics.length && !result.unknowns.length && !result.errors.length) {
    console.log(statusText("Lint complete", "success", process.stdout));
  }
  for (const path of result.changedFiles ?? []) {
    console.log(statusText(safeText(`updated ${path}`), "success", process.stdout));
  }
  for (const diagnostic of result.diagnostics) {
    const [location, ...additionalLocations] = diagnostic.locations;
    const rules = diagnostic.rules.map(({ rule, severity }) => `${safeText(rule)}:${severity}`).join(", ");
    const severity = diagnostic.severity === "error" ? color.red : color.yellow;
    console.log(statusText(`${locationText(location!)} ${severity(diagnostic.severity)} ${color.magenta(`[${rules}]`)} ${color.bold(safeText(diagnostic.message))}`, diagnostic.severity === "error" ? "error" : "warning", process.stdout));
    for (const additional of additionalLocations) {
      console.log(`  ${color.dim("at")} ${locationText(additional)}`);
    }
    for (const evidence of diagnostic.evidence) {
      console.log(`  ${color.dim("evidence")} ${locationText(evidence)}: ${color.dim(safeText(evidence.message))}`);
    }
  }
  for (const finding of result.unknowns) {
    const [location, ...additionalLocations] = finding.locations;
    console.log(statusText(`${location ? `${locationText(location)} ` : ""}${color.yellow("unknown")} ${color.magenta(`[${safeText(finding.ruleIds.join(", "))}]`)} ${color.bold(safeText(finding.message))}`, "warning", process.stdout));
    for (const additional of additionalLocations) {
      console.log(`  ${color.dim("at")} ${locationText(additional)}`);
    }
  }
  for (const error of result.errors) {
    const rules = error.ruleIds.length ? ` ${errorColor.magenta(`[${safeText(error.ruleIds.join(", "))}]`)}` : "";
    console.error(statusText(`${errorColor.red("error")} ${errorColor.red(safeText(error.code))}${rules}: ${errorColor.bold(safeText(error.message))}`, "error", process.stderr));
  }
};
