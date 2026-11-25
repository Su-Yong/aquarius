import { z } from "zod";

import { createFormatRule, fileOverrideSchema, intRangeSchema } from "./shared";

const exitStyle = createFormatRule({
  id: "control-flow/exit-style",
  description: "Use early returns or a single function return point.",
  scope: "file",
  optionsSchema: z.strictObject({
    prefer: z.enum(["early-return", "single-exit"]).optional(),
    skipWhenCleanupPresent: z.boolean().optional(),
    minNestingDepth: intRangeSchema(1).optional(),
  }),
  buildPrompt: ({
    prefer = "early-return",
    skipWhenCleanupPresent = false,
    minNestingDepth = 2,
  }) => ({
    applicability:
      prefer === "early-return"
        ? "Functions with nested conditional branches and equivalent terminating paths."
        : "Functions with multiple return points, including early guard returns.",
    transformation: [
      prefer === "early-return"
        ? `Prefer early returns in branches with a nesting depth of at least ${minNestingDepth}. Place terminating or exceptional paths first as guard clauses and reduce indentation of the normal path.`
        : "Prefer a single exit. Consolidate early returns into one final return with branch-local computation and an appropriate result variable when needed.",
      skipWhenCleanupPresent
        ? "Skip functions with resource cleanup, including finally blocks and language-specific disposal scopes."
        : "Consider functions with cleanup only if all existing cleanup paths and their timing are demonstrably preserved.",
    ].join("\n"),
    constraints: [
      "Preserve evaluation order and the exact conditions under which each statement and cleanup path executes.",
      "Keep non-terminating branches non-terminating and preserve the order of finally blocks and resource release.",
    ],
  }),
});

const valueDispatch = {
  "lookup-map": "Use a Map lookup for pure mappings from known keys to values.",
  "lookup-object":
    "Use an object lookup with an own-key check for pure mappings from known keys to values.",
  switch: "Use an explicit switch for pure mappings from known keys to values.",
  "if-else": "Use an if/else chain for pure mappings from known keys to values.",
  preserve: "Keep the existing dispatch for pure value mappings.",
};

const unionDispatch = {
  switch: "Use a switch on the discriminant for discriminated union branches.",
  "if-else": "Use an if/else chain on the discriminant for discriminated union branches.",
  preserve: "Keep the existing dispatch for discriminated unions.",
};

const branchDispatch = createFormatRule({
  id: "control-flow/branch-dispatch",
  description: "Choose dispatch style for value, discriminant, and conditional branches.",
  scope: "file",
  optionsSchema: z.strictObject({
    pureValueMapping: z
      .enum(["lookup-map", "lookup-object", "switch", "if-else", "preserve"])
      .optional(),
    discriminatedUnion: z.enum(["switch", "if-else", "preserve"]).optional(),
    rangeOrCompound: z.enum(["if-else", "preserve"]).optional(),
    minCases: intRangeSchema(2).optional(),
  }),
  buildPrompt: ({
    pureValueMapping = "lookup-map",
    discriminatedUnion = "switch",
    rangeOrCompound = "if-else",
    minCases = 4,
  }) => ({
    applicability: `Dispatch for pure value mappings (${pureValueMapping}), discriminants (${discriminatedUnion}), or compound tests (${rangeOrCompound}).`,
    transformation: [
      `Consider only dispatches with at least ${minCases} cases.`,
      valueDispatch[pureValueMapping],
      unionDispatch[discriminatedUnion],
      rangeOrCompound === "if-else"
        ? "Use ordered if/else branches for ranges or compound predicates."
        : "Keep the existing dispatch for ranges or compound predicates.",
    ].join("\n"),
    constraints: [
      "Preserve branch order where comparisons overlap, lazy branch evaluation, discriminant narrowing, fall-through, and fallback behavior.",
      "A lookup must preserve original key equality, including missing keys versus present null or undefined values. Never match inherited object keys.",
    ],
  }),
});

const ternarySources = {
  "flatten-nested": "Nested ternary expressions.",
  "no-ternary": "Conditional expressions written with the ternary operator.",
  "prefer-concise": "Nested ternaries and simple if/else branches that choose one value.",
};

const ternaryTargets = {
  "if-else": "explicit if/else statements",
  "helper-function": "a focused helper function",
  lookup: "a lookup when the branches are a behavior-equivalent pure value mapping",
};

