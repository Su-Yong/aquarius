import type { AdapterRunInfo } from "../adapter/types";
import type { RunError, SkippedRule } from "../shared/types";
import { statusText, terminalColors, type ProgressLine } from "./progress";

type OutputStatus = NonNullable<ProgressLine["status"]>;

type SummaryCount = readonly [label: string, value: number | string, status: OutputStatus];

interface SummaryTotals {
  totalFiles: number | null;
  skippedFiles: number;
  failedFiles: number;
  activeRules: number;
}

interface ReportFile {
  path: string;
  status: "completed" | "skipped" | "failed";
  reason: string;
}

interface ReportDetails {
  fileResults: readonly ReportFile[];
  skippedRules: readonly SkippedRule[];
  warnings?: readonly (RunError & { paths: readonly string[] })[];
  errors: readonly RunError[];
}

export const safeText = (value: string): string =>
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");

const adapterDetailLabels = new Map([
  ["reasoning.effort", "effort"],
  ["reasoning.summary", "summary"],
  ["context.window", "context"],
]);

export const formatAdapterRunInfo = ({ adapter, model, details }: AdapterRunInfo): string => {
  const name = model ? `${adapter} · ${model}` : adapter;
  const settings = Object.entries(details ?? {}).map(([key, value]) =>
    key === "serviceTier" ? value : `${adapterDetailLabels.get(key) ?? key}=${value}`,
  );
  const text = settings.length ? `${name} (${settings.join(", ")})` : name;
  return safeText(text).replace(/[\r\n\t\u2028\u2029]/gu, " ");
};

export const printHeading = (heading: string, status: OutputStatus): void => {
  const stream = process.stdout;
  console.log(statusText(terminalColors(stream).bold(heading), status, stream));
};

export const printSummaryCounts = (
  summary: SummaryTotals,
  {
    reviewCounts,
    additionalCounts = [],
    ai,
  }: {
    reviewCounts: readonly SummaryCount[];
    additionalCounts?: readonly SummaryCount[];
    ai?: AdapterRunInfo;
  },
): void => {
  const stream = process.stdout;
  const color = terminalColors(stream);
  const counts: SummaryCount[] = [
    ["Files:", summary.totalFiles ?? "undetermined", "info"],
    ...reviewCounts,
    ["Skipped:", summary.skippedFiles, "skipped"],
    ["Failed:", summary.failedFiles, "error"],
    ["Active rules:", summary.activeRules, "info"],
    ...additionalCounts,
  ];
  if (ai) counts.push(["AI:", formatAdapterRunInfo(ai), "info"]);
  for (const [label, count, status] of counts) {
    const text = `${label.padEnd(17)} ${color.bold(String(count))}`;
    const line = statusText(text, status, stream);
    console.log(`  ${count === 0 ? color.dim(line) : line}`);
  }
};

const printIssue = (
  issue: RunError & { paths?: readonly string[] },
  status: "error" | "warning",
): void => {
  const stream = process.stderr;
  const color = terminalColors(stream);
  const label = status === "error" ? color.red("error") : color.yellow("warn");
  const codeColor = status === "error" ? color.red : color.yellow;
  const rules = issue.ruleIds.length
    ? ` ${color.magenta(`[${safeText(issue.ruleIds.join(", "))}]`)}`
    : "";
  console.error(
    statusText(
      `${label} ${codeColor(safeText(issue.code))}${rules}: ${color.bold(safeText(issue.message))}`,
      status,
      stream,
    ),
  );
  for (const path of issue.paths ?? []) {
    console.error(`  ${color.dim("at")} ${color.cyan(safeText(path))}`);
  }
};

export const printReportDetails = (result: ReportDetails): void => {
  const stdout = process.stdout;
  const stderr = process.stderr;
  const color = terminalColors(stdout);
  if (result.skippedRules.length > 0) {
    console.log("");
    console.log(
      statusText(color.bold(`Skipped rules (${result.skippedRules.length})`), "skipped", stdout),
    );
    for (const rule of result.skippedRules) {
      const text = `${color.magenta(safeText(rule.ruleId))}: ${safeText(rule.reason)}`;
      console.log(statusText(text, "skipped", stdout));
    }
  }

  const incompleteFiles = result.fileResults.filter(({ status }) => status !== "completed");
  if (incompleteFiles.length > 0) {
    console.log("");
    console.log(color.bold(`Skipped / failed files (${incompleteFiles.length})`));
  }
  for (const file of incompleteFiles) {
    const failed = file.status === "failed";
    const state = (failed ? color.red : color.yellow)(file.status);
    const text = `${state} ${color.cyan(safeText(file.path))}: ${color.dim(safeText(file.reason))}`;
    console.log(statusText(text, failed ? "error" : "skipped", stdout));
  }

  for (const warning of result.warnings ?? []) {
    printIssue(warning, "warning");
  }
  if (result.errors.length > 0) {
    console.error("");
    const heading = terminalColors(stderr).bold(`Execution errors (${result.errors.length})`);
    console.error(statusText(heading, "error", stderr));
    for (const error of result.errors) {
      printIssue(error, "error");
    }
  }
};
