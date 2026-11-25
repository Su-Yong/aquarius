import { z } from "zod";
import {
  createFormatRule,
  intRangeSchema,
  nonEmptyStringArraySchema,
  nonEmptyStringSchema,
  pathPatternArraySchema,
} from "./shared";

const defaultImportOrder = [
  "side-effect",
  "builtin",
  "external",
  "workspace",
  "parent",
  "sibling",
  "index",
];

const typeImportPlacement = {
  inline: "Keep type-only imports in their groups and sort them with value imports.",
  "bottom-of-group": "Place type-only imports after value imports in each group.",
  "top-of-group": "Place type-only imports before value imports in each group.",
  "separate-group":
    "Collect type-only imports in a separate group, preserving its existing placement where possible.",
};

const withinGroupSorting = {
  alphabetical: "Sort imports alphabetically by module specifier within each group.",
  "path-length": "Sort imports from shortest to longest module specifier within each group.",
  preserve: "Keep the existing order of imports within each group.",
};

const organizeImports = createFormatRule({
  id: "imports/organize",
  description: "Organize imports by semantic groups, order, and spacing.",
  scope: "file",
  optionsSchema: z.strictObject({
    order: nonEmptyStringArraySchema.optional(),
    typeImports: z.enum(["inline", "bottom-of-group", "top-of-group", "separate-group"]).optional(),
    withinGroupOrder: z.enum(["alphabetical", "path-length", "preserve"]).optional(),
    gap: intRangeSchema(0, 2).optional(),
    groupGap: intRangeSchema(0, 2).optional(),
    unmatched: z.enum(["end", "preserve"]).optional(),
  }),
  buildPrompt: ({
    order = defaultImportOrder,
    typeImports = "bottom-of-group",
    withinGroupOrder = "alphabetical",
    gap = 0,
    groupGap = 1,
    unmatched = "end",
  }) => ({
    applicability: "Two or more import declarations in a file.",
    transformation: [
      `Classify and arrange imports in this group order: ${JSON.stringify(order)}.`,
      "Treat each group label as a category or package/path hint. Prefer a clearly applicable specific hint over a broad category. Preserve imports whose group is ambiguous.",
      typeImportPlacement[typeImports],
      withinGroupSorting[withinGroupOrder],
      `Use ${gap} blank lines between imports in the same group and ${groupGap} blank lines between groups.`,
      unmatched === "end"
        ? "Place imports that match no group at the end of their movable section, keeping their relative order."
        : "Keep imports that match no group in their current positions.",
    ].join("\n"),
    constraints: [
      "Preserve the relative order and position boundaries of side-effect imports. Keep imports with order-sensitive module initialization in place.",
      "Preserve module specifiers, import bindings, and attached comments. Keep unused imports.",
    ],
  }),
});

const barrelStyleSchema = z.enum(["direct", "barrel", "preserve"]);

const barrelStyleSources = {
  direct: "barrel imports",
  barrel: "direct imports",
  preserve: "imports in their current form",
};

const barrelStyleChanges = {
  direct: "Replace barrel imports with direct imports from the equivalent defining files.",
  barrel: "Route direct imports through an existing barrel that exports the same bindings.",
  preserve: "Keep the existing import paths.",
};

const barrelStyle = createFormatRule({
  id: "imports/barrel-style",
  description: "Choose barrel or direct imports at module boundaries.",
  scope: "module",
  optionsSchema: z.strictObject({
    sameModule: barrelStyleSchema.optional(),
    crossModule: barrelStyleSchema.optional(),
    barrelFilenames: nonEmptyStringArraySchema.optional(),
    exclude: pathPatternArraySchema.optional(),
  }),
  buildPrompt: ({
    sameModule = "direct",
    crossModule = "barrel",
    barrelFilenames = ["index.ts", "index.js"],
    exclude = [],
  }) => ({
    applicability: `Same-module ${barrelStyleSources[sameModule]} and cross-module ${barrelStyleSources[crossModule]}.`,
    transformation: [
      `Within the same module: ${barrelStyleChanges[sameModule]}`,
      `Across module boundaries: ${barrelStyleChanges[crossModule]}`,
      `Recognize barrels by these filenames: ${JSON.stringify(barrelFilenames)}. Establish module boundaries from the project layout and module resolution.`,
      `Leave imports in files matching these project-relative patterns unchanged: ${JSON.stringify(exclude)}.`,
    ].join("\n"),
    constraints: [
      "Preserve package public entry points and barrels whose initialization has side effects. Never bypass an enforced module boundary or introduce a dependency cycle.",
      "Verify that the new path resolves to the same bindings and preserves type-only imports and initialization order before changing it.",
    ],
  }),
});

const namespaceStyleSources = {
  named: "Namespace imports with statically known member references.",
  namespace: "Named imports taking several members from the same module.",
  preserve: "Named or namespace imports with an explicit module preference.",
};

const namespaceVsNamed = createFormatRule({
  id: "imports/namespace-vs-named",
  description: "Choose named or namespace imports by module and symbol count.",
  scope: "file",
  optionsSchema: z.strictObject({
    default: z.enum(["named", "namespace", "preserve"]).optional(),
    namespaceFor: z.array(nonEmptyStringSchema).optional(),
    namedFor: z.array(nonEmptyStringSchema).optional(),
    namespaceMinSymbols: intRangeSchema(2).optional(),
    preserveOnNameCollision: z.boolean().optional(),
  }),
  buildPrompt: ({
    default: defaultStyle = "named",
    namespaceFor = [],
    namedFor = [],
    namespaceMinSymbols = 4,
    preserveOnNameCollision = true,
  }) => {
    const defaultChanges = {
      named:
        "By default, replace eligible namespace imports with named imports and update their member references.",
      namespace: `By default, combine named imports of at least ${namespaceMinSymbols} symbols from one module into a namespace import and qualify their uses.`,
      preserve: "Keep the current import style for modules without an explicit preference.",
    };
    const hasModulePreferences = namespaceFor.length > 0 || namedFor.length > 0;

    return {
      applicability:
        hasModulePreferences && defaultStyle !== "preserve"
          ? `${namespaceStyleSources[defaultStyle]} Also consider explicit module preferences.`
          : namespaceStyleSources[defaultStyle],
      transformation: [
        defaultChanges[defaultStyle],
        `Prefer namespace imports for modules matching ${JSON.stringify(namespaceFor)} and named imports for modules matching ${JSON.stringify(namedFor)}. Apply these explicit preferences before the default style and its symbol threshold.`,
        "When changing import form, qualify previously named references or replace static namespace member access with the corresponding named binding.",
        "Treat preference entries as module names or semantic module groups. If both preferences match, preserve the import and report the conflict.",
        preserveOnNameCollision
          ? "Keep the current import if the replacement would cause a local name collision."
          : "Resolve local name collisions with a clear alias when it preserves every binding and public name.",
      ].join("\n"),
      constraints: [
        "Preserve CommonJS default interop, tree-shaking behavior, and namespaces with dynamic property access or namespace objects used as values.",
        "Preserve binding identity and aliases, and update every affected reference when the import form changes.",
      ],
    };
  },
});

export const importRules = [organizeImports, barrelStyle, namespaceVsNamed];
