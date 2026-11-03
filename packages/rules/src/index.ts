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
import { section07Rules } from "./lint/section-07";
import { section08Rules } from "./lint/section-08";
import { stateRules } from "./lint/section-09-state";
import { errorRules } from "./lint/section-10-error";
import { asyncRules } from "./lint/section-11-async";
import { resourceRules } from "./lint/section-12-resource";
import { persistenceRules } from "./lint/section-13-persistence";
import { queryRules } from "./lint/section-14-query";
import { distributedRules } from "./lint/section-15-distributed";
import { cacheRules } from "./lint/section-16-cache";
import { securityRules } from "./lint/section-17-security";
import { privacyRules } from "./lint/section-18-privacy";
import { httpRules } from "./lint/section-19-http";
import { eventRules } from "./lint/section-20-event";
import { noInputMutation } from "./lint/no-input-mutation";
import { releaseOnExit } from "./lint/release-on-exit";
import { usePublicEntry } from "./lint/use-public-entry";

export const aquariusRules: RulePlugin = {
  namespace: "aquarius",
  lintRules: [noInputMutation, usePublicEntry, releaseOnExit, ...architectureRules, ...section02Rules, ...section03Rules, ...section04Rules, ...section05Rules, ...section06Rules, ...section07Rules, ...section08Rules, ...stateRules, ...errorRules, ...asyncRules, ...resourceRules, ...persistenceRules, ...queryRules, ...distributedRules, ...cacheRules, ...securityRules, ...privacyRules, ...httpRules, ...eventRules],
  formatRules: [preferEarlyReturn, nameCompoundConditions, separateResponsibilities],
};

export default aquariusRules;

