import { buildTaskPrompt } from "@aquarius/core/internal";
import type { JsonObject, PathPolicy, PreparedRule } from "@aquarius/core/internal";

const formatInstructions = [
  "Transform the selected source to conform to the rules while preserving the same functionality. Inspect context and coordinate overlapping transformations in this one task. Return a single coherent change list; never write files yourself. Later rules take precedence when constraints conflict; report those conflicts in warnings.",
  "Only selected target files may receive existing-file changes. Readable context outside those targets may inform the result, but must not expand the write scope. New files and move destinations must obey the permitted target patterns.",
  "Every replacement refers to the original file text, not earlier changes in the list. Include enough exact oldText to identify one unique occurrence, preserving line endings. A move plus replacement uses the original path. Do not overwrite an existing move/create destination. Leave already conforming code unchanged. Do not repair unrelated behavior. If preservation cannot be established, emit a warning rather than an unsafe change.",
];

export const buildFormatPrompt = (
  rules: readonly PreparedRule[],
  policy: PathPolicy,
  writeScope: JsonObject,
): string => buildTaskPrompt(formatInstructions, rules, policy, {
  task: "format",
  writeScope,
});
