import type { FormatRule } from "@aquarius/core";

export const nameCompoundConditions: FormatRule = {
  id: "readability/name-compound-conditions",
  description: "Give complex conditions meaningful names without changing evaluation.",
  scope: "file",
  buildPrompt: () => ({
    applicability: "A compound condition whose intent becomes clearer through a well-named local value or predicate.",
    transformation: "Extract an appropriately named condition or predicate where it clarifies the existing intent. Avoid redundant names for already clear simple conditions.",
    constraints: [
      "Preserve the exact evaluation condition, short-circuit order, number of evaluations, captured values, exceptions, and side effects.",
      "Do not eagerly evaluate a condition that was previously evaluated only inside a branch.",
      "Keep the existing public API and observable behavior.",
    ],
  }),
};