const ternaryStyle = createFormatRule({
  id: "control-flow/ternary-style",
  description: "Flatten, remove, or prefer concise ternary expressions.",
  scope: "file",
  optionsSchema: z.strictObject({
    mode: z.enum(["flatten-nested", "no-ternary", "prefer-concise"]).optional(),
    flattenTarget: z.enum(["if-else", "helper-function", "lookup"]).optional(),
    allowInJsx: z.boolean().optional(),
  }),
  buildPrompt: ({
    mode = "flatten-nested",
    flattenTarget = "helper-function",
    allowInJsx = true,
  }) => {
    const replacementStyle = ternaryTargets[flattenTarget];
    const transformationsByMode = {
      "flatten-nested": `Replace nested ternaries with ${replacementStyle}. Keep existing non-nested ternaries.`,
      "no-ternary": `Replace ternaries with ${replacementStyle}, including single-level ternaries.`,
      "prefer-concise": `Use a single ternary for a simple if/else that returns or assigns a value. Replace existing nested ternaries with ${replacementStyle}.`,
    };

    return {
      applicability:
        allowInJsx || mode === "no-ternary"
          ? ternarySources[mode]
          : `${ternarySources[mode]} Also consider single-level JSX ternaries.`,
      transformation: [
        transformationsByMode[mode],
        allowInJsx
          ? "Allow single-level ternaries in JSX as an exception."
          : `Replace JSX ternaries, including single-level ones, with ${replacementStyle}. Introduce no new ternaries in JSX.`,
      ].join("\n"),
      constraints: [
      ],
    };
  },
});

const loopGranularityModeSchema = z.enum(["split", "fuse"]);

const loopGranularity = createFormatRule({
  id: "control-flow/loop-granularity",
  description: "Split multi-purpose loops or fuse adjacent equivalent passes.",
  scope: "file",
  optionsSchema: z.strictObject({
    mode: loopGranularityModeSchema.optional(),
    excludeContexts: z.array(z.enum(["hot-path", "streaming"])).optional(),
    overrides: z.array(fileOverrideSchema({ mode: loopGranularityModeSchema })).optional(),
  }),
  buildPrompt: ({
    mode = "split",
    excludeContexts = ["hot-path", "streaming"],
    overrides = [],
  }) => {
    const transformationsByMode = {
      split:
        "Split a multi-purpose loop into independent passes, each focused on one responsibility.",
      fuse: "Fuse adjacent loops over the same collection into one pass when their work can be interleaved safely.",
    };

    const describeLoopApplicability = () => {
      if (overrides.length) {
        return "Multi-purpose loops and adjacent loops that traverse the same collection, subject to file overrides.";
      }
      if (mode === "split") {
        return "Loops combining independent responsibilities.";
      }
      return "Adjacent loops traversing the same collection.";
    };

    return {
      applicability: describeLoopApplicability(),
      transformation: [
        transformationsByMode[mode],
        `Skip loops in these contexts: ${JSON.stringify(excludeContexts)}.`,
        ...(overrides.length > 0
          ? [
              `For files matching these project-relative glob overrides, use the configured mode: ${JSON.stringify(overrides)}.`,
              `For split overrides: ${transformationsByMode.split} For fuse overrides: ${transformationsByMode.fuse}`,
            ]
          : []),
      ].join("\n"),
      constraints: [
        "Preserve traversal and side-effect order. Leave loops unchanged if they consume a one-shot iterator, mutate the source collection, or depend on work in another iteration or pass.",
        "When matching file overrides prescribe different modes, preserve the loop and report the conflict.",
      ],
    };
  },
});

const loopTermination = createFormatRule({
  id: "control-flow/loop-termination",
  description: "Choose direct loop exits or flag-controlled termination.",
  scope: "file",
  optionsSchema: z.strictObject({
    prefer: z.enum(["direct-exit", "flag-variable"]).optional(),
    preferCollectionSearch: z.boolean().optional(),
  }),
  buildPrompt: ({ prefer = "direct-exit", preferCollectionSearch = true }) => ({
    applicability:
      prefer === "direct-exit"
        ? "Loops whose termination is controlled by a flag variable."
        : "Loops that stop using a direct exit or a short-circuiting collection search.",
    transformation:
      prefer === "flag-variable"
        ? "Express loop termination with a meaningful flag variable in the loop condition, preserving the matching result and any enclosing function exit."
        : [
            "Replace flag-controlled termination with a direct break or return where equivalent.",
            preferCollectionSearch
              ? "Prefer an equivalent short-circuiting collection search such as find or some for simple searches."
              : "Keep explicit loop-based searches when changing their termination.",
          ].join("\n"),
    constraints: [
      "Preserve post-loop uses of the result or termination flag, the iteration count, the exit target, and any loop update or cleanup work.",
      "Preserve collection search semantics, including sparse entries, predicate evaluation, and the distinction between no match and a matched null or undefined value.",
    ],
  }),
});

