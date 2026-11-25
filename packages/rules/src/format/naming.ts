import { z } from "zod";
import {
  createFormatRule,
  intRangeSchema,
  nonEmptyStringArraySchema,
  nonEmptyStringSchema,
  stringKeyRecordSchema,
} from "./shared";

const enforceConvention = createFormatRule({
  id: "naming/enforce-convention",
  description: "Apply configured boolean names, role-specific verbs, and domain terms internally.",
  scope: "module",
  optionsSchema: z.strictObject({
    booleans: z
      .strictObject({
        style: z.enum(["positive", "preserve"]),
        prefixes: nonEmptyStringArraySchema.optional(),
      })
      .optional(),
    verbs: z
      .strictObject({
        asyncRead: nonEmptyStringSchema.optional(),
        syncRead: nonEmptyStringSchema.optional(),
        write: nonEmptyStringSchema.optional(),
        construct: nonEmptyStringSchema.optional(),
        eventHandler: nonEmptyStringSchema.optional(),
        predicate: nonEmptyStringSchema.optional(),
        assert: nonEmptyStringSchema.optional(),
      })
      .optional(),
    glossary: stringKeyRecordSchema(nonEmptyStringSchema).optional(),
  }),
  buildPrompt: ({
    booleans: { style = "positive", prefixes = ["is", "has", "can", "should"] } = {},
    verbs = {},
    glossary = {},
  }) => ({
    applicability:
      "Private module names governed by boolean, role-verb, or domain terminology conventions.",
    transformation: [
      style === "positive"
        ? `Prefer positive boolean names with a fitting prefix from ${JSON.stringify(prefixes)}. Update all internal uses consistently if polarity is reversed.`
        : "Preserve existing boolean naming and polarity.",
      `Use the configured verb prefix for each matching function role: ${JSON.stringify(verbs)}. Keep roles that have no configured prefix unchanged.`,
      `Use this glossary to replace matching domain terms in private identifiers: ${JSON.stringify(glossary)}. Apply each replacement by meaning and update internal references together.`,
    ].join(" "),
    constraints: [
      "Preserve public exports, public class members, database and JSON keys, destructured property names, and all names used by external callers or reflection.",
      "Keep the current name when applying a naming convention would introduce ambiguity or a binding collision.",
    ],
  }),
});

const magicValueCategory = z.enum([
  "duration",
  "byte-size",
  "retry-limit",
  "business-threshold",
  "regex",
]);
const defaultIgnoredValues = [0, 1, -1, "", 200, 201, 204, 400, 401, 403, 404, 500];

const magicValues = createFormatRule({
  id: "naming/magic-values",
  description: "Name literals whose meaning depends on domain or unit context.",
  scope: "file",
  optionsSchema: z.strictObject({
    categories: z.array(magicValueCategory).min(1).optional(),
    placement: z.enum(["module-top", "colocated"]).optional(),
    expressionStyle: z.enum(["computed-units", "plain-literal"]).optional(),
    ignoreValues: z.array(z.union([z.number(), z.string()])).optional(),
  }),
  buildPrompt: ({
    categories = magicValueCategory.options,
    placement = "module-top",
    expressionStyle = "computed-units",
    ignoreValues = defaultIgnoredValues,
  }) => {
    const ignoredLiterals = ignoreValues.map((value) =>
      Object.is(value, -0) ? "-0" : JSON.stringify(value),
    );
    return {
      applicability:
        "Literals that encode a configured domain concept or unit without a clear name.",
      transformation: [
        `Extract named constants for opaque literals in these categories: ${JSON.stringify(categories)}. Exclude these exact values: [${ignoredLiterals.join(",")}].`,
        placement === "module-top"
          ? "Place new constants at module top level where initialization timing can be preserved."
          : "Place new constants near their usage in the narrowest safe scope.",
        expressionStyle === "computed-units"
          ? "Use exact unit-based expressions for durations and sizes when they make the intended value clearer."
          : "Use plain literal initializers without introducing unit computations.",
      ].join(" "),
      constraints: [
        "Preserve exact values, numeric and string types, regex semantics, and any runtime identity or mutable state of extracted literals.",
      ],
    };
  },
});

const callbackStyle = createFormatRule({
  id: "naming/callback-style",
  description: "Choose named local callbacks or inline arrows for one-use callbacks.",
  scope: "file",
  optionsSchema: z.strictObject({
    prefer: z.enum(["named-functions", "inline-arrows"]).optional(),
    minLines: intRangeSchema(2).optional(),
    alwaysName: z.array(z.enum(["event-listener", "timer", "transaction"])).optional(),
  }),
  buildPrompt: ({ prefer = "named-functions", minLines = 6, alwaysName = ["event-listener"] }) => ({
    applicability:
      prefer === "named-functions"
        ? "Inline callbacks that meet the configured line or context criteria."
        : "Single-use named callbacks short enough to inline and callbacks in configured naming contexts.",
    transformation: [
      prefer === "named-functions"
        ? `Extract inline callbacks of at least ${minLines} lines into meaningfully named local functions.`
        : `Inline a single-use named callback as an arrow where supported when its body is shorter than ${minLines} lines and its name adds no useful context.`,
      `Use named callbacks in these contexts regardless of length or general preference: ${JSON.stringify(alwaysName)}.`,
    ].join(" "),
    constraints: [
      "Preserve closure captures, this binding, arguments and return behavior, callback identity, and registration or removal semantics.",
    ],
  }),
});

const identifierClarity = createFormatRule({
  id: "naming/identifier-clarity",
  description: "Use descriptive or concise names for local variables and private helpers.",
  scope: "file",
  optionsSchema: z.strictObject({
    verbosity: z.enum(["descriptive", "concise"]).optional(),
    allowedShortNames: z.array(nonEmptyStringSchema).optional(),
    maxWords: intRangeSchema(2).optional(),
  }),
  buildPrompt: ({
    verbosity = "descriptive",
    allowedShortNames = ["i", "j", "k", "e", "err", "id", "fn"],
    maxWords = 4,
  }) => ({
    applicability:
      verbosity === "descriptive"
        ? "Local variables and private helpers with ambiguous or uninformative names."
        : "Local variables and private helpers with unnecessarily long names.",
    transformation: [
      verbosity === "descriptive"
        ? "Give unclear identifiers descriptive names that convey their domain role or the action they perform."
        : `Use concise names of at most ${maxWords} words where the shorter name still conveys its role.`,
      `Keep conventional short names from this list when their meaning is clear: ${JSON.stringify(allowedShortNames)}. Update safely resolved local references with each rename.`,
    ].join(" "),
    constraints: [
      "Preserve public symbols, serialization keys, destructured property names, externally observed names, and identifier binding and resolution.",
    ],
  }),
});

export const namingRules = [enforceConvention, magicValues, callbackStyle, identifierClarity];
