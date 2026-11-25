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
    const primaryLocationText = location ? `${location.path}:${location.line}:${location.column}` : "(project)";
    const ruleNames = diagnostic.rules.map(({ rule }) => rule).join(", ");
    lines.push({
      text: [
        { text: primaryLocationText, color: "cyan" },
        {
          text: ` ${diagnostic.severity}${incomplete ? " (unconfirmed)" : ""}`,
          color: diagnostic.severity === "error" ? "red" : "yellow",
        },
        { text: ` [${ruleNames}]`, color: "magenta" },
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

  return renderAnalysisLines(snapshot, {
    ai,
    ...(incomplete
      ? { showReviews: false }
      : {
          heading: {
            text: [{ text: `Current diagnostics: ${snapshot.diagnostics.length}`, color: "bold" }],
          },
        }),
    beforeReviews: lines,
  });
};
