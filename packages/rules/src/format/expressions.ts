import { z } from "zod";
import { createFormatRule, fileOverrideSchema, intRangeSchema } from "./shared";

const iterationPreference = z.enum(["pipeline", "imperative"]);

const iterationStyle = createFormatRule({
  id: "expressions/iteration-style",
  description: "Choose a pipeline or an imperative loop for collection transformations.",
  scope: "file",
  optionsSchema: z.strictObject({
    prefer: iterationPreference.optional(),
    maxChainLength: intRangeSchema(1).optional(),
    overrides: z.array(fileOverrideSchema({ prefer: iterationPreference })).optional(),
  }),
  buildPrompt: ({ prefer = "pipeline", maxChainLength = 3, overrides = [] }) => {
    const pipeline = `Prefer declarative pipelines for simple transformations with at most ${maxChainLength} collection stages. Keep or use an imperative loop above that limit.`;
    const imperative =
      "Prefer a clear imperative loop for collection transformations currently expressed as pipelines.";
    const transformation = prefer === "pipeline" ? pipeline : imperative;
    if (overrides.length > 0) {
      return {
        applicability:
          "Collection loops and pipelines in files covered by the default or a path override.",
        transformation: [
          `Default for unmatched files: ${transformation}`,
          `Match project-relative file paths against these overrides: ${JSON.stringify(overrides)}. Apply the matching preference in place of the default. If matching preferences conflict, preserve the existing code and report a warning.`,
          `For "pipeline": ${pipeline} For "imperative": ${imperative}`,
        ].join(" "),
        constraints: iterationConstraints,
      };
    }
    return {
      applicability:
        prefer === "pipeline"
          ? "Simple collection loops and pipelines exceeding the configured chain length."
          : "Declarative collection pipelines that can be expressed as imperative loops.",
      transformation,
      constraints: iterationConstraints,
    };
  },
});

const iterationConstraints = [
  "Preserve await and early break or return semantics, source mutations, sparse-array handling, callback inputs, iteration order, and the sequence of effects across stages.",
];

const stepGranularity = createFormatRule({
  id: "expressions/step-granularity",
  description: "Choose whether to name intermediate steps or inline simple one-use expressions.",
  scope: "file",
  optionsSchema: z.strictObject({
    prefer: z.enum(["extract-steps", "inline-compact"]).optional(),
    maxNestingDepth: intRangeSchema(1).optional(),
    preserveDomainNamedTemps: z.boolean().optional(),
  }),
  buildPrompt: ({
    prefer = "extract-steps",
    maxNestingDepth = 2,
    preserveDomainNamedTemps = true,
  }) => ({
    applicability:
      prefer === "extract-steps"
        ? "Nested expressions that obscure separate steps in a computation."
        : "Simple expressions split across single-use temporary bindings.",
    transformation:
      prefer === "extract-steps"
        ? `Extract meaningful named intermediate steps when expression nesting exceeds ${maxNestingDepth} levels.`
        : `Inline single-use intermediates when the resulting expression is clear and stays within ${maxNestingDepth} levels of nesting.`,
    constraints: [
      "Preserve argument evaluation order, side-effect timing, and evaluation count. Keep every expression within its original execution condition.",
      preserveDomainNamedTemps
        ? "Preserve temporary names that communicate a domain concept."
        : "A domain-named temporary may be inlined when the resulting expression still conveys the same intent.",
    ],
  }),
});

const branchAssignmentInstructions = {
  helper:
    "Replace declaration followed by branch assignments with a named helper that returns the selected value.",
  ternary:
    "Replace simple branch assignments with a conditional expression that initializes the binding once.",
  preserve: "Preserve existing branch assignments.",
};

const variableMutability = createFormatRule({
  id: "expressions/variable-mutability",
  description: "Use distinct immutable bindings for values that represent different steps.",
  scope: "file",
  optionsSchema: z.strictObject({
    splitReusedVariables: z.boolean().optional(),
    replaceBranchAssignment: z.enum(["helper", "ternary", "preserve"]).optional(),
    ignoreLoopAccumulators: z.boolean().optional(),
  }),
  buildPrompt: ({
    splitReusedVariables = true,
    replaceBranchAssignment = "helper",
    ignoreLoopAccumulators = true,
  }) => ({
    applicability: "Reused local bindings and bindings initialized by branch assignments.",
    transformation: [
      splitReusedVariables
        ? "Split reused variables into immutable bindings named for the meanings of their values."
        : "Leave variable reuse unchanged unless the configured branch-assignment rewrite applies.",
      branchAssignmentInstructions[replaceBranchAssignment],
    ].join(" "),
    constraints: [
      "Preserve shared mutable state, including bindings captured by closures, and the value accumulation and update order of real accumulators.",
      ignoreLoopAccumulators
        ? "Exclude loop accumulators from changes."
        : "Review loop bindings for safe splits of unrelated roles while preserving intentional accumulation.",
    ],
  }),
});

