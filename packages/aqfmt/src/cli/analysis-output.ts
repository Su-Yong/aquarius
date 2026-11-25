import { renderAnalysisLines, type ProgressLine } from "@aquarius/core/cli";
import type { AdapterRunInfo } from "@aquarius/core/runtime";
import type { FormatAnalysisSnapshot } from "../format/types";

export const analysisLines = (
  snapshot: FormatAnalysisSnapshot,
  ai?: AdapterRunInfo,
): ProgressLine[] => {
  const headings = {
    provisional: "Formatting review in progress (provisional)",
    final: "Formatting review complete",
    incomplete: "Formatting review incomplete",
  };
  const lines: ProgressLine[] = [];
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

  return renderAnalysisLines(snapshot, {
    ai,
    heading: {
      text: [{ text: headings[snapshot.phase], color: "bold" }],
      status: snapshot.phase === "incomplete" ? "warning" : "info",
    },
    beforeReviews: [
      { text: [{ text: `Proposed files: ${snapshot.proposedFiles.length}`, color: "bold" }] },
    ],
    afterReviews: lines,
  });
};
