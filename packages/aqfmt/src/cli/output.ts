import type { FormatExecutionResult, FormatResult } from "../format/types";

export const safeText = (value: string): string => (
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
);

export const printHuman = (execution: FormatExecutionResult, check: boolean): void => {
  const result: FormatResult = execution.result;
  for (const file of check ? result.wouldChangeFiles ?? [] : result.changedFiles) {
    console.log(safeText(`${check ? "Would format" : "Formatted"} ${file}`));
  }
  for (const file of result.restoredFiles ?? []) console.log(safeText(`Restored ${file}`));
  for (const warning of result.warnings) {
    console.error(safeText(`warn ${warning.code} [${warning.ruleIds.join(", ")}]: ${warning.message}`));
    for (const path of warning.paths) console.error(safeText(`  at ${path}`));
  }
  for (const error of result.errors) {
    const rules = error.ruleIds.length ? ` [${error.ruleIds.join(", ")}]` : "";
    console.error(safeText(`error ${error.code}${rules}: ${error.message}`));
  }
};