const asyncStyle = createFormatRule({
  id: "control-flow/async-style",
  description: "Choose async/await or promise chains for asynchronous flows.",
  scope: "file",
  optionsSchema: z.strictObject({
    prefer: z.enum(["async-await", "promise-chain"]).optional(),
    minChainDepth: intRangeSchema(1).optional(),
    allowInlineFallbackCatch: z.boolean().optional(),
  }),
  buildPrompt: ({
    prefer = "async-await",
    minChainDepth = 2,
    allowInlineFallbackCatch = true,
  }) => ({
    applicability:
      prefer === "async-await"
        ? "Promise chains that can be expressed with async/await."
        : "Async/await sequences that can be expressed with a promise chain.",
    transformation: [
      prefer === "async-await"
        ? `Rewrite promise chains with at least ${minChainDepth} stages as async/await, using equivalent try/catch or finally handling where needed.`
        : "Rewrite eligible await sequences as promise chains with equivalent fulfillment, rejection, and cleanup handlers.",
      allowInlineFallbackCatch
        ? "Allow a simple inline catch that returns a fallback value."
        : "Use an explicit rejection-handling block or handler instead of an inline fallback catch when rewriting a flow.",
    ].join("\n"),
    constraints: [
      "Preserve the return promise contract, rejection values and propagation, catch/finally scope and ordering, and parallel work such as Promise.all.",
      "Keep the ordering of synchronous effects, promise scheduling, and asynchronous work when changing the flow.",
    ],
  }),
});

const errorScope = createFormatRule({
  id: "control-flow/error-scope",
  description: "Narrow catch boundaries or extract safe helpers from nested try blocks.",
  scope: "file",
  optionsSchema: z.strictObject({
    mode: z.enum(["narrow-try", "extract-safe-helper", "both"]).optional(),
    hoistPureSetup: z.boolean().optional(),
    hoistPurePostprocess: z.boolean().optional(),
  }),
  buildPrompt: ({ mode = "both", hoistPureSetup = true, hoistPurePostprocess = true }) => ({
    applicability:
      "Broad or nested try/catch blocks with separable setup, work, or postprocessing.",
    transformation: [
      ...(mode !== "extract-safe-helper"
        ? ["Narrow try blocks to operations that can trigger their handlers."]
        : []),
      ...(mode !== "narrow-try"
        ? [
            "Extract a focused helper for separable nested try/catch logic without moving exception boundaries.",
          ]
        : []),
      hoistPureSetup
        ? "When narrowing a try block, move pure non-throwing setup before it if the setup inputs are available there."
        : "Keep setup in its current exception boundary.",
      hoistPurePostprocess
        ? "When narrowing a try block, move pure non-throwing postprocessing onto the equivalent success path outside it."
        : "Keep postprocessing in its current exception boundary.",
    ].join("\n"),
    constraints: [
      "Preserve exactly which exceptions each handler catches, including exceptions from property access and implicit conversions.",
      "Preserve all finally blocks, evaluation order, and the conditions under which setup and postprocessing execute.",
    ],
  }),
});

const consolidateBranches = createFormatRule({
  id: "control-flow/consolidate-branches",
  description: "Share equivalent branch setup, final steps, or outcomes.",
  scope: "file",
  optionsSchema: z.strictObject({
    hoistCommonPrefix: z.boolean().optional(),
    hoistCommonSuffix: z.boolean().optional(),
    mergeIdenticalOutcomes: z.boolean().optional(),
    keepDistinctDomainBranches: z.boolean().optional(),
  }),
  buildPrompt: ({
    hoistCommonPrefix = true,
    hoistCommonSuffix = true,
    mergeIdenticalOutcomes = true,
    keepDistinctDomainBranches = true,
  }) => ({
    applicability: "Conditional branches with equivalent setup, final steps, or outcomes.",
    transformation: [
      hoistCommonPrefix
        ? "Hoist identical leading work to a point shared by all affected branches, keeping it after any conditions it depends on."
        : "Keep leading work inside its branch.",
      hoistCommonSuffix
        ? "Hoist identical trailing work to a common continuation reached on exactly the same paths."
        : "Keep trailing work inside its branch.",
      mergeIdenticalOutcomes
        ? "Merge branches with equivalent outcomes when their original conditions can be tested in the same order."
        : "Keep outcome branches separate.",
      keepDistinctDomainBranches
        ? "Keep different domain cases separate even if their current log or result is the same."
        : "Allow consolidation across domain cases when the complete branch behavior is equivalent.",
    ].join("\n"),
    constraints: [
      "Preserve condition evaluation order, bindings, fall-through, exception timing, and side-effect dependencies.",
    ],
  }),
});

export const controlFlowRules = [
  exitStyle,
  branchDispatch,
  ternaryStyle,
  loopGranularity,
  loopTermination,
  asyncStyle,
  errorScope,
  consolidateBranches,
];
