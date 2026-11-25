import { z } from "zod";

import {
  createFormatRule,
  intRangeSchema,
  nonEmptyStringArraySchema,
  nonEmptyStringSchema,
  pathPatternArraySchema,
  pathPatternSchema,
} from "./shared";

const preserveProjectEntrypoints =
  "Preserve public paths and package exports, framework convention files such as routes, CLI entry points, and configuration files. Keep such files in their required locations.";

const cycleStrategies = {
  "extract-shared-types":
    "Extract shared type declarations into a lower-level module and use type-only dependencies where supported and equivalent.",
  "extract-shared-module":
    "Extract the shared implementation into a lower-level module that does not depend on the original modules.",
  "invert-dependency":
    "Invert the dependency through a consumer-owned contract and pass the concrete dependency from the established composition boundary.",
};

export const architectureFormatRules = [
  createFormatRule({
    id: "architecture/enforce-layout",
    description: "Follow the configured project layout and file naming conventions.",
    scope: "project",
    optionsSchema: z.strictObject({
      style: z.enum(["feature-colocated", "layered"]).optional(),
      fileNaming: z.enum(["kebab-case", "camelCase", "snake_case", "preserve"]).optional(),
      featureDir: pathPatternSchema.optional(),
      standardFiles: nonEmptyStringArraySchema.optional(),
      colocateSingleConsumerFiles: z.boolean().optional(),
      exclude: pathPatternArraySchema.optional(),
    }),
    buildPrompt: ({
      style = "feature-colocated",
      fileNaming = "preserve",
      featureDir,
      standardFiles,
      colocateSingleConsumerFiles = true,
      exclude = [],
    }) => {
      const featureLocation =
        featureDir === undefined
          ? "Use existing feature directory conventions."
          : `Use ${JSON.stringify(featureDir)} as the configured project-relative location for feature directories, substituting the existing feature name where a {feature} placeholder is present.`;

      return {
        applicability:
          style === "feature-colocated"
            ? "Project files whose established feature ownership or naming suggests a layout change."
            : "Project files whose established layer responsibilities or naming suggest a layout change.",
        transformation: [
          style === "feature-colocated"
            ? `Group internal files by the feature they serve. ${featureLocation}`
            : "Group internal files by their established architectural layers.",
          fileNaming === "preserve"
            ? "Keep existing file name casing."
            : `Use ${fileNaming} for internal file names where renaming is safe.`,
          standardFiles === undefined
            ? "Follow existing conventions for standard file names."
            : `Use these standard file names for matching roles: ${JSON.stringify(standardFiles)}. Keep each file's existing extension and avoid creating empty scaffold files.`,
          colocateSingleConsumerFiles
            ? "Place a private file beside its sole consumer when the configured layout and ownership boundaries allow it."
            : "Leave placement unchanged when a single consumer is the only reason to move a file.",
          "Update all affected internal references as part of a move or rename.",
        ].join(" "),
        constraints: [
          preserveProjectEntrypoints,
          `Leave files matching these project-relative exclusions unchanged: ${JSON.stringify(exclude)}.`,
          "Preserve resolution, module identity, and initialization order. Leave a file in place and warn when dependent references cannot be updated safely within the permitted change scope.",
        ],
      };
    },
  }),
  createFormatRule({
    id: "architecture/break-internal-cycles",
    description: "Break internal dependency cycles using the configured strategy.",
    scope: "project",
    optionsSchema: z.strictObject({
      strategy: z
        .enum(["extract-shared-types", "extract-shared-module", "invert-dependency"])
        .optional(),
      extractedFilename: nonEmptyStringSchema.optional(),
    }),
    buildPrompt: ({ strategy = "extract-shared-types", extractedFilename = "types.ts" }) => ({
      applicability: "Cycles between internal project modules with a separable dependency.",
      transformation: [
        cycleStrategies[strategy],
        `When the selected strategy extracts a file, use ${JSON.stringify(extractedFilename)} as its filename if it is valid and available inside the permitted project scope.`,
        "Update affected internal references together and verify that the resulting dependency graph breaks the cycle.",
      ].join(" "),
      constraints: [
        preserveProjectEntrypoints,
        "Preserve runtime and type-only dependency semantics. Leave cycles that rely on top-level initialization or side-effect order unchanged and report a warning.",
      ],
    }),
  }),
  createFormatRule({
    id: "architecture/shared-utilities-policy",
    description: "Consolidate equivalent shared utilities into the configured directory.",
    scope: "project",
    optionsSchema: z.strictObject({
      minModules: intRangeSchema(2).optional(),
      sharedDir: pathPatternSchema,
      pureUtilitiesOnly: z.boolean().optional(),
      exclude: pathPatternArraySchema.optional(),
    }),
    buildPrompt: ({ minModules = 3, sharedDir, pureUtilitiesOnly = true, exclude = [] }) => ({
      applicability: "Equivalent utilities duplicated in several project modules.",
      transformation: [
        `When at least ${minModules} modules duplicate a utility with the same proven contract, consolidate it under the configured shared directory ${JSON.stringify(sharedDir)} and update all affected internal imports.`,
        pureUtilitiesOnly
          ? "Consolidate only pure utilities."
          : "Consider effectful utilities only when their dependencies, initialization, and behavior can be preserved at all call sites.",
      ].join(" "),
      constraints: [
        preserveProjectEntrypoints,
        `Leave files matching these project-relative exclusions unchanged: ${JSON.stringify(exclude)}.`,
        "Preserve the project's allowed dependency directions. Do not introduce cycles or merge distinct domain policies that happen to have similar implementations.",
      ],
    }),
  }),
];
