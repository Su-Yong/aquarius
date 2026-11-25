import { renderAnalysisLines, type ProgressLine } from "@aquarius/core/cli";
import type { AdapterRunInfo } from "@aquarius/core/runtime";
import type { LintAnalysisSnapshot } from "../lint/types";

export const analysisLines = (
  snapshot: LintAnalysisSnapshot,
  ai?: AdapterRunInfo,
): ProgressLine[] => {
  const incomplete = snapshot.phase === "incomplete";
  const lines: ProgressLine[] = [];

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

  if (incomplete) {
    return renderAnalysisLines(snapshot, { ai, beforeReviews: lines, showReviews: false });
  }
  return renderAnalysisLines(snapshot, {
    ai,
    heading: {
      text: [{ text: `Current diagnostics: ${snapshot.diagnostics.length}`, color: "bold" }],
    },
    beforeReviews: lines,
  });
};
