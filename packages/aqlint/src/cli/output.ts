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
  const summary = result.summary;

  const selectLintHeading = (): [string, "success" | "warning" | "error" | "info"] => {
    if (execution.exitCode === 130) {
      return ["Lint cancelled", "error"];
    } else if (summary.totalFiles === null) {
      return ["Lint not started", execution.exitCode === 0 ? "info" : "error"];
    } else {
      const lintFailed =
        result.errors.length ||
        result.fileResults.some(({ status }) => status === "failed") ||
        execution.exitCode === 2;

      if (lintFailed) {
        return ["Lint failed", "error"];
      } else if (execution.exitCode !== 0) {
        return ["Lint complete with violations", "error"];
      } else if (summary.totalFiles === 0) {
        return ["No files selected", "info"];
      } else if (summary.skippedFiles === summary.totalFiles) {
        return ["Lint skipped", "info"];
      } else if (result.diagnostics.length || summary.skippedFiles) {
        return ["Lint complete with warnings", "warning"];
      }
    }

    return ["Lint complete", "success"];
  };

  const [heading, status] = selectLintHeading();

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

  const locationText = (location: { path: string; line: number; column?: number }) => {
    const coordinates = `${location.path}:${location.line}${location.column === undefined ? "" : `:${location.column}`}`;
    const safeCoordinates = safeText(coordinates);
    return color.cyan(safeCoordinates);
  };

  for (const diagnostic of result.diagnostics) {
    const [location, ...additionalLocations] = diagnostic.locations;
    const ruleLabels = diagnostic.rules
      .map(({ rule, severity }) => `${safeText(rule)}:${severity}`)
      .join(", ");
    const colorSeverity = diagnostic.severity === "error" ? color.red : color.yellow;

    console.log(
      statusText(
        `${locationText(location!)} ${colorSeverity(diagnostic.severity)} ${color.magenta(`[${ruleLabels}]`)} ${color.bold(safeText(diagnostic.message))}`,
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
