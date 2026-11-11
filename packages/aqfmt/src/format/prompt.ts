import { buildTaskPrompt } from "@aquarius/core/internal";
import type { JsonObject, PathPolicy, RuleReference } from "@aquarius/core/internal";

const formatInstructions = [
  "Transform the selected source to conform to the rules while preserving the same functionality. Inspect context and coordinate overlapping transformations in this one task. Return a single coherent change list; never write files yourself. Later rules take precedence when constraints conflict; report those conflicts in warnings.",
  "Only selected target files may receive existing-file changes. Readable context outside those targets may inform the result, but must not expand the write scope. New files and move destinations must obey the permitted target patterns.",
  "Every replacement refers to the original file text, not earlier changes in the list. Include enough exact oldText to identify one unique occurrence, preserving line endings. A move plus replacement uses the original path. Do not overwrite an existing move/create destination. Leave already conforming code unchanged. Do not repair unrelated behavior. If preservation cannot be established, emit a warning rather than an unsafe change.",
  "Return skippedRules with a ruleId and nonempty reason only when that rule does not apply anywhere in the selected scope. Keep skipped rules separate from completedRuleIds and execution errors. Missing context is uncertainty, not a reason to declare a rule inapplicable.",
  "Return fileResults for every selected target exactly once, including unchanged files: {path, status: completed|skipped|failed, reason}. Completed means the review finished, not that a change was saved. Skipped and failed require nonempty reasons. Never report changes to a skipped file. New files and move destinations belong in changes, not in the original target fileResults.",
  "If a review remains unfinished, report an execution error with code INCOMPLETE_FILE_REVIEW for unfinished files or INCOMPLETE_AI_RESPONSE for unfinished rule review. Do not mark a failed rule completed. Use these codes only for incomplete review, never for inaccessible inputs, invalid transformations, or unrelated errors. The caller may retry an incomplete file group once.",
  'During analysis, publish standalone JSON messages with type "aquarius.analysis_update", an increasing positive revision, fileResults, ruleResults, proposedFiles, and warnings. File entries contain path, status, reason; rule entries contain ruleId, status, reason. Status is pending, in_progress, completed, skipped, or failed. Include nonempty reasons for skipped or failed states. Begin by reporting the files and rules you are starting, and report meaningful checkpoints as review proceeds.',
  "Each intermediate fileResults and ruleResults array updates only its listed entries. proposedFiles and warnings are the complete current lists: omit withdrawn proposals from the next list and use an empty array to clear it. proposedFiles contains project-relative paths only, including both paths of a proposed move. Do not include patch text or a diff in these progress messages. These reports are provisional and must never write source files. The final response must follow the final output schema, not the intermediate update schema.",
];

export const buildFormatPrompt = (
  rules: readonly RuleReference[],
  policy: PathPolicy,
  writeScope: JsonObject,
): string => {
  const scopeInstructions = rules.every(({ scope }) => scope === "file")
    ? "All active rules have file scope. Only replace operations in the selected target files assigned to this request are permitted. Do not create, delete, or move files, and do not change files assigned to other requests. This restriction also applies when this request contains a single file or is the only file group. You may still read the permitted project context."
    : "At least one active rule has module or project scope. Review all selected targets together and coordinate all related changes in this single request; preserve the supported replace, create, delete, and move operations within the write scope.";
  return buildTaskPrompt([...formatInstructions, scopeInstructions], rules, policy, {
    task: "format",
    writeScope,
  });
};
