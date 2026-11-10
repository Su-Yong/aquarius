import { statusText, terminalColors } from "@aquarius/core/internal";
import type { LintExecutionResult, LintResult } from "../lint/types";

export const safeText = (value: string): string =>
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");

export const printHuman = (execution: LintExecutionResult): void => {
  const result = execution.result as LintResult;
  const color = terminalColors(process.stdout);
  const errorColor = terminalColors(process.stderr);
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

  const counts = [
    ["Files:", summary.totalFiles ?? "undetermined", "info"],
    ["Success:", summary.successFiles, "success"],
    ["Warnings:", summary.warningFiles, "warning"],
    ["Skipped:", summary.skippedFiles, "skipped"],
    ["Failed:", summary.failedFiles, "error"],
    ["Active rules:", summary.activeRules, "info"],
  ] as const;

  console.log("");
  console.log(statusText(color.bold(heading), status, process.stdout));
  console.log("");
  for (const [label, count, countStatus] of counts) {
    const message = `${label.padEnd(17)} ${color.bold(String(count))}`;
    const line = statusText(message, countStatus, process.stdout);
    console.log(`  ${count === 0 ? color.dim(line) : line}`);
  }

  for (const path of result.changedFiles ?? []) {
    console.log(statusText(safeText(`updated ${path}`), "success", process.stdout));
  }
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
  if (result.errors.length > 0) {
    console.error("");
    console.error(
      statusText(
        errorColor.bold(`Execution errors (${result.errors.length})`),
        "error",
        process.stderr,
      ),
    );
  }
  for (const error of result.errors) {
    const rules = error.ruleIds.length
      ? ` ${errorColor.magenta(`[${safeText(error.ruleIds.join(", "))}]`)}`
      : "";
    console.error(
      statusText(
        `${errorColor.red("error")} ${errorColor.red(safeText(error.code))}${rules}: ${errorColor.bold(safeText(error.message))}`,
        "error",
        process.stderr,
      ),
    );
  }
  if (result.skippedRules.length > 0) {
    console.log("");
    console.log(
      statusText(
        color.bold(`Skipped rules (${result.skippedRules.length})`),
        "skipped",
        process.stdout,
      ),
    );
    for (const rule of result.skippedRules) {
      console.log(
        statusText(
          `${color.magenta(safeText(rule.ruleId))}: ${safeText(rule.reason)}`,
          "skipped",
          process.stdout,
        ),
      );
    }
  }
  const incompleteFiles = result.fileResults.filter(({ status }) => status !== "completed");
  if (incompleteFiles.length > 0) {
    console.log("");
    console.log(color.bold(`Skipped / failed files (${incompleteFiles.length})`));
  }
  for (const file of incompleteFiles) {
    const stateColor = file.status === "failed" ? color.red : color.yellow;
    console.log(
      statusText(
        `${stateColor(file.status)} ${color.cyan(safeText(file.path))}: ${color.dim(safeText(file.reason))}`,
        file.status === "failed" ? "error" : "skipped",
        process.stdout,
      ),
    );
  }
};
