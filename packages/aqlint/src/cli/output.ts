import {
  printHeading,
  printReportDetails,
  printSummaryCounts,
  safeText,
  statusText,
  terminalColors,
} from "@aquarius/core/cli";
import type { LintExecutionResult } from "../lint/types";

export const printHuman = (execution: LintExecutionResult): void => {
  const result = execution.result;
  const color = terminalColors(process.stdout);
  const locationText = (location: { path: string; line: number; column?: number }) =>
    color.cyan(
      safeText(
        `${location.path}:${location.line}${location.column === undefined ? "" : `:${location.column}`}`,
      ),
    );
  const summary = result.summary;
  let heading = "Lint complete";
  let status: "success" | "warning" | "error" | "info" = "success";
  if (execution.exitCode === 130) {
    heading = "Lint cancelled";
    status = "error";
  } else if (summary.totalFiles === null) {
    heading = "Lint not started";
    status = execution.exitCode === 0 ? "info" : "error";
  } else if (
    result.errors.length ||
    result.fileResults.some(({ status }) => status === "failed") ||
    execution.exitCode === 2
  ) {
    heading = "Lint failed";
    status = "error";
  } else if (execution.exitCode !== 0) {
    heading = "Lint complete with violations";
    status = "error";
  } else if (summary.totalFiles === 0) {
    heading = "No files selected";
    status = "info";
  } else if (summary.skippedFiles === summary.totalFiles) {
    heading = "Lint skipped";
    status = "info";
  } else if (result.diagnostics.length || summary.skippedFiles) {
    heading = "Lint complete with warnings";
    status = "warning";
  }

  console.log("");
  printHeading(heading, status);
  console.log("");
  printSummaryCounts(summary, {
    ai: result.ai,
    reviewCounts: [
      ["Success:", summary.successFiles, "success"],
      ["Warnings:", summary.warningFiles, "warning"],
    ],
  });

  if (result.diagnostics.length > 0) {
    const diagnosticStatus = result.diagnostics.some(({ severity }) => severity === "error")
      ? "error"
      : "warning";
    console.log("");
    console.log(
      statusText(
        color.bold(`Diagnostics (${result.diagnostics.length})`),
        diagnosticStatus,
        process.stdout,
      ),
    );
  }
  for (const diagnostic of result.diagnostics) {
    const [location, ...additionalLocations] = diagnostic.locations;
    const rules = diagnostic.rules
      .map(({ rule, severity }) => `${safeText(rule)}:${severity}`)
      .join(", ");
    const severity = diagnostic.severity === "error" ? color.red : color.yellow;
    console.log(
      statusText(
        `${locationText(location!)} ${severity(diagnostic.severity)} ${color.magenta(`[${rules}]`)} ${color.bold(safeText(diagnostic.message))}`,
        diagnostic.severity === "error" ? "error" : "warning",
        process.stdout,
      ),
    );
    for (const additional of additionalLocations) {
      console.log(`  ${color.dim("at")} ${locationText(additional)}`);
    }
    for (const evidence of diagnostic.evidence) {
      console.log(
        `  ${color.dim("evidence")} ${locationText(evidence)}: ${color.dim(safeText(evidence.message))}`,
      );
    }
  }
  printReportDetails(result);
};
