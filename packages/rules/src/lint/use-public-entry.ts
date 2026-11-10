import { z } from "zod";
import type { LintRule } from "@aquarius/core";

export const usePublicEntry: LintRule = {
  id: "architecture/use-public-entry",
  description: "Find dependencies that bypass an established module's public entry.",
  scope: "project",
  optionsSchema: z
    .object({
      allowDocumentedException: z.boolean(),
    })
    .strict(),
  buildPrompt: ({ options }) => ({
    applicability:
      "Dependencies crossing module boundaries with a public entry contract.",
    criteria:
      "Report external consumers that bypass an established public entry and depend on private implementation. Resolve aliases and re-exports using the inspected project context. Internal imports within the same module are permitted. Do not invent module boundaries or require a specific language's filename convention.",
    evidenceRequirements: [
      "The consumer and provider belong to distinct module boundaries.",
      "The provider's supported public entry and applicable contract.",
      "The actual dependency path to private implementation.",
    ],
    exceptions:
      options.allowDocumentedException === true
        ? ["An applicable documented exception authorizes this exact dependency."]
        : [],
  }),
};
