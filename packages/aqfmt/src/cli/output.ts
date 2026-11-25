import {
  printHeading,
  printReportDetails,
  printSummaryCounts,
  safeText,
  statusText,
} from "@aquarius/core/cli";
import type { FormatExecutionResult } from "../format/types";

export const printHuman = (execution: FormatExecutionResult, check: boolean): void => {
  const result = execution.result;
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

  printHeading(heading, status);
  if (undo) {
    console.log(`Restored files: ${result.restoredFiles!.length}`);
  } else {
    printSummaryCounts(summary, {
      ai: result.ai,
      reviewCounts: [["Reviewed:", summary.completedFiles, "success"]],
      additionalCounts: [
        ["Proposed files:", result.proposedFiles.length, "info"],
        ["Written files:", result.changedFiles.length, "success"],
      ],
    });
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
  printReportDetails(result);
};
