import type { LintRule } from "@aquarius/core";
import { ownershipOptionsSchema } from "./ownership-options";

export const noInputMutation: LintRule = {
  id: "contracts/no-input-mutation",
  description: "Find mutations that violate an input's immutability contract.",
  scope: "module",
  optionsSchema: ownershipOptionsSchema,
  buildPrompt: ({ options }) => ({
    applicability:
      "Code receiving read-only, borrowed, or immutable inputs.",
    criteria:
      "Report a violation when the input or a shared nested reference is mutated in breach of that contract. Local independent objects are not input mutations. Do not infer an immutability contract solely from parameter names.",
    evidenceRequirements: [
      "The applicable immutability contract, established by source, callers, API semantics, or existing documentation.",
      "The reference or alias relationship connecting the mutated object to the caller.",
      "The concrete mutation location and reachable path.",
    ],
    exceptions:
      options.allowOwnershipTransfer === true
        ? ["Exclusive ownership transfer is established and the transfer permits this mutation."]
        : [],
    procedure: [
      "Inspect relevant callers, aliases, shallow copies, and helper implementations. Inspect available callers and aliases, then report only established violations. Do not invent an immutability contract for an unsupported suspicion.",
    ],
  }),
};
