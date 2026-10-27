import type { RulePlugin } from "@aquarius/core";
import { nameCompoundConditions } from "./format/name-compound-conditions";
import { preferEarlyReturn } from "./format/prefer-early-return";
import { separateResponsibilities } from "./format/separate-responsibilities";
import { noInputMutation } from "./lint/no-input-mutation";
import { releaseOnExit } from "./lint/release-on-exit";
import { usePublicEntry } from "./lint/use-public-entry";

export const aquariusRules: RulePlugin = {
  namespace: "aquarius",
  lintRules: [noInputMutation, usePublicEntry, releaseOnExit],
  formatRules: [preferEarlyReturn, nameCompoundConditions, separateResponsibilities],
};

export default aquariusRules;

