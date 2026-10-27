import type { LintRule } from "@aquarius/core";
import { ownershipOptionsSchema } from "./ownership-options";

export const releaseOnExit: LintRule = {
  id: "resource/release-on-exit",
  description: "Find owned resources left unreleased on a reachable exit.",
  scope: "module",
  defaultSeverity: "error",
  optionsSchema: ownershipOptionsSchema,
  defaultOptions: { allowOwnershipTransfer: false },
  buildPrompt: ({ options }) => ({
    applicability: "Code that owns a resource with an established release obligation before leaving its ownership scope.",
    criteria: "Report a reachable normal or exceptional exit that leaves an acquired, owned resource unreleased. Distinguish acquisition failure, borrowed resources, automatic cleanup, and host-specific lifetime guarantees. Do not assign a borrower's caller-owned release obligation to the borrower.",
    evidenceRequirements: [
      "Successful acquisition and ownership of the release obligation.",
      "A concrete reachable exit without the required release.",
      "Why automatic cleanup or an applicable responsibility transfer does not discharge the obligation.",
    ],
    exceptions: options.allowOwnershipTransfer === true
      ? ["A recipient has successfully accepted ownership and the release obligation under a proven transfer contract."]
      : [],
  }),
};
