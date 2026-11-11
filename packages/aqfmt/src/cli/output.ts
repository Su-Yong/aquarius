import { statusText, terminalColors } from "@aquarius/core/internal";
import type { FormatExecutionResult, FormatResult } from "../format/types";

export const safeText = (value: string): string =>
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");

export const printHuman = (execution: FormatExecutionResult, check: boolean): void => {
  const result: FormatResult = execution.result;
  const color = terminalColors(process.stderr);
  const outputColor = terminalColors(process.stdout);
  const summary = result.summary;
  const failed = result.errors.length > 0 || summary.failedFiles > 0 || execution.exitCode === 2;
  const undo = result.restoredFiles !== undefined;
  let heading = check ? "Formatting check complete" : "Formatting complete";
  let status: "success" | "warning" | "error" | "info" = "success";

  if (execution.exitCode === 130) {
    heading = "Formatting cancelled";
    status = "error";
  } else if (undo) {
    heading = failed ? "Undo failed" : "Undo complete";
    status = failed ? "error" : "success";
  } else if (summary.totalFiles === null) {
    heading = "Formatting not started";
    status = failed ? "error" : "info";
  } else if (failed) {
    heading = "Formatting failed";
    status = "error";
  } else if (summary.totalFiles === 0) {
    heading = "No files selected";
    status = "info";
  } else if (summary.skippedFiles === summary.totalFiles) {
    heading = "Formatting skipped";
    status = "info";
  } else if (check && result.wouldChangeFiles?.length) {
    heading = "Formatting changes needed";
    status = "warning";
  } else if (result.warnings.length > 0 || summary.skippedFiles > 0) {
    heading = check
      ? "Formatting check complete with warnings"
      : "Formatting complete with warnings";
    status = "warning";
  }

  console.log(statusText(outputColor.bold(heading), status, process.stdout));
  if (undo) {
    console.log(`Restored files: ${result.restoredFiles!.length}`);
  } else {
    const counts = [
      ["Files:", summary.totalFiles ?? "undetermined", "info"],
      ["Reviewed:", summary.completedFiles, "success"],
      ["Skipped:", summary.skippedFiles, "skipped"],
      ["Failed:", summary.failedFiles, "error"],
      ["Active rules:", summary.activeRules, "info"],
      ["Proposed files:", result.proposedFiles.length, "info"],
      ["Written files:", result.changedFiles.length, "success"],
    ] as const;
    for (const [label, count, countStatus] of counts) {
      const line = statusText(
        `${label.padEnd(17)} ${outputColor.bold(String(count))}`,
        countStatus,
        process.stdout,
      );
      console.log(`  ${count === 0 ? outputColor.dim(line) : line}`);
    }
  }
  for (const file of check ? (result.wouldChangeFiles ?? []) : result.changedFiles) {
    console.log(
      statusText(
        safeText(`${check ? "Would format" : "Formatted"} ${file}`),
        check ? "warning" : "success",
        process.stdout,
      ),
    );
  }
  if (failed || execution.exitCode === 130) {
    const applied = new Set(result.changedFiles);
    for (const file of result.proposedFiles) {
      if (applied.has(file)) continue;
      console.log(
        statusText(safeText(`Proposed (not applied) ${file}`), "warning", process.stdout),
      );
    }
  }
  for (const file of result.restoredFiles ?? []) {
    console.log(statusText(safeText(`Restored ${file}`), "success", process.stdout));
  }
  for (const file of result.fileResults) {
    if (file.status === "completed") continue;
    console.log(
      statusText(
        `${file.status} ${outputColor.cyan(safeText(file.path))}: ${outputColor.dim(safeText(file.reason))}`,
        file.status === "failed" ? "error" : "skipped",
        process.stdout,
      ),
    );
  }
  for (const rule of result.skippedRules) {
    console.log(
      statusText(
        `Skipped rule ${outputColor.magenta(safeText(rule.ruleId))}: ${safeText(rule.reason)}`,
        "skipped",
        process.stdout,
      ),
    );
  }
  for (const warning of result.warnings) {
    const rules = warning.ruleIds.length
      ? ` ${color.magenta(`[${safeText(warning.ruleIds.join(", "))}]`)}`
      : "";
    console.error(
      statusText(
        `${color.yellow("warn")} ${color.yellow(safeText(warning.code))}${rules}: ${color.bold(safeText(warning.message))}`,
        "warning",
        process.stderr,
      ),
    );
    for (const path of warning.paths)
      console.error(`  ${color.dim("at")} ${color.cyan(safeText(path))}`);
  }
  for (const error of result.errors) {
    const rules = error.ruleIds.length
      ? ` ${color.magenta(`[${safeText(error.ruleIds.join(", "))}]`)}`
      : "";
    console.error(
      statusText(
        `${color.red("error")} ${color.red(safeText(error.code))}${rules}: ${color.bold(safeText(error.message))}`,
        "error",
        process.stderr,
      ),
    );
  }
};
