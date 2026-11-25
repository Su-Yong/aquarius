import { z } from "zod";
import { createFormatRule, intRangeSchema, nonEmptyStringSchema } from "./shared";

const declarationStyleSchema = z.enum(["type", "interface", "preserve"]);
const declarationInstructions = {
  type: "use a type alias",
  interface: "use an interface",
  preserve: "preserve the current declaration form",
};

export const typeRules = [
  createFormatRule({
    id: "types/enforce-declaration-style",
    description:
      "Choose object declaration forms by role and extract repeated inline object types.",
    scope: "file",
    optionsSchema: z.strictObject({
      objectType: z
        .strictObject({
          publicContract: declarationStyleSchema.optional(),
          dataDto: declarationStyleSchema.optional(),
          default: declarationStyleSchema.optional(),
        })
        .optional(),
      extractRepeatedInline: z
        .strictObject({
          enabled: z.boolean(),
          minOccurrences: intRangeSchema(2).optional(),
        })
        .optional(),
    }),
    buildPrompt: ({
      objectType: { publicContract, dataDto, default: defaultStyle } = {},
      extractRepeatedInline: { enabled = true, minOccurrences = 2 } = {},
    }) => {
      const fallback = defaultStyle
        ? declarationInstructions[defaultStyle]
        : "follow the established project convention or preserve the existing form when unclear";
      return {
        applicability: "Object type declarations and repeated inline object types.",
        transformation: [
          `For object declarations without a role-specific setting, ${fallback}.`,
          ...(publicContract
            ? [`For public contracts, ${declarationInstructions[publicContract]}.`]
            : []),
          ...(dataDto ? [`For data transfer objects, ${declarationInstructions[dataDto]}.`] : []),
          enabled
            ? `Extract a named type in the same file when the same inline object type occurs at least ${minOccurrences} times and expresses the same concept.`
            : "Leave repeated inline object types in place.",
        ].join(" "),
        constraints: [
          "Preserve declaration merging and augmentation, public type compatibility, generic constraints, and type checking.",
          "Convert only equivalent object declarations supported by the target language. Keep type forms such as unions or mapped types where an interface cannot express them.",
        ],
      };
    },
  }),
  createFormatRule({
    id: "types/state-modeling",
    description: "Choose discriminated unions or flat optional fields for private state models.",
    scope: "module",
    optionsSchema: z.strictObject({
      prefer: z.enum(["discriminated-union", "flat-optional"]).optional(),
      tagField: nonEmptyStringSchema.optional(),
      excludeExported: z.boolean().optional(),
    }),
    buildPrompt: ({
      prefer = "discriminated-union",
      tagField = "status",
      excludeExported = true,
    }) => ({
      applicability:
        prefer === "discriminated-union"
          ? "Module-internal state objects with distinguishable variants encoded in flags or optional fields."
          : "Module-internal state unions with variants that can be represented by optional fields.",
      transformation: [
        prefer === "discriminated-union"
          ? `Model existing state variants with a discriminated union tagged by ${JSON.stringify(tagField)}. Make each variant's fields explicit.`
          : `Flatten a union discriminated by ${JSON.stringify(tagField)} into a single state type with optional variant-specific fields. Keep the tag wherever existing code observes it.`,
        excludeExported
          ? "Exclude all exported state types."
          : "Include exports used solely as implementation details within the module when all consumers can be updated safely.",
        "Update affected state construction and narrowing together.",
      ].join(" "),
      constraints: [
        "Preserve public API types and external JSON, database, and API representations.",
        "Preserve valid states, missing-field semantics, and checks for variant-specific values. Do not make an invalid transition possible.",
      ],
    }),
  }),
  createFormatRule({
    id: "types/type-guard-style",
    description:
      "Extract reusable runtime type guards or inline straightforward single-use guards.",
    scope: "file",
    optionsSchema: z.strictObject({
      prefer: z.enum(["extract-guards", "inline-simple"]).optional(),
      minOccurrences: intRangeSchema(2).optional(),
      minClauses: intRangeSchema(2).optional(),
    }),
    buildPrompt: ({ prefer = "extract-guards", minOccurrences = 2, minClauses = 3 }) => ({
      applicability:
        prefer === "extract-guards"
          ? "Repeated multi-clause runtime type checks."
          : "Simple private type guards used at a single call site.",
      transformation:
        prefer === "extract-guards"
          ? `Extract checks of at least ${minClauses} clauses that occur at least ${minOccurrences} times into a named private type guard in the same file.`
          : `Inline a single-use private type guard with fewer than ${minClauses} clauses when the caller retains equivalent narrowing.`,
      constraints: [
        "Preserve type narrowing, short-circuit and evaluation order, the number of checks, null handling, and prototype or own-property semantics.",
      ],
    }),
  }),
  createFormatRule({
    id: "types/internal-precision",
    description: "Narrow broad module-internal types when their valid values are established.",
    scope: "module",
    optionsSchema: z.strictObject({
      narrowStringLiterals: z.boolean().optional(),
      narrowLooseRecords: z.boolean().optional(),
      maxUnionMembers: intRangeSchema(2).optional(),
    }),
    buildPrompt: ({
      narrowStringLiterals = true,
      narrowLooseRecords = true,
      maxUnionMembers = 8,
    }) => ({
      applicability: "Broad internal string and record types with a demonstrably narrower domain.",
      transformation: [
        narrowStringLiterals
          ? `Narrow an internal string type to a proven finite literal union with at most ${maxUnionMembers} members.`
          : "Preserve broad internal string types.",
        narrowLooseRecords
          ? "Replace a loose internal record type with a named shape when the permitted keys and value types are known."
          : "Preserve loose internal record types.",
      ].join(" "),
      constraints: [
        "Preserve accepted external inputs, public signatures, type checks, and runtime behavior. Do not guess a closed domain or use assertions to bypass the original checks.",
      ],
    }),
  }),
];
