import { z } from "zod";

import { buildTaskPrompt } from "@aqtools/core/runtime";
import type { JsonObject, PathPolicy, RuleReference } from "@aqtools/core/runtime";

import type { ReplacementFailure } from "../changes/plan";
import type { ReplaceChange } from "../changes/schema";

import { formatAnalysisUpdateSchema } from "./schemas";

const formatInstructions = [
  "Transform the selected source to conform to the rules while preserving the same functionality. Inspect context and coordinate overlapping transformations in this one task. Return a single coherent change list; never write files yourself. Later rules take precedence when constraints conflict; report those conflicts in warnings.",
  "Only selected target files may receive existing-file changes. Readable context outside those targets may inform the result, but must not expand the write scope. New files and move destinations must obey the permitted target patterns.",
  "Each replace has path, patch, and ruleIds. Use a standard Unified Diff patch with @@ -oldStart[,oldCount] +newStart[,newCount] @@ hunks. Prefer one combined patch per file. Base every hunk on the original file and keep all original hunk ranges non-overlapping, including context lines. Include exact original lines, preserve line endings and the final newline, and use the standard no-newline marker where needed. For a move plus replacement, use the original path. Do not overwrite an existing move/create destination. Leave already conforming code unchanged. Do not repair unrelated behavior. If preservation cannot be established, emit a warning rather than an unsafe change.",
  "Return fileResults for every selected target exactly once, including unchanged files: {path, status: completed|skipped|failed, reason}. Completed means the review finished, not that a change was saved. Skipped and failed require nonempty reasons. Never report changes to a skipped file. New files and move destinations belong in changes, not in the original target fileResults.",
  "If the adapter supports provisional reporting, send an initial update matching analysisUpdates.schema before the first inspection. Mark the first one or two selected target files you are about to review as in_progress in fileResults, and at least one requested rule as in_progress in ruleResults. Do not send an empty initial report or report uninspected files or rules as completed.",
  "While reporting provisionally, send a meaningful checkpoint after inspecting at most two new target files or finishing a small group of rule reviews, with no more than a few read/search commands between updates. Each checkpoint must report actual review progress or changes to the current proposals or warnings. Do not send empty heartbeats or defer all updates until the final response. Send an update immediately when an entry in proposedFiles or warnings is added, revised, or withdrawn.",
  "In each provisional update, include proposedFiles and warnings as the complete current lists. Omit withdrawn entries from the next list and use an empty array to clear it. Start with [] for either list that has no entries yet. proposedFiles contains project-relative paths only, including both paths of a proposed move. Do not include patch text or a diff, and never write source files.",
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
    analysisUpdates: {
      schema: z.toJSONSchema(formatAnalysisUpdateSchema),
    },
  });
};

export const buildReplacementRepairPrompt = (
  failure: ReplacementFailure,
  changes: readonly ReplaceChange[],
  rules: readonly RuleReference[],
): string =>
  [
    "Repair the proposed replacement for this one file. Read its original contents and the listed rule details. Read one rule detail file per tool response. Merge or correct the failed patches into one valid Unified Diff with non-overlapping hunks based on the original file. Use @@ -oldStart[,oldCount] +newStart[,newCount] @@ hunk headers. Preserve functionality, line endings, and the final newline. Later rules in the listed order take precedence if their changes conflict.",
    "Return only replace changes for the specified path, referencing the relevant listed rule IDs. Account for every listed rule and return exactly one fileResults entry: {path, status: completed|skipped|failed, reason}. A successful repair has status completed. If resolving the conflict safely means keeping the original file unchanged, return changes: [], explanatory warnings, and status completed. Never write the file yourself. Return the final JSON value required by the response schema without Markdown or additional prose.",
    JSON.stringify(buildRepairRequest(failure, changes, rules), null, 2),
  ].join("\n\n");

const buildRepairRequest = (
  failure: ReplacementFailure,
  changes: readonly ReplaceChange[],
  rules: readonly RuleReference[],
) => ({
  task: "repair-format-replacement",
  targets: [failure.path],
  error: failure.error,
  patches: changes.map(({ patch, ruleIds }) => ({ patch, ruleIds })),
  rules: rules.map(({ ruleId, detailsPath }) => ({ ruleId, detailsPath })),
});
