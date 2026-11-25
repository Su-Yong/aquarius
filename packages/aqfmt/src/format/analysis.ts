import { AquariusError, createAnalysisState } from "@aquarius/core/runtime";
import type {
  AnalysisOptions,
  PathPolicy,
  PreparedRule,
  RuleResource,
} from "@aquarius/core/runtime";
import { createFormatValidator, formatChangePaths } from "./results";
import { formatAnalysisUpdateSchema, type FormatAnalysisUpdate } from "./schemas";
import type { FormatAnalysis, FormatResponse, FormatSnapshotDetails } from "./types";

export const formatSnapshotDetails = ({
  changes,
  warnings,
}: FormatResponse): FormatSnapshotDetails => ({
  proposedFiles: formatChangePaths(changes),
  warnings,
});

export const createFormatAnalysis = (
  rules: readonly PreparedRule[],
  policy: PathPolicy,
  ruleResources: readonly RuleResource[],
  options: AnalysisOptions<FormatSnapshotDetails> = {},
): FormatAnalysis => {
  const validator = createFormatValidator(rules, policy, ruleResources);

  return createAnalysisState<FormatSnapshotDetails, FormatAnalysisUpdate, FormatResponse>(
    rules,
    policy,
    {
      parse: (raw) => formatAnalysisUpdateSchema.safeParse(raw).data,
      initial: { proposedFiles: [], warnings: [] },
      apply: (update, _current, files, rules) => {
        if (new Set(update.proposedFiles).size !== update.proposedFiles.length) {
          throw new AquariusError(
            "DUPLICATE_ANALYSIS_ITEM",
            "A provisional update repeats a proposed file path.",
          );
        }
        const proposedFiles = update.proposedFiles.map(validator.proposedPath);
        const warnings = update.warnings.map(validator.warning);

        if (proposedFiles.some((path) => files.get(path)?.status === "skipped")) {
          throw new AquariusError(
            "CONFLICTING_FILE_RESULT",
            "A provisionally skipped file also has a proposed change.",
          );
        }
        if (
          proposedFiles.length > 0 &&
          [...rules.values()].every(({ status }) => status === "skipped")
        ) {
          throw new AquariusError(
            "CONFLICTING_RULE_RESULT",
            "A proposed change remains after every requested rule was skipped.",
          );
        }
        if (
          warnings.some(({ ruleIds }) => ruleIds.some((id) => rules.get(id)?.status === "skipped"))
        ) {
          throw new AquariusError(
            "CONFLICTING_RULE_RESULT",
            "A provisionally skipped rule also has a warning.",
          );
        }
        return { proposedFiles, warnings };
      },
      final: formatSnapshotDetails,
    },
    options,
  );
};
