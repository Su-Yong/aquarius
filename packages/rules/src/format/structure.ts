import { z } from "zod";
import {
  createFormatRule,
  intRangeSchema,
  nonEmptyRecordSchema,
  nonEmptyStringArraySchema,
} from "./shared";

const propertyTargets = ["object-literals", "types", "interfaces", "config"] as const;
const preservedAbstractions = [
  "public-api",
  "di-ports",
  "test-mocks",
  "domain-predicates",
] as const;

export const structureRules = [
  createFormatRule({
    id: "structure/order-sections",
    description: "Order declarative sections by their role in a module, component, or class.",
    scope: "file",
    optionsSchema: z.strictObject({
      module: nonEmptyStringArraySchema.optional(),
      reactComponent: nonEmptyStringArraySchema.optional(),
      class: nonEmptyStringArraySchema.optional(),
      exportOrder: z.enum(["call-flow", "preserve", "alphabetical"]).optional(),
      groupGap: intRangeSchema(0, 2).optional(),
    }),
    buildPrompt: ({
      module: moduleSections = ["types", "constants", "public-exports", "private-helpers"],
      reactComponent,
      class: classSections,
      exportOrder = "call-flow",
      groupGap = 1,
    }) => {
      const exportInstructions = {
        "call-flow":
          "Order exports by call flow, placing exported entry points before the exported helpers they call.",
        preserve: "Preserve the relative order of exports.",
        alphabetical: "Order exports within their section alphabetically by exported name.",
      };
      return {
        applicability: "Files with identifiable module, React component, or class sections.",
        transformation: [
          `Arrange module sections according to these semantic labels in order: ${JSON.stringify(moduleSections)}.`,
          reactComponent
            ? `Arrange React component sections in this order: ${JSON.stringify(reactComponent)}.`
            : "Preserve the existing internal order of React components.",
          classSections
            ? `Arrange class sections in this order: ${JSON.stringify(classSections)}.`
            : "Preserve the existing internal order of classes.",
          exportInstructions[exportOrder],
          `Use ${groupGap} blank lines between configured section groups.`,
        ].join(" "),
        constraints: [
          "Preserve the order of top-level execution, React hooks and effects, class initialization, and any dependencies on temporal dead zones.",
          "Leave sections with ambiguous roles or conflicting group matches unchanged.",
        ],
      };
    },
  }),
  createFormatRule({
    id: "structure/order-properties",
    description: "Order properties by configured semantic profiles.",
    scope: "file",
    optionsSchema: z.strictObject({
      targets: z.array(z.enum(propertyTargets)).min(1).optional(),
      profiles: nonEmptyRecordSchema(nonEmptyStringArraySchema),
      unmatched: z.enum(["preserve", "alphabetical", "end"]).optional(),
    }),
    buildPrompt: ({
      targets = ["types", "interfaces", "object-literals"],
      profiles,
      unmatched = "preserve",
    }) => {
      const unmatchedInstructions = {
        preserve: "Keep unmatched properties in their current positions.",
        alphabetical:
          "Place unmatched properties after matched groups and sort them alphabetically.",
        end: "Place unmatched properties after matched groups in their existing relative order.",
      };
      return {
        applicability:
          "Configured property-bearing declarations that clearly match a semantic profile.",
        transformation: [
          `Apply property ordering only to these target kinds: ${JSON.stringify(targets)}.`,
          `Select the profile that matches the object's role and arrange properties by its ordered group labels: ${JSON.stringify(profiles)}.`,
          unmatchedInstructions[unmatched],
        ].join(" "),
        constraints: [
          "Leave the declaration unchanged when no profile matches clearly or multiple profiles conflict.",
          "Preserve computed key and value evaluation, spread and overwrite behavior, and any observable enumeration or serialization order, including test, signature, and hash inputs.",
        ],
      };
    },
  }),
  createFormatRule({
    id: "structure/declaration-placement",
    description: "Place local declarations near first use or at the top of their block.",
    scope: "file",
    optionsSchema: z.strictObject({
      style: z.enum(["colocate", "top-of-block"]).optional(),
      moveConstants: z.boolean().optional(),
    }),
    buildPrompt: ({ style = "colocate", moveConstants = true }) => ({
      applicability:
        style === "colocate"
          ? "Local declarations that can safely move closer to their first use."
          : "Local declarations that can safely move to the top of their enclosing block.",
      transformation: [
        style === "colocate"
          ? "Move a local declaration immediately before its first use within its current block where dependencies permit."
          : "Group local declarations at the top of their current block in dependency order.",
        moveConstants ? "Include eligible local constants." : "Keep local constants in place.",
      ].join(" "),
      constraints: [
        "Move only declarations with side-effect-free, non-throwing initializers whose inputs are unchanged across intervening statements.",
        "Preserve scope, initialization dependencies, and any conditional or repeated evaluation.",
      ],
    }),
  }),
  createFormatRule({
    id: "structure/abstraction-density",
    description: "Flatten eligible indirection or extract genuinely repeated internal behavior.",
    scope: "module",
    optionsSchema: z.strictObject({
      singleImplInterfaces: z.enum(["flatten", "preserve"]).optional(),
      passthroughWrappers: z.enum(["flatten", "preserve"]).optional(),
      repeatedBlocks: z
        .strictObject({
          action: z.enum(["extract", "preserve"]),
          minRepetitions: intRangeSchema(2).optional(),
        })
        .optional(),
      preserve: z.array(z.enum(preservedAbstractions)).optional(),
    }),
    buildPrompt: ({
      singleImplInterfaces = "flatten",
      passthroughWrappers = "flatten",
      repeatedBlocks: { action = "extract", minRepetitions = 3 } = {},
      preserve = preservedAbstractions,
    }) => ({
      applicability: "Module-internal interfaces, pass-through wrappers, and repeated code blocks.",
      transformation: [
        singleImplInterfaces === "flatten"
          ? "Replace an internal single-implementation interface with its concrete implementation where the interface provides no independent contract."
          : "Keep single-implementation interfaces in their current form.",
        passthroughWrappers === "flatten"
          ? "Bypass a private pass-through wrapper when it adds no behavior or meaningful boundary."
          : "Keep pass-through wrappers in their current form.",
        action === "extract"
          ? `Extract a shared helper for blocks expressing the same operation at least ${minRepetitions} times.`
          : "Keep repeated blocks in their current form.",
        `Exclude abstractions in these configured roles: ${JSON.stringify(preserve)}.`,
      ].join(" "),
      constraints: [
        "Preserve public APIs, plugin extension points, test dependency-injection and mock boundaries, and named domain predicates.",
        "Keep coincidentally similar code for distinct domain behaviors separate.",
      ],
    }),
  }),
  createFormatRule({
    id: "structure/flag-argument-style",
    description: "Use named operations or options objects for internal boolean flags.",
    scope: "module",
    optionsSchema: z.strictObject({
      literalCalls: z.enum(["split-functions", "options-object", "preserve"]).optional(),
      dynamicCalls: z.enum(["options-object", "preserve"]).optional(),
    }),
    buildPrompt: ({ literalCalls = "split-functions", dynamicCalls = "options-object" }) => {
      const literalInstructions = {
        "split-functions":
          "Replace literal flag calls with separate functions named for the operations.",
        "options-object":
          "Replace literal flag arguments with named properties in an options object.",
        preserve: "Keep existing literal flag calls in their current form.",
      };
      return {
        applicability:
          "Module-internal calls and functions that select behavior using boolean flags.",
        transformation: [
          literalInstructions[literalCalls],
          dynamicCalls === "options-object"
            ? "Pass a computed flag as a named property in an options object."
            : "Keep existing computed flag calls in their current form.",
          "Coordinate changes to private definitions and call sites so mixed literal and computed callers remain valid.",
        ].join(" "),
        constraints: [
          "Preserve public APIs, interface methods, fixed callback signatures, flag defaults, and argument evaluation order.",
        ],
      };
    },
  }),
  createFormatRule({
    id: "structure/io-core-separation",
    description: "Choose whether pure computation stays with I/O or lives in a functional core.",
    scope: "file",
    optionsSchema: z.strictObject({
      style: z.enum(["functional-core", "colocated"]).optional(),
      minPureLines: intRangeSchema(3).optional(),
      targetDomains: nonEmptyStringArraySchema.optional(),
    }),
    buildPrompt: ({ style = "functional-core", minPureLines = 10, targetDomains }) => ({
      applicability:
        style === "functional-core"
          ? "Functions that mix I/O with an extractable pure computation."
          : "I/O call sites with a local pure computation that can be kept nearby.",
      transformation: [
        `Consider pure computations of at least ${minPureLines} lines.`,
        targetDomains
          ? `Restrict the transformation to these semantic domains: ${JSON.stringify(targetDomains)}.`
          : "Consider computations in any domain.",
        style === "functional-core"
          ? "Extract the pure computation into a named function in the same file with explicit inputs and outputs. Keep I/O and nondeterministic reads in the calling function."
          : "Keep closely related pure calculations with their I/O. Bring an unnecessary single-use local pure helper back into its caller when the result remains clear.",
      ].join(" "),
      constraints: [
        "Preserve I/O order and conditions, short-circuit behavior, exception timing, and resource or transaction boundaries.",
        "Keep independently meaningful or shared helpers at their existing boundary.",
      ],
    }),
  }),
  createFormatRule({
    id: "structure/state-transition-style",
    description:
      "Consolidate internal state updates with transition helpers or an immutable reducer.",
    scope: "file",
    optionsSchema: z.strictObject({
      style: z.enum(["transition-helpers", "immutable-reducer"]).optional(),
      minFieldsPerTransition: intRangeSchema(2).optional(),
      minSites: intRangeSchema(2).optional(),
    }),
    buildPrompt: ({ style = "transition-helpers", minFieldsPerTransition = 2, minSites = 2 }) => ({
      applicability:
        style === "transition-helpers"
          ? "Repeated internal multi-field state transitions that can share a named helper."
          : "Internal multi-field state transitions that can share an immutable reducer.",
      transformation: [
        `Consider related transitions at ${minSites} or more sites that each update at least ${minFieldsPerTransition} fields.`,
        style === "transition-helpers"
          ? "Extract named transition helpers in the same file that apply the existing updates together."
          : "Represent transitions as actions and consolidate updates in a local reducer that returns the next state without mutating its input.",
      ].join(" "),
      constraints: [
        "Preserve state invariants, update and notification order, and any observable intermediate state.",
        "Keep a mutable object's existing update style when callers or external references depend on its identity.",
      ],
    }),
  }),
];
