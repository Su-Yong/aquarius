import {
  printHeading,
  printReportDetails,
  printSummaryCounts,
  safeText,
  statusText,
} from "@aquarius/core/cli";

import type { FormatExecutionResult } from "../format/types";

interface FormattingHeading {
  heading: string;
  status: NonNullable<Parameters<typeof printHeading>[1]>;
}

export const printHuman = (execution: FormatExecutionResult, check: boolean): void => {
  const result = execution.result;
  const summary = result.summary;
  const formattingFailed =
    result.errors.length > 0 || summary.failedFiles > 0 || execution.exitCode === 2;
  const isUndo = result.restoredFiles !== undefined;
  const displayedChanges = check ? (result.wouldChangeFiles ?? []) : result.changedFiles;

  const selectFormattingHeading = (): FormattingHeading => {
    if (execution.exitCode === 130) {
      return { heading: "Formatting cancelled", status: "error" };
    } else if (isUndo) {
      return {
        heading: formattingFailed ? "Undo failed" : "Undo complete",
        status: formattingFailed ? "error" : "success",
      };
    } else if (summary.totalFiles === null) {
      return { heading: "Formatting not started", status: formattingFailed ? "error" : "info" };
    } else if (formattingFailed) {
      return { heading: selectFailureHeading(check, displayedChanges), status: "error" };
    } else if (summary.totalFiles === 0) {
      return { heading: "No files selected", status: "info" };
    } else if (summary.skippedFiles === summary.totalFiles) {
      return { heading: "Formatting skipped", status: "info" };
    } else if (check && displayedChanges.length) {
      return { heading: "Formatting changes needed", status: "warning" };
    } else if (result.warnings.length > 0 || summary.skippedFiles > 0) {
      return {
        heading: check
          ? "Formatting check complete with warnings"
          : "Formatting complete with warnings",
        status: "warning",
      };
    }

    return { heading: check ? "Formatting check complete" : "Formatting complete", status: "success" };
  };

  const { heading, status } = selectFormattingHeading();
  printHeading(heading, status);

  if (isUndo) {
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

  const changeLabel = check ? "Would format" : "Formatted";
  for (const file of displayedChanges) {
    console.log(
      statusText(
        safeText(`${changeLabel} ${file}`),
        check ? "warning" : "success",
        process.stdout,
      ),
    );
  }

  if (formattingFailed || execution.exitCode === 130) {
    const displayedPaths = new Set(displayedChanges);
    for (const file of result.proposedFiles) {
      if (displayedPaths.has(file)) continue;
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

const selectFailureHeading = (check: boolean, displayedChanges: readonly string[]): string => {
  if (!displayedChanges.length) return "Formatting failed";
  const operation = check ? "Formatting check" : "Formatting";
  return `${operation} completed with errors`;
};
