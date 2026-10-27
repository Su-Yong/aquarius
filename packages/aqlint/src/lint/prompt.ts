import { buildTaskPrompt } from "@aquarius/core/internal";
import type { JsonObject, PathPolicy, PreparedRule } from "@aquarius/core/internal";

const lintInstructions = [
  "Find evidence-backed rule violations. Return only violations, unknown conclusions, and execution errors; do not emit pass or not-applicable items. Cite concrete evidence for each violation. Group only findings that clearly describe the same underlying problem and preserve every contributing rule and evidence.",
  "Only selected target files may receive primary diagnostic locations. Readable context outside those targets may support evidence, but must not become a primary diagnostic location.",
  "Do not assign diagnostic severity; the application applies rule definitions and project settings.",
];

export const buildLintPrompt = (
  rules: readonly PreparedRule[],
  policy: PathPolicy,
  writeScope: JsonObject,
): string => buildTaskPrompt(lintInstructions, rules, policy, {
  task: "lint",
  writeScope,
});
