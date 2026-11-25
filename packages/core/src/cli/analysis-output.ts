import type { AdapterRunInfo } from "../adapter/types";
import type { AnalysisSnapshot, ReviewStatus } from "../execution/types";
import { formatAdapterRunInfo, safeText } from "./output";
import { progressLineText, type ProgressLine, type ProgressPart } from "./progress";

const singleLine = (value: string): string => safeText(value).replace(/[\r\n\t]/gu, " ");

const sanitizeProgressLine = (line: ProgressLine): ProgressLine => ({
  ...line,
  text:
    typeof line.text === "string"
      ? singleLine(line.text)
      : line.text.map((part): ProgressPart => ({ ...part, text: singleLine(part.text) })),
});

const reviewStyles = {
  in_progress: { label: "reviewing", color: "cyan", status: "info" },
  completed: { label: "reviewed", color: "green", status: "success" },
  skipped: { label: "skipped", color: "yellow", status: "skipped" },
  failed: { label: "failed", color: "red", status: "error" },
} as const;

const reviewCounts = (
  label: string,
  reviews: readonly { status: ReviewStatus }[],
): ProgressLine => {
  const counts: Record<ReviewStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
  };
  for (const review of reviews) {
    counts[review.status] += 1;
  }
  return {
    text: [
      { text: `${label} ${reviews.length}: `, color: "bold" },
      { text: `reviewing ${counts.in_progress}`, color: counts.in_progress ? "cyan" : "dim" },
      { text: ", " },
      { text: `reviewed ${counts.completed}`, color: counts.completed ? "green" : "dim" },
      { text: ", " },
      { text: `skipped ${counts.skipped}`, color: counts.skipped ? "yellow" : "dim" },
      { text: ", " },
      { text: `failed ${counts.failed}`, color: counts.failed ? "red" : "dim" },
      { text: `, pending ${counts.pending}`, color: "dim" },
    ],
  };
};

const reviewLine = (
  kind: "File" | "Rule",
  name: string,
  status: Exclude<ReviewStatus, "pending">,
  reason: string,
): ProgressLine => {
  const style = reviewStyles[status];
  return {
    text: [
      { text: `${kind} `, color: "dim" },
      { text: name, color: kind === "File" ? "cyan" : "magenta" },
      { text: ": " },
      { text: style.label, color: style.color },
      { text: reason ? ` — ${reason}` : "", color: "dim" },
    ],
    status: style.status,
  };
};

interface AnalysisLinesOptions {
  ai?: AdapterRunInfo;
  heading?: ProgressLine;
  beforeReviews?: readonly ProgressLine[];
  afterReviews?: readonly ProgressLine[];
  showReviews?: boolean;
}

export const renderAnalysisLines = (
  snapshot: AnalysisSnapshot,
  {
    ai,
    heading,
    beforeReviews = [],
    afterReviews = [],
    showReviews = true,
  }: AnalysisLinesOptions = {},
): ProgressLine[] => {
  const headings: ProgressLine[] = [];
  if (ai) headings.push({ text: `AI: ${formatAdapterRunInfo(ai)}` });
  if (heading) headings.push(heading);
  if (!showReviews) {
    return [...headings, ...beforeReviews, ...afterReviews].map(sanitizeProgressLine);
  }
  const lines = [
    ...headings,
    reviewCounts("Files", snapshot.fileResults),
    reviewCounts("Rules", snapshot.ruleResults),
    ...beforeReviews,
  ];
  for (const file of snapshot.fileResults) {
    if (file.status === "pending") {
      continue;
    }
    lines.push(reviewLine("File", file.path, file.status, file.reason));
  }
  for (const rule of snapshot.ruleResults) {
    if (rule.status === "pending") {
      continue;
    }
    lines.push(reviewLine("Rule", rule.ruleId, rule.status, rule.reason));
  }
  return [...lines, ...afterReviews].map(sanitizeProgressLine);
};

export const printAnalysisSnapshot = (
  lines: readonly ProgressLine[],
  stream: NodeJS.WriteStream = process.stderr,
): void => {
  if (lines.length === 0) {
    return;
  }
  stream.write(`${lines.map((line) => progressLineText(line, stream)).join("\n")}\n`);
};
