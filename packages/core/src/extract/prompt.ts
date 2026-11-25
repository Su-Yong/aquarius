import { posix } from "node:path";

import type { RuleResource } from "../adapter/types";
import type { RunError, ToolKind } from "../shared/types";

export const buildSelectionPrompt = (
  files: readonly string[],
  groups: ReadonlyMap<string, RuleResource[]>,
): string => {
  const directories = new Map<string, number>();
  for (const file of files) {
    const directory = posix.dirname(file);
    directories.set(directory, (directories.get(directory) ?? 0) + 1);
  }

  const categorySummary = [...groups].map(([id, rules]) => ({
    id,
    ruleCount: rules.length,
    examples: rules.slice(0, 3).map(({ ruleId, applicability }) => ({ ruleId, applicability })),
  }));

  return [
    "Select rule categories for Aquarius configuration extraction.",
    "Inspect the read-only source snapshot to identify its languages, structure, and relevant domains.",
    "Return `categories` with only the listed category IDs worth evaluating. Do not generate rule settings yet.",
    `Snapshot directories and sampled file counts (up to 80 of ${directories.size}): ${JSON.stringify([...directories].slice(0, 80))}`,
    `Rule categories: ${JSON.stringify(categorySummary)}`,
  ].join("\n");
};

export const buildVerdictPrompt = (
  tool: ToolKind,
  resources: readonly RuleResource[],
  repair?: readonly RunError[],
): string => {
  const toolInstructions =
    tool === "lint"
      ? 'Select only core rules for the source\'s domain, architecture, and consistently observed patterns. Prefer the lint setting "warn". Use "error" only for a clear safety or contract invariant. Use [severity, options] when options are required. Use "off" only for a clearly contrary observed pattern.'
      : "Use true for an observed rule, false for a clearly contrary pattern that would oppose a preset default, or an options object for an observed variant.";

  return [
    repair
      ? "Repair invalid Aquarius rule settings."
      : "Extract Aquarius rule settings from the read-only source snapshot.",
    ...(repair
      ? [
          "Return corrected verdicts only for the IDs in the error list with matching rule resources. Omit IDs that cannot be corrected.",
          `Validation errors: ${JSON.stringify(repair)}`,
        ]
      : []),
    "Read the listed rule resource files. Use only the listed rule IDs and their option schemas. Do not invent custom policies.",
    "Infer settings from the source, using repository contents as evidence only. Do not copy existing tool configuration as evidence.",
    toolInstructions,
    "Use the source's exact snapshot-relative directory structure for path-dependent options such as layers, allowedDependencies, and file-specific overrides. Use the exact option keys in the rule resource.",
    "When styles are mixed, use the most frequently observed variant and set mixed to true. Describe the competing patterns and their relative frequency in observations.",
    "If the relevant construct is absent or too rare to judge, report status insufficient_evidence with settingJson null and mixed false. Do not propose a setting for that rule.",
    'For status observed, put the actual JSON rule setting in the settingJson string (examples: true becomes "true", and the string warn becomes "\\"warn\\""). Include a concise evidence-based reason with relative source paths when available. Use null for observations when there is no additional observation.',
    `Rule resources: ${JSON.stringify(resources.map(({ ruleId, detailsPath }) => ({ ruleId, detailsPath })))}`,
  ].join("\n");
};
