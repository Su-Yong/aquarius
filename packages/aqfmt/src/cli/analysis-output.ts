import { renderAnalysisLines, type ProgressLine } from "@aquarius/core/cli";
import type { AdapterRunInfo } from "@aquarius/core/runtime";

import type { FormatAnalysisSnapshot, FormatExecutionResult, FormatWarning } from "../format/types";

const ANALYSIS_HEADINGS = {
  provisional: "Formatting review in progress (provisional)",
  final: "Formatting review complete",
  incomplete: "Formatting review incomplete (provisional)",
};

export const incompleteAnalysisLines = (
  snapshot: FormatAnalysisSnapshot,
  { result }: FormatExecutionResult,
): ProgressLine[] => {
  const confirmedPaths = new Set(result.proposedFiles);
  const confirmedWarningKeys = result.warnings.map(warningKey);
  const confirmedWarnings = new Set(confirmedWarningKeys);
  const proposedFiles = snapshot.proposedFiles.filter((path) => !confirmedPaths.has(path));
  const warnings = snapshot.warnings.filter(
    (warning) => !confirmedWarnings.has(warningKey(warning)),
  );
  if (!proposedFiles.length && !warnings.length) return [];
  return analysisLines({ ...snapshot, proposedFiles, warnings });
};

export const analysisLines = (
  snapshot: FormatAnalysisSnapshot,
  ai?: AdapterRunInfo,
): ProgressLine[] => {
  const incomplete = snapshot.phase === "incomplete";
  const lines = Array.from(snapshot.proposedFiles, proposedFileLine);
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

  return renderAnalysisLines(snapshot, {
    ai,
    heading: {
      text: [{ text: ANALYSIS_HEADINGS[snapshot.phase], color: "bold" }],
      status: incomplete ? "warning" : "info",
    },
    beforeReviews: incomplete
      ? []
      : [{ text: [{ text: `Proposed files: ${snapshot.proposedFiles.length}`, color: "bold" }] }],
    afterReviews: lines,
    showReviews: !incomplete,
  });
};

const proposedFileLine = (path: string): ProgressLine => ({
  text: [
    { text: "Proposed change ", color: "dim" },
    { text: path, color: "cyan" },
  ],
  status: "info",
});

const warningKey = ({ code, message, ruleIds, paths }: FormatWarning): string => {
  const sortedRuleIds = [...ruleIds].sort();
  const sortedPaths = [...paths].sort();
  return JSON.stringify([code, message, sortedRuleIds, sortedPaths]);
};
