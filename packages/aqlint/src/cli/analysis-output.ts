import { progressLineText, type ProgressLine, type ProgressPart } from "@aquarius/core/internal";
import type { LintAnalysisSnapshot, ReviewStatus } from "../lint/types";
import { safeText } from "./output";

const singleLine = (value: string): string => safeText(value).replace(/[\r\n\t]/gu, " ");

const reviewStyles = {
  in_progress: { label: "reviewing", color: "cyan", status: "info" },
  completed: { label: "reviewed", color: "green", status: "success" },
  skipped: { label: "skipped", color: "yellow", status: "skipped" },
  failed: { label: "failed", color: "red", status: "error" },
  pending: { label: "pending", color: "dim", status: undefined },
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

export const analysisLines = (snapshot: LintAnalysisSnapshot): ProgressLine[] => {
  const incomplete = snapshot.phase === "incomplete";
  const lines: ProgressLine[] = incomplete
    ? []
    : [
        {
          text: [{ text: `Current diagnostics: ${snapshot.diagnostics.length}`, color: "bold" }],
        },
        reviewCounts("Files", snapshot.fileResults),
        reviewCounts("Rules", snapshot.ruleResults),
      ];

  for (const diagnostic of snapshot.diagnostics) {
    const [location, ...additionalLocations] = diagnostic.locations;
    const primary = location ? `${location.path}:${location.line}:${location.column}` : "(project)";
    const rules = diagnostic.rules.map(({ rule }) => rule).join(", ");
    lines.push({
      text: [
        { text: primary, color: "cyan" },
        {
          text: ` ${diagnostic.severity}${incomplete ? " (unconfirmed)" : ""}`,
          color: diagnostic.severity === "error" ? "red" : "yellow",
        },
        { text: ` [${rules}]`, color: "magenta" },
        { text: `: ${diagnostic.message}` },
      ],
      status: diagnostic.severity === "error" ? "error" : "warning",
    });
    for (const additional of additionalLocations) {
      lines.push({
        text: [
          { text: "  at ", color: "dim" },
          { text: `${additional.path}:${additional.line}:${additional.column}`, color: "cyan" },
        ],
      });
    }
    for (const evidence of diagnostic.evidence) {
      lines.push({
        text: [
          { text: "  evidence ", color: "dim" },
          { text: `${evidence.path}:${evidence.line}`, color: "cyan" },
          { text: `: ${evidence.message}`, color: "dim" },
        ],
      });
    }
  }

  if (!incomplete) {
    const reviewLine = (
      kind: "File" | "Rule",
      name: string,
      status: ReviewStatus,
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
    for (const file of snapshot.fileResults) {
      if (file.status === "pending") continue;
      lines.push(reviewLine("File", file.path, file.status, file.reason));
    }
    for (const rule of snapshot.ruleResults) {
      if (rule.status === "pending") continue;
      lines.push(reviewLine("Rule", rule.ruleId, rule.status, rule.reason));
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
  snapshot: LintAnalysisSnapshot,
  stream: NodeJS.WriteStream = process.stderr,
): void => {
  const lines = analysisLines(snapshot);
  if (lines.length === 0) return;
  stream.write(`${lines.map((line) => progressLineText(line, stream)).join("\n")}\n`);
};
