import { z } from "zod";
import { buildTaskPrompt } from "@aquarius/core/runtime";
import type { JsonObject, PathPolicy, RuleReference } from "@aquarius/core/runtime";
import { analysisUpdateSchema } from "./schemas";

const lintInstructions = [
  "Find evidence-backed rule violations. In diagnostics, return only violations, not pass or not-applicable findings. Cite concrete evidence for each violation. Group only findings that clearly describe the same underlying problem and preserve every contributing rule and evidence.",
  "Complete a rule-driven review: inspect the selected sources, then work through the entire requested rule index in order. For each rule, establish applicability, read its full details when applicable or uncertain, inspect the required available evidence, and record the outcome before advancing. Reading all target files is only preparation; it is not a stopping condition while rules remain unreviewed.",
  "Only selected target files may receive primary diagnostic locations. Readable context outside those targets may support evidence, but must not become a primary diagnostic location.",
  "Do not assign diagnostic severity; the application applies rule definitions and project settings.",
  "Use completed when all requested rule reviews for a file have finished. This is a processing status, not a success verdict: the application derives mutually exclusive success, warning, failed, and skipped file counts from validated diagnostics and processing failures. A completed file may have an empty reason.",
  "Review the available project context and reach a conclusion for every requested rule: report a concrete supported violation, complete the review with no established violation, or skip a rule whose code applicability prerequisite is absent. Required rule options and mandatory policies must be validated during setup; missing required configuration is an error, never a skip or success. Do not invent additional required configuration that the rule does not declare. Inspect source, callers, configuration, and available documentation before deciding. Do not invent missing project policies or treat an unproven suspicion as a violation. Do not return deferred or unknown conclusions. Only actual access, tool, or execution failures should prevent completion.",
  "Use skipped only when no requested rule applies to the file, and provide a nonempty reason. A skipped file must not also have a diagnostic. Use failed when analysis could not finish and provide a nonempty reason describing the failing operation. Preserve any supported partial findings for failed files.",
  "Keep failures confined to known target files in their fileResults items. Use errors for rule-level or project-level failures whose affected targets cannot be isolated; such errors invalidate completion for the entire target set.",
  "Before the first inspection, emit an analysis update matching analysisUpdates.schema. The initial update must mark the first one or two selected target files you are about to review as in_progress in fileResults, and at least one requested rule as in_progress in ruleResults. Do not send an empty initial report or report uninspected files or rules as completed.",
  "Send a meaningful checkpoint after inspecting at most two new target files or finishing a small group of rule reviews, with no more than a few read/search commands between updates. Each checkpoint must report actual file/rule review progress or finding changes, not empty heartbeat arrays. Continue reviewing rules after the initial source inspection, even when every file has already appeared in an update. Checkpoints do not limit the number of inspections or rule reviews. Send an update immediately when a finding is added, revised, or withdrawn. Never invent findings or completion to fill an update, and do not defer all updates until the final answer.",
  "Each analysis update is a delta for diagnostics. An entry with id and diagnostic adds or replaces that finding; diagnostic null withdraws it. Keep the same id when revising a finding, and do not create a new id merely because its wording changed. Omitted IDs remain unchanged.",
  "Before the final response, check that every requested rule has actually been reviewed or has a concrete execution blocker. If rules remain unreviewed and read/search tools still work, continue the review. A large rule count, unfinished work, or completing the source-reading pass is not an execution blocker. Reserve errors for concrete failures such as unreadable required rule details or failed source access, include the affected ruleIds, and describe the failing operation. Use an empty ruleIds array only for a concrete failure that prevents the whole request from running.",
];

export const buildLintPrompt = (
  rules: readonly RuleReference[],
  policy: PathPolicy,
  writeScope: JsonObject,
): string =>
  buildTaskPrompt(lintInstructions, rules, policy, {
    task: "lint",
    writeScope,
    analysisUpdates: {
      schema: z.toJSONSchema(analysisUpdateSchema),
    },
  });
