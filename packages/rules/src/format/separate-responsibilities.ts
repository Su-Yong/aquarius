import type { FormatRule } from "@aquarius/core";

export const separateResponsibilities: FormatRule = {
  id: "refactor/separate-responsibilities",
  description: "Separate responsibilities while preserving behavior and public contracts.",
  scope: "module",
  buildPrompt: () => ({
    applicability: "Code with distinct responsibilities that can be separated without changing its externally observed behavior.",
    transformation: "Follow the existing project structure. Prefer named functions in the same file when sufficient; use separate modules when a real responsibility boundary benefits from it. Keep orchestration where it belongs.",
    constraints: [
      "Preserve public entry points, return values, error behavior, state sharing, side effects, evaluation order, and resource ownership.",
      "Update all affected internal references together. Do not change business behavior or repair unrelated defects.",
      "Do not add dependencies, speculative extension points, or unnecessary files.",
      "If preservation cannot be established, leave that transformation unapplied and explain the limitation.",
    ],
  }),
};
