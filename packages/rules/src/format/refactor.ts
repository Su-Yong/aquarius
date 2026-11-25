import { z } from "zod";

import {
  createFormatRule,
  intRangeSchema,
  nonEmptyStringArraySchema,
  nonEmptyStringSchema,
  pathPatternArraySchema,
  pathPatternSchema,
} from "./shared";

export const refactorRules = createRefactorRules();

function createRefactorRules() {
  return [
    createParameterStyleRule(),
    createSeparateResponsibilitiesRule(),
    createDispatchArchitectureRule(),
    createDataRepresentationRule(),
    createDeduplicateInternalsRule(),
    createLayerDepthRule(),
  ];

  function createParameterStyleRule() {
    const optionsSchema = z.strictObject({
      prefer: z.enum(["options-object", "positional"]).optional(),
      maxPositionalParams: intRangeSchema(2).optional(),
      wrapBooleanFlags: z.boolean().optional(),
      unwrapMaxFields: intRangeSchema(1).optional(),
    });

    const buildParameterStyleInstructions = ({
      prefer = "options-object",
      maxPositionalParams = 3,
      wrapBooleanFlags = true,
      unwrapMaxFields = 2,
    }: z.output<typeof optionsSchema>) => {
      const flagPolicy = wrapBooleanFlags
        ? "Wrap positional boolean policy flags in named options regardless of argument count, and keep existing named flags when unwrapping other options."
        : "Treat boolean flags like other parameters when applying the selected style.";
      return {
        applicability:
          prefer === "options-object"
            ? "Internal functions with long positional signatures or boolean policy flags."
            : "Internal functions with small options objects and equivalent positional signatures.",
        transformation: [
          prefer === "options-object"
            ? `Group the arguments of internal functions with more than ${maxPositionalParams} positional parameters into a named options object. Update all internal callers together.`
            : `Unwrap internal options objects with at most ${unwrapMaxFields} fields into clear positional parameters. Update all internal callers together.`,
          flagPolicy,
        ].join(" "),
        constraints: [
          "Preserve public API signatures, fixed callback signatures, interface implementations, argument evaluation order, and default evaluation timing.",
          "Preserve the difference between omitted and explicitly supplied values and keep calls unambiguous.",
        ],
      };
    };

    return createFormatRule({
      id: "refactor/parameter-style",
      description: "Use the configured argument style for internal functions.",
      scope: "module",
      optionsSchema,
      buildPrompt: buildParameterStyleInstructions,
    });
  }

  function createSeparateResponsibilitiesRule() {
    const optionsSchema = z.strictObject({
      maxFunctionLines: intRangeSchema(20).optional(),
      maxFileLines: intRangeSchema(50).optional(),
      splitBuckets: nonEmptyStringArraySchema.optional(),
      preserveBarrelReExports: z.boolean().optional(),
    });

    const buildSeparateResponsibilitiesInstructions = ({
      maxFunctionLines = 100,
      maxFileLines = 400,
      splitBuckets = ["parse", "domain", "render", "io"],
      preserveBarrelReExports = true,
    }: z.output<typeof optionsSchema>) => ({
      applicability: "Long functions or files with distinct responsibilities.",
      transformation: [
        `Review functions over ${maxFunctionLines} lines and files over ${maxFileLines} lines for distinct responsibilities. Use these responsibility labels to guide cohesive splits: ${JSON.stringify(splitBuckets)}.`,
        "Follow the existing project structure. Prefer named functions in the same file when sufficient. Use separate modules when a real responsibility boundary benefits from it and keep orchestration at its existing boundary.",
        preserveBarrelReExports
          ? "Keep existing barrel re-exports and re-export relocated public declarations from their original entry points."
          : "Allow changes to internal barrel re-exports when all internal references can be updated together. Keep original public entry points and exports.",
      ].join(" "),
      constraints: [
        "Preserve public entry points and export paths, return values, error behavior, state sharing, side effects, evaluation order, resource ownership, and try/finally and transaction boundaries.",
        "Update all affected internal references together. Leave business behavior and unrelated defects untouched.",
        "Avoid new dependencies, circular references, speculative extension points, and unnecessary files.",
        "If preservation cannot be established, leave the change unapplied and explain the limitation in a warning.",
      ],
    });

    return createFormatRule({
      id: "refactor/separate-responsibilities",
      description: "Separate responsibilities while preserving behavior and public contracts.",
      scope: "module",
      optionsSchema,
      buildPrompt: buildSeparateResponsibilitiesInstructions,
    });
  }

  function createDispatchArchitectureRule() {
    const optionsSchema = z.strictObject({
      prefer: z.enum(["strategy-map", "cohesive-switches"]).optional(),
      minRepeatedSwitches: intRangeSchema(2).optional(),
      maxCasesForSwitch: intRangeSchema(2).optional(),
    });

    const buildDispatchArchitectureInstructions = ({
      prefer = "strategy-map",
      minRepeatedSwitches = 3,
      maxCasesForSwitch = 5,
    }: z.output<typeof optionsSchema>) => ({
      applicability:
        prefer === "strategy-map"
          ? "Repeated switches on the same discriminator across a module."
          : "Small internal handler maps that scatter a cohesive dispatch operation.",
      transformation:
        prefer === "strategy-map"
          ? `When at least ${minRepeatedSwitches} switches repeat dispatch on the same discriminator for related operations, consolidate the case logic in a strategy handler map keyed by that discriminator.`
          : `Fold a fragmented handler map with at most ${maxCasesForSwitch} cases into cohesive, explicit switches where keeping the case logic together makes the dispatch easier to follow.`,
      constraints: [
        "Preserve every case's fallback, exceptions, exhaustive type checking, evaluation order, and handler lifetime. Keep genuinely separate dispatch policies separate.",
      ],
    });

    return createFormatRule({
      id: "refactor/dispatch-architecture",
      description: "Use coherent strategies or explicit switches for internal dispatch.",
      scope: "module",
      optionsSchema,
      buildPrompt: buildDispatchArchitectureInstructions,
    });
  }

  function createDataRepresentationRule() {
    const optionsSchema = z.strictObject({
      parallelArrays: z.enum(["to-records", "preserve"]).optional(),
      dataClumps: z
        .strictObject({
          action: z.enum(["to-value-object", "preserve"]),
          minFields: intRangeSchema(2).optional(),
          minOccurrences: intRangeSchema(2).optional(),
        })
        .optional(),
      pipelineStages: z.enum(["extract", "preserve"]).optional(),
      exclude: pathPatternArraySchema.optional(),
    });

    const buildDataRepresentationInstructions = ({
      parallelArrays = "to-records",
      dataClumps: { action: dataClumpAction, minFields = 2, minOccurrences = 3 } = {
        action: "to-value-object",
      },
      pipelineStages = "extract",
      exclude = [],
    }: z.output<typeof optionsSchema>) => ({
      applicability: "Internal parallel arrays, repeated field groups, or multi-stage data loops.",
      transformation: [
        parallelArrays === "to-records"
          ? "Replace internal parallel arrays with records when their fields represent the same entity and corresponding indices can be preserved."
          : "Keep the current representation of parallel arrays.",
        dataClumpAction === "to-value-object"
          ? `Group at least ${minFields} semantically related fields into a value object when they occur together at least ${minOccurrences} times.`
          : "Keep repeated field groups in their current representation.",
        pipelineStages === "extract"
          ? "Extract named data-processing stages where one loop interleaves distinct responsibilities and stage separation is behaviorally equivalent."
          : "Keep the current grouping of pipeline stages.",
      ].join(" "),
      constraints: [
        `Leave paths matching these project-relative exclusions unchanged: ${JSON.stringify(exclude)}.`,
        "Preserve serialization and public data shapes, index alignment, aliasing, mutation semantics, and performance-sensitive structure-of-arrays layouts.",
      ],
    });

    return createFormatRule({
      id: "refactor/data-representation",
      description: "Simplify internal data representations and make pipeline stages explicit.",
      scope: "module",
      optionsSchema,
      buildPrompt: buildDataRepresentationInstructions,
    });
  }

  function createDeduplicateInternalsRule() {
    const optionsSchema = z.strictObject({
      minDuplicates: intRangeSchema(2).optional(),
      targetFile: pathPatternSchema.optional(),
      pureUtilitiesOnly: z.boolean().optional(),
    });

    const buildDeduplicateInternalsInstructions = ({
      minDuplicates = 2,
      targetFile,
      pureUtilitiesOnly = true,
    }: z.output<typeof optionsSchema>) => ({
      applicability: "Equivalent internal utilities duplicated across files in one module.",
      transformation: [
        `When at least ${minDuplicates} copies of a utility implement the same contract across files in a module, consolidate them into a single internal utility and update every affected import.`,
        targetFile === undefined
          ? "Use the module's existing utility location conventions."
          : `Use the configured destination ${JSON.stringify(targetFile)} within the selected module. Leave the code unchanged and warn if it cannot be used safely.`,
        pureUtilitiesOnly
          ? "Consolidate only pure utilities."
          : "Consider effectful utilities only when every affected caller retains the same effects, timing, and ownership.",
      ].join(" "),
      constraints: [
        "Preserve distinct domain policies whose implementations only happen to look alike. Avoid introducing dependency cycles.",
      ],
    });

    return createFormatRule({
      id: "refactor/deduplicate-internals",
      description: "Consolidate equivalent internal utilities within a module.",
      scope: "module",
      optionsSchema,
      buildPrompt: buildDeduplicateInternalsInstructions,
    });
  }

  function createLayerDepthRule() {
    const optionsSchema = z.strictObject({
      mode: z.enum(["flatten-middle-man", "enforce-facade"]).optional(),
      preserveLayers: z.array(nonEmptyStringSchema).optional(),
    });

    const buildLayerDepthInstructions = ({
      mode = "flatten-middle-man",
      preserveLayers = ["ports", "adapters", "public-facade"],
    }: z.output<typeof optionsSchema>) => ({
      applicability:
        mode === "flatten-middle-man"
          ? "Internal forwarding layers that add no behavior or intentional boundary."
          : "Modules whose consumers directly access multiple internal implementation files.",
      transformation:
        mode === "flatten-middle-man"
          ? "Redirect callers of redundant internal forwarding layers to the actual implementation. Remove a forwarding layer only after every affected reference has been updated."
          : "Route consumers of internal implementation files through a cohesive module facade. Keep internal implementations behind that facade without broadening the public API.",
      constraints: [
        `Preserve layers matching these configured labels: ${JSON.stringify(preserveLayers)}.`,
        "Keep intentional architecture ports, adapters, and public facades. Preserve dependency direction, injection seams, and dispatch and initialization semantics.",
      ],
    });

    return createFormatRule({
      id: "refactor/layer-depth",
      description: "Remove redundant forwarding layers or organize access through a facade.",
      scope: "module",
      optionsSchema,
      buildPrompt: buildLayerDepthInstructions,
    });
  }
}
