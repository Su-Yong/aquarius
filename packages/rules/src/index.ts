import type { RulePlugin } from "@aquarius/core";
import { nameCompoundConditions } from "./format/name-compound-conditions";
import { preferEarlyReturn } from "./format/prefer-early-return";
import { separateResponsibilities } from "./format/separate-responsibilities";
import { architectureRules } from "./lint/architecture";
import { section02Rules } from "./lint/section-02";
import { section03Rules } from "./lint/section-03";
import { section04Rules } from "./lint/section-04";
import { section05Rules } from "./lint/section-05";
import { section06Rules } from "./lint/section-06";
import { noInputMutation } from "./lint/no-input-mutation";
import { releaseOnExit } from "./lint/release-on-exit";
import { usePublicEntry } from "./lint/use-public-entry";

export const aquariusRules: RulePlugin = {
  namespace: "aquarius",
  lintRules: [noInputMutation, usePublicEntry, releaseOnExit, ...architectureRules, ...section02Rules, ...section03Rules, ...section04Rules, ...section05Rules, ...section06Rules],
  formatRules: [preferEarlyReturn, nameCompoundConditions, separateResponsibilities],
};

export default aquariusRules;
