import { progressLineText, type ProgressLine, type ProgressPart } from "@aquarius/core/internal";
import type { FormatAnalysisSnapshot, FormatReviewStatus } from "../format/types";
import { safeText } from "./output";

const singleLine = (value: string): string => safeText(value).replace(/[\r\n\t]/gu, " ");

const reviewStyles = {
  pending: { label: "pending", color: "dim", status: undefined },
  in_progress: { label: "reviewing", color: "cyan", status: "info" },
  completed: { label: "reviewed", color: "green", status: "success" },
  skipped: { label: "skipped", color: "yellow", status: "skipped" },
  failed: { label: "failed", color: "red", status: "error" },
} as const;

const reviewCounts = (
  label: string,
  reviews: readonly { status: FormatReviewStatus }[],
): ProgressLine => {
  const counts: Record<FormatReviewStatus, number> = {
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
  status: FormatReviewStatus,
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

export const analysisLines = (snapshot: FormatAnalysisSnapshot): ProgressLine[] => {
  const headings = {
    provisional: "Formatting review in progress (provisional)",
    final: "Formatting review complete",
    incomplete: "Formatting review incomplete",
  };
  const lines: ProgressLine[] = [
    {
      text: [{ text: headings[snapshot.phase], color: "bold" }],
      status: snapshot.phase === "incomplete" ? "warning" : "info",
    },
    reviewCounts("Files", snapshot.fileResults),
    reviewCounts("Rules", snapshot.ruleResults),
    { text: [{ text: `Proposed files: ${snapshot.proposedFiles.length}`, color: "bold" }] },
  ];
  for (const file of snapshot.fileResults) {
    if (file.status === "pending") continue;
    lines.push(reviewLine("File", file.path, file.status, file.reason));
  }
  for (const rule of snapshot.ruleResults) {
    if (rule.status === "pending") continue;
    lines.push(reviewLine("Rule", rule.ruleId, rule.status, rule.reason));
  }
  for (const path of snapshot.proposedFiles) {
    lines.push({
      text: [
        { text: "Proposed change ", color: "dim" },
        { text: path, color: "cyan" },
      ],
      status: "info",
    });
  }
  for (const warning of snapshot.warnings) {
    const rules = warning.ruleIds.length ? ` [${warning.ruleIds.join(", ")}]` : "";
    lines.push({
      text: [
        { text: `warn ${warning.code}`, color: "yellow" },
        { text: rules, color: "magenta" },
        { text: `: ${warning.message}` },
      ],
      status: "warning",
    });
    for (const path of warning.paths) {
      lines.push({
        text: [
          { text: "  at ", color: "dim" },
          { text: path, color: "cyan" },
        ],
      });
    }
  }

  return lines.map((line) => ({
    ...line,
    text:
      typeof line.text === "string"
        ? singleLine(line.text)
        : line.text.map((part): ProgressPart => ({ ...part, text: singleLine(part.text) })),
  }));
};

export const printAnalysisSnapshot = (
  snapshot: FormatAnalysisSnapshot,
  stream: NodeJS.WriteStream = process.stderr,
): void => {
  const lines = analysisLines(snapshot);
  stream.write(`${lines.map((line) => progressLineText(line, stream)).join("\n")}\n`);
};