const objectBuildStyle = createFormatRule({
  id: "expressions/object-build-style",
  description: "Choose declarative object construction or explicit property assignments.",
  scope: "file",
  optionsSchema: z.strictObject({
    prefer: z.enum(["declarative", "step-by-step"]).optional(),
    maxConditionalPropsForDeclarative: intRangeSchema(1).optional(),
  }),
  buildPrompt: ({ prefer = "declarative", maxConditionalPropsForDeclarative = 4 }) => ({
    applicability:
      prefer === "declarative"
        ? "Objects built through conditional property assignments."
        : "Objects built with conditional properties inside a declarative expression.",
    transformation:
      prefer === "declarative"
        ? `Build the object declaratively using conditional spreads or the equivalent for the language when it has at most ${maxConditionalPropsForDeclarative} conditional properties. Leave existing constructions unchanged above this limit.`
        : "Build the base object first, then use explicit conditional assignments for optional properties.",
    constraints: [
      "Preserve property insertion and overwrite order, absence versus undefined, property descriptors, and effects of getters, setters, and computed keys.",
    ],
  }),
});

const regexStyles = {
  "compose-parts": {
    applicability: "Complex regular expressions with independently meaningful parts.",
    transformation: "Compose the expression from named pattern parts for distinct roles.",
  },
  "named-groups": {
    applicability: "Complex regular expressions with captures that benefit from meaningful names.",
    transformation:
      "Use named capture groups when supported and when existing numeric capture positions and consumers are preserved.",
  },
  "string-parser": {
    applicability:
      "Complex regular expressions whose matching can be expressed as clear string parsing.",
    transformation:
      "Use explicit string parsing only when it can reproduce the complete observable matching contract.",
  },
};

const regexReadability = createFormatRule({
  id: "expressions/regex-readability",
  description: "Make complex regular expressions and their capture roles easier to read.",
  scope: "file",
  optionsSchema: z.strictObject({
    mode: z.enum(["compose-parts", "named-groups", "string-parser"]).optional(),
    minLength: intRangeSchema(10).optional(),
    minGroups: intRangeSchema(1).optional(),
  }),
  buildPrompt: ({ mode = "compose-parts", minLength = 45, minGroups = 3 }) => ({
    applicability: regexStyles[mode].applicability,
    transformation: `${regexStyles[mode].transformation} Apply the change to patterns at least ${minLength} characters long with at least ${minGroups} groups.`,
    constraints: [
      "Preserve the set of accepted inputs, match boundaries, capture values and numbering, flags, escaping, and state such as lastIndex.",
      "Keep externally observed match result shapes and regular expression APIs unchanged.",
    ],
  }),
});

const conditionReadability = createFormatRule({
  id: "expressions/condition-readability",
  description: "Name complex conditions or inline simple ones without changing evaluation.",
  scope: "file",
  optionsSchema: z.strictObject({
    prefer: z.enum(["named-variables", "predicate-functions", "inline-simple"]).optional(),
    minClauses: intRangeSchema(2).optional(),
    maxInlineClauses: intRangeSchema(1).optional(),
  }),
  buildPrompt: ({ prefer = "named-variables", minClauses = 3, maxInlineClauses = 2 }) => {
    const styles = {
      "named-variables": {
        applicability: "Inline compound conditions with multiple logical clauses.",
        transformation: `Extract a named local binding for a boolean test with at least ${minClauses} logical clauses when the name clarifies intent.`,
      },
      "predicate-functions": {
        applicability: "Compound conditions that can be expressed as named predicates.",
        transformation: `Extract a named predicate function for conditions with at least ${minClauses} logical clauses. Call it at the original evaluation point.`,
      },
      "inline-simple": {
        applicability:
          "Simple conditions hidden behind redundant local bindings or one-use predicates.",
        transformation: `Inline redundant local condition bindings or one-use predicates with at most ${maxInlineClauses} logical clauses when inlining clarifies the condition.`,
      },
    };
    return {
      ...styles[prefer],
      constraints: [
        "Preserve the exact evaluation condition, short-circuit order, number of evaluations, captured values, exceptions, and side effects.",
        "Evaluate the condition only when the original code did. Keep already clear simple conditions free of redundant names.",
      ],
    };
  },
});

export const expressionRules = [
  iterationStyle,
  stepGranularity,
  variableMutability,
  objectBuildStyle,
  regexReadability,
  conditionReadability,
];
