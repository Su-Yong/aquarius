import type { RulePlugin } from "@aquarius/core";
import { nameCompoundConditions } from "./format/name-compound-conditions";
import { preferEarlyReturn } from "./format/prefer-early-return";
import { separateResponsibilities } from "./format/separate-responsibilities";
import { architectureRules } from "./lint/architecture";
import { section02Rules } from "./lint/section-02";
import { noInputMutation } from "./lint/no-input-mutation";
import { releaseOnExit } from "./lint/release-on-exit";
import { usePublicEntry } from "./lint/use-public-entry";

export const aquariusRules: RulePlugin = {
  namespace: "aquarius",
  lintRules: [noInputMutation, usePublicEntry, releaseOnExit, ...architectureRules, ...section02Rules],
  formatRules: [preferEarlyReturn, nameCompoundConditions, separateResponsibilities],
};

export default aquariusRules;
