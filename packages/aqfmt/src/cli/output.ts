import { statusText, terminalColors } from "@aquarius/core/internal";
import type { FormatExecutionResult, FormatResult } from "../format/types";

export const safeText = (value: string): string => (
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
);

export const printHuman = (execution: FormatExecutionResult, check: boolean): void => {
  const result: FormatResult = execution.result;
  const color = terminalColors(process.stderr);
  if (process.stdout.isTTY && execution.exitCode === 0 && !result.changedFiles.length && !result.wouldChangeFiles?.length && !result.restoredFiles?.length && !result.warnings.length && !result.errors.length) {
    console.log(statusText("Formatting complete", "success", process.stdout));
  }
  for (const file of check ? result.wouldChangeFiles ?? [] : result.changedFiles) {
    console.log(statusText(safeText(`${check ? "Would format" : "Formatted"} ${file}`), check ? "warning" : "success", process.stdout));
  }
  for (const file of result.restoredFiles ?? []) console.log(statusText(safeText(`Restored ${file}`), "success", process.stdout));
  for (const warning of result.warnings) {
    const rules = warning.ruleIds.length ? ` ${color.magenta(`[${safeText(warning.ruleIds.join(", "))}]`)}` : "";
    console.error(statusText(`${color.yellow("warn")} ${color.yellow(safeText(warning.code))}${rules}: ${color.bold(safeText(warning.message))}`, "warning", process.stderr));
    for (const path of warning.paths) console.error(`  ${color.dim("at")} ${color.cyan(safeText(path))}`);
  }
  for (const error of result.errors) {
    const rules = error.ruleIds.length ? ` ${color.magenta(`[${safeText(error.ruleIds.join(", "))}]`)}` : "";
    console.error(statusText(`${color.red("error")} ${color.red(safeText(error.code))}${rules}: ${color.bold(safeText(error.message))}`, "error", process.stderr));
  }
};
