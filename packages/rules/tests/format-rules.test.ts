import { isDeepStrictEqual } from "node:util";
import { describe, expect, test } from "vitest";
import type { JsonObject, RuleSettings } from "@aquarius/core";
import type { LoadedConfig } from "../../core/src/config/types";
import { prepareRules } from "../../core/src/rules/prepare";
import { formatInstructionsSchema, formatRuleSchema } from "../../core/src/rules/schemas";
import plugin from "../src/index";

const formatRules = plugin.formatRules!;
const ruleId = (id: string) => `aquarius/${id}`;

const prepareFormatRules = (rules: RuleSettings, preset: string[] = []) => {
  const config: LoadedConfig = {
    tool: "format",
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    configDirectory: process.cwd(),
    files: [],
    ignore: [],
    plugins: ["format-rules-test"],
    preset,
    rules,
    ai: { options: {}, timeoutMs: 1_000 },
  };
  return prepareRules(config, { "format-rules-test": plugin });
};

const validOptions: Record<string, JsonObject> = {
  "imports/organize": {
    order: ["side-effect", "  사내 모듈  ", "css"],
    typeImports: "separate-group",
    withinGroupOrder: "path-length",
    gap: 1,
    groupGap: 2,
    unmatched: "preserve",
  },
  "imports/barrel-style": {
    sameModule: "barrel",
    crossModule: "direct",
    barrelFilenames: ["mod.ts"],
    exclude: ["src/generated/**"],
  },
  "imports/namespace-vs-named": {
    default: "namespace",
    namedFor: ["domain"],
    namespaceFor: ["node-builtins"],
    namespaceMinSymbols: 2,
    preserveOnNameCollision: false,
  },
  "control-flow/exit-style": {
    prefer: "single-exit",
    skipWhenCleanupPresent: true,
    minNestingDepth: 1,
  },
  "control-flow/branch-dispatch": {
    pureValueMapping: "lookup-object",
    discriminatedUnion: "if-else",
    rangeOrCompound: "preserve",
    minCases: 2,
  },
  "control-flow/ternary-style": {
    mode: "no-ternary",
    flattenTarget: "if-else",
    allowInJsx: false,
  },
  "control-flow/loop-granularity": {
    mode: "fuse",
    excludeContexts: [],
    overrides: [{ files: ["src/view/**"], mode: "split" }],
  },
  "control-flow/loop-termination": { prefer: "flag-variable", preferCollectionSearch: false },
  "control-flow/async-style": {
    prefer: "promise-chain",
    minChainDepth: 1,
    allowInlineFallbackCatch: false,
  },
  "control-flow/error-scope": {
    mode: "extract-safe-helper",
    hoistPureSetup: false,
    hoistPurePostprocess: false,
  },
  "control-flow/consolidate-branches": {
    hoistCommonPrefix: false,
    hoistCommonSuffix: false,
    mergeIdenticalOutcomes: false,
    keepDistinctDomainBranches: false,
  },
  "expressions/iteration-style": {
    prefer: "imperative",
    maxChainLength: 4,
    overrides: [{ files: ["src/view/**"], prefer: "pipeline" }],
  },
  "expressions/step-granularity": {
    prefer: "inline-compact",
    maxNestingDepth: 1,
    preserveDomainNamedTemps: false,
  },
  "expressions/variable-mutability": {
    splitReusedVariables: false,
    replaceBranchAssignment: "ternary",
    ignoreLoopAccumulators: false,
  },
  "expressions/object-build-style": {
    prefer: "step-by-step",
    maxConditionalPropsForDeclarative: 2,
  },
  "expressions/regex-readability": { mode: "named-groups", minLength: 10, minGroups: 1 },
  "expressions/condition-readability": {
    prefer: "inline-simple",
    minClauses: 4,
    maxInlineClauses: 3,
  },
  "naming/enforce-convention": {
    booleans: { style: "positive", prefixes: ["can", "has"] },
    verbs: {
      asyncRead: "fetch",
      syncRead: "read",
      write: "save",
      construct: "create",
      eventHandler: "handle",
      predicate: "is",
      assert: "assert",
    },
    glossary: { 사용자: "회원" },
  },
  "naming/magic-values": {
    categories: ["duration", "retry-limit"],
    placement: "colocated",
    expressionStyle: "plain-literal",
    ignoreValues: ["", 0, -1.5],
  },
  "naming/callback-style": { prefer: "inline-arrows", minLines: 2, alwaysName: ["timer"] },
  "naming/identifier-clarity": { verbosity: "concise", allowedShortNames: [], maxWords: 2 },
  "structure/order-sections": {
    module: ["constants", "exports"],
    reactComponent: ["props", "render"],
    class: ["construction", "methods"],
    exportOrder: "alphabetical",
    groupGap: 0,
  },
  "structure/order-properties": {
    targets: ["config", "types"],
    profiles: { 요청: ["id", "metadata"] },
    unmatched: "end",
  },
  "structure/declaration-placement": { style: "top-of-block", moveConstants: false },
  "structure/abstraction-density": {
    singleImplInterfaces: "preserve",
    passthroughWrappers: "preserve",
    repeatedBlocks: { action: "extract", minRepetitions: 2 },
    preserve: ["di-ports"],
  },
  "structure/flag-argument-style": { literalCalls: "options-object", dynamicCalls: "preserve" },
  "structure/io-core-separation": {
    style: "colocated",
    minPureLines: 3,
    targetDomains: ["결제"],
  },
  "structure/state-transition-style": {
    style: "immutable-reducer",
    minFieldsPerTransition: 3,
    minSites: 4,
  },
  "types/enforce-declaration-style": {
    objectType: { publicContract: "interface", dataDto: "type", default: "preserve" },
    extractRepeatedInline: { enabled: false, minOccurrences: 4 },
  },
  "types/state-modeling": { prefer: "flat-optional", tagField: "kind", excludeExported: false },
  "types/type-guard-style": { prefer: "inline-simple", minOccurrences: 3, minClauses: 2 },
  "types/internal-precision": {
    narrowStringLiterals: false,
    narrowLooseRecords: false,
    maxUnionMembers: 2,
  },
  "comments/enforce-policy": {
    redundantComments: "keep",
    commentedCode: "keep",
    sectionComments: "extract-functions",
    docs: { mode: "sync-existing", language: "ko", maxSummarySentences: 1, tags: ["@returns"] },
  },
  "errors/enforce-style": {
    preserveCause: false,
    messageCase: "sentence-case",
    trailingPeriod: "require",
    internalOnly: false,
  },
  "tests/enforce-structure": {
    aaaStyle: "comments",
    fixtures: { mode: "inline", minRepetitions: 2, namingPattern: "make{Entity}" },
  },
  "tests/case-style": { prefer: "explicit", minCases: 2, excludeAsyncIntegration: false },
  "tests/description-style": {
    language: "ko",
    pattern: "{조건}에서 {결과}를 반환한다",
    onlyRewriteVague: false,
  },
  "refactor/parameter-style": {
    prefer: "positional",
    maxPositionalParams: 2,
    wrapBooleanFlags: false,
    unwrapMaxFields: 1,
  },
  "refactor/separate-responsibilities": {
    maxFunctionLines: 20,
    maxFileLines: 50,
    splitBuckets: ["검증", "렌더링"],
    preserveBarrelReExports: false,
  },
  "refactor/dispatch-architecture": {
    prefer: "cohesive-switches",
    minRepeatedSwitches: 2,
    maxCasesForSwitch: 4,
  },
  "refactor/data-representation": {
    parallelArrays: "preserve",
    dataClumps: { action: "to-value-object", minFields: 3, minOccurrences: 2 },
    pipelineStages: "preserve",
    exclude: ["src/special/**"],
  },
  "refactor/deduplicate-internals": {
    minDuplicates: 3,
    targetFile: "./lib/internal-utils.ts",
    pureUtilitiesOnly: false,
  },
  "refactor/layer-depth": { mode: "enforce-facade", preserveLayers: ["adapters"] },
  "architecture/enforce-layout": {
    style: "layered",
    fileNaming: "snake_case",
    featureDir: "src/features/{feature}",
    standardFiles: ["index.ts", "service.ts"],
    colocateSingleConsumerFiles: false,
    exclude: ["src/generated/**"],
  },
  "architecture/break-internal-cycles": {
    strategy: "extract-shared-module",
    extractedFilename: "shared.ts",
  },
  "architecture/shared-utilities-policy": {
    minModules: 2,
    sharedDir: "src/common",
    pureUtilitiesOnly: false,
    exclude: ["src/generated/**"],
  },
  "custom/semantic-policy": {
    policies: [
      {
        name: "단위 표기",
        target: "파일 내부 상수",
        rule: "주변 상수의 단위 표기를 사용한다.",
        exceptions: ["공개 상수는 유지한다."],
        examples: [{ before: "  const TIMEOUT = 60000;\n", after: "  const TIMEOUT = 60_000;\n" }],
      },
    ],
  },
};

const requiredRuleIds = [
  "structure/order-properties",
  "architecture/shared-utilities-policy",
  "custom/semantic-policy",
];

describe("format rule contracts", () => {
  test("registers every v2 rule in catalog order", () => {
    expect(formatRules.map(({ id }) => id)).toEqual(Object.keys(validOptions));
  });

  test("assigns project and module scope to cross-file rules", () => {
    const moduleIds = [
      "imports/barrel-style",
      "naming/enforce-convention",
      "structure/abstraction-density",
      "structure/flag-argument-style",
      "types/state-modeling",
      "types/internal-precision",
      "errors/enforce-style",
    ];
    for (const { id, scope } of formatRules) {
      if (id.startsWith("architecture/")) {
        expect(scope, id).toBe("project");
      } else if (id.startsWith("refactor/") || moduleIds.includes(id)) {
        expect(scope, id).toBe("module");
      } else {
        expect(scope, id).toBe("file");
      }
    }
  });

  test.each(formatRules)(
    "$id validates options and builds independent instructions",
    async (rule) => {
      const options = validOptions[rule.id]!;
      expect(formatRuleSchema.safeParse(rule).success).toBe(true);
      expect(rule.optionsSchema?.parse(options)).toStrictEqual(options);

      const expected = await rule.buildPrompt({ options });
      expect(formatInstructionsSchema.safeParse(expected).success).toBe(true);
      expect(expected.applicability).not.toMatch(/[\r\n]/u);
      expect(expected.applicability.length).toBeLessThanOrEqual(160);
      expect(expected.constraints).toEqual(
        expect.arrayContaining([expect.stringMatching(/Preserve observable behavior/i)]),
      );
      expect(expected.constraints.join(" ")).toMatch(/warning/i);
      expect(expected.constraints.join(" ")).toMatch(/Tie-breaker: preserve/i);
      expect(expected.constraints.join(" ")).toMatch(/target language/i);

      const changed = await rule.buildPrompt({ options });
      changed.applicability = "Changed by caller";
      changed.constraints.splice(0, changed.constraints.length, "Changed by caller");
      if (changed.examples?.length) {
        changed.examples[0]!.before = "Changed by caller";
        changed.examples.pop();
      }
      expect(await rule.buildPrompt({ options })).toStrictEqual(expected);
    },
  );

  test("prepares representative options for every rule without transforming inputs", async () => {
    const options = Object.fromEntries(
      Object.entries(validOptions).map(([id, value]) => [ruleId(id), value]),
    );
    const result = await prepareFormatRules(options);
    expect(result.errors).toEqual([]);
    expect(result.rules.map(({ id }) => id)).toEqual(Object.keys(options));
  });

  test("prepares 44 rules with empty options and rejects the three missing required options", async () => {
    const result = await prepareFormatRules(
      Object.fromEntries(formatRules.map(({ id }) => [ruleId(id), {}])),
    );
    expect(result.rules).toHaveLength(44);
    expect(result.errors.map(({ code, ruleIds }) => [code, ...ruleIds])).toEqual(
      requiredRuleIds.map((id) => ["RULE_OPTIONS_INVALID", ruleId(id)]),
    );
    for (const { instructions } of result.rules) {
      expect(formatInstructionsSchema.safeParse(instructions).success).toBe(true);
      expect(instructions.applicability).not.toMatch(/[\r\n]/u);
      expect(instructions.applicability.length).toBeLessThanOrEqual(160);
    }
  });

  test("rejects unknown top-level keys in all format rule settings", async () => {
    const result = await prepareFormatRules(
      Object.fromEntries(
        Object.entries(validOptions).map(([id, value]) => [
          ruleId(id),
          { ...value, unknown: true },
        ]),
      ),
    );
    expect(result.rules).toEqual([]);
    expect(result.errors.map(({ code, ruleIds }) => [code, ...ruleIds])).toEqual(
      formatRules.map(({ id }) => ["RULE_OPTIONS_INVALID", ruleId(id)]),
    );
  });

  test("validates dynamic record keys without rewriting the rule options", () => {
    const options = {
      profiles: { ["__proto__"]: ["id"], constructor: ["name"] },
    };
    const rule = formatRules.find(({ id }) => id === "structure/order-properties")!;
    const parsed = rule.optionsSchema?.parse(options);
    expect(isDeepStrictEqual(parsed, options)).toBe(true);
  });

  test.each<{ id: string; options: JsonObject }>([
    { id: "imports/organize", options: { order: ["  "] } },
    { id: "imports/organize", options: { gap: 3 } },
    { id: "control-flow/exit-style", options: { minNestingDepth: 1.5 } },
    { id: "naming/magic-values", options: { categories: [] } },
    { id: "naming/enforce-convention", options: { verbs: { fetch: "get" } } },
    { id: "naming/enforce-convention", options: { glossary: { " ": "value" } } },
    { id: "control-flow/loop-granularity", options: { overrides: [{ files: [], mode: "fuse" }] } },
    {
      id: "control-flow/loop-granularity",
      options: { overrides: [{ files: ["src/**"], mode: "fuse", extra: true }] },
    },
    {
      id: "expressions/iteration-style",
      options: { overrides: [{ files: ["src/../private/**"], prefer: "pipeline" }] },
    },
    { id: "comments/enforce-policy", options: { docs: { mode: "keep", extra: true } } },
    { id: "comments/enforce-policy", options: { docs: { mode: "keep", maxSummarySentences: 6 } } },
    { id: "structure/order-properties", options: { profiles: {} } },
    { id: "structure/order-properties", options: { profiles: { config: [] } } },
    { id: "architecture/shared-utilities-policy", options: { sharedDir: "../shared" } },
    { id: "architecture/shared-utilities-policy", options: { sharedDir: "/shared" } },
    { id: "architecture/shared-utilities-policy", options: { sharedDir: "\\shared" } },
    { id: "architecture/shared-utilities-policy", options: { sharedDir: "C:shared" } },
    { id: "custom/semantic-policy", options: { policies: [] } },
    {
      id: "custom/semantic-policy",
      options: {
        policies: [
          { name: "same", rule: "A" },
          { name: "same", rule: "B" },
        ],
      },
    },
    {
      id: "custom/semantic-policy",
      options: { policies: [{ name: "x", rule: "A", examples: [{ before: " ", after: "B" }] }] },
    },
    {
      id: "custom/semantic-policy",
      options: {
        policies: [{ name: "x", rule: "A", examples: [{ before: "A", after: "B", extra: "C" }] }],
      },
    },
  ])("$id rejects malformed options $options", async ({ id, options }) => {
    const fullId = ruleId(id);
    const result = await prepareFormatRules({ [fullId]: options });
    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "RULE_OPTIONS_INVALID", ruleIds: [fullId] }),
    ]);
  });

  test("preserves configured slot text in context and copies custom examples verbatim", async () => {
    const result = await prepareFormatRules({
      [ruleId("imports/organize")]: validOptions["imports/organize"]!,
      [ruleId("tests/description-style")]: validOptions["tests/description-style"]!,
      [ruleId("custom/semantic-policy")]: validOptions["custom/semantic-policy"]!,
    });
    expect(result.errors).toEqual([]);
    const [imports, descriptions, policy] = result.rules.map(({ instructions }) =>
      formatInstructionsSchema.parse(instructions),
    );
    expect(imports!.transformation).toContain("  사내 모듈  ");
    expect(descriptions!.transformation).toContain("{조건}에서 {결과}를 반환한다");
    expect(policy!.transformation).toContain("주변 상수의 단위 표기를 사용한다.");
    expect(policy!.transformation).toContain("공개 상수는 유지한다.");
    expect(policy!.examples).toEqual([
      {
        before: "  const TIMEOUT = 60000;\n",
        after: "  const TIMEOUT = 60_000;\n",
        reason: expect.any(String),
      },
    ]);
  });
});

describe("format rule directions", () => {
  test.each<{ id: string; options: JsonObject; defaultTarget: RegExp; selectedTarget: RegExp }>([
    {
      id: "imports/barrel-style",
      options: { sameModule: "barrel", crossModule: "direct" },
      defaultTarget: /direct/i,
      selectedTarget: /barrel/i,
    },
    {
      id: "imports/namespace-vs-named",
      options: { default: "namespace" },
      defaultTarget: /named import/i,
      selectedTarget: /namespace import/i,
    },
    {
      id: "control-flow/exit-style",
      options: { prefer: "single-exit" },
      defaultTarget: /early return|guard clause/i,
      selectedTarget: /single return|single exit/i,
    },
    {
      id: "control-flow/branch-dispatch",
      options: { pureValueMapping: "lookup-object" },
      defaultTarget: /map/i,
      selectedTarget: /object/i,
    },
    {
      id: "control-flow/ternary-style",
      options: { mode: "prefer-concise" },
      defaultTarget: /nested/i,
      selectedTarget: /single|simple/i,
    },
    {
      id: "control-flow/loop-granularity",
      options: { mode: "fuse" },
      defaultTarget: /split/i,
      selectedTarget: /fus|single pass/i,
    },
    {
      id: "control-flow/loop-termination",
      options: { prefer: "flag-variable" },
      defaultTarget: /break|return/i,
      selectedTarget: /flag/i,
    },
    {
      id: "control-flow/async-style",
      options: { prefer: "promise-chain" },
      defaultTarget: /async\/await/i,
      selectedTarget: /promise chain/i,
    },
    {
      id: "expressions/iteration-style",
      options: { prefer: "imperative" },
      defaultTarget: /pipeline/i,
      selectedTarget: /imperative/i,
    },
    {
      id: "expressions/step-granularity",
      options: { prefer: "inline-compact" },
      defaultTarget: /extract/i,
      selectedTarget: /inline/i,
    },
    {
      id: "expressions/object-build-style",
      options: { prefer: "step-by-step" },
      defaultTarget: /declarative/i,
      selectedTarget: /assignment/i,
    },
    {
      id: "expressions/condition-readability",
      options: { prefer: "predicate-functions" },
      defaultTarget: /boolean/i,
      selectedTarget: /predicate/i,
    },
    {
      id: "naming/callback-style",
      options: { prefer: "inline-arrows" },
      defaultTarget: /named/i,
      selectedTarget: /inline/i,
    },
    {
      id: "naming/identifier-clarity",
      options: { verbosity: "concise" },
      defaultTarget: /descriptive/i,
      selectedTarget: /concise/i,
    },
  ])(
    "$id changes applicability and transformation with $options",
    async ({ id, options, defaultTarget, selectedTarget }) => {
      const rule = formatRules.find((rule) => rule.id === id)!;
      const defaults = await rule.buildPrompt({ options: {} });
      const selected = await rule.buildPrompt({ options });
      expect(selected.applicability).not.toBe(defaults.applicability);
      expect(selected.transformation).not.toBe(defaults.transformation);
      expect(defaults.transformation).toMatch(defaultTarget);
      expect(selected.transformation).toMatch(selectedTarget);
    },
  );
});

const safeRules = [
  "imports/organize",
  "control-flow/exit-style",
  "control-flow/ternary-style",
  "expressions/step-granularity",
  "expressions/variable-mutability",
  "expressions/condition-readability",
  "naming/magic-values",
  "naming/callback-style",
  "structure/declaration-placement",
  "comments/enforce-policy",
];

describe("format presets", () => {
  test.each([
    { name: "format-safe", fileOnly: true, expected: safeRules },
    {
      name: "format-recommended",
      fileOnly: true,
      expected: [
        ...safeRules,
        "control-flow/branch-dispatch",
        "control-flow/loop-termination",
        "control-flow/async-style",
        "control-flow/error-scope",
        "control-flow/consolidate-branches",
        "expressions/iteration-style",
        "expressions/object-build-style",
        "naming/identifier-clarity",
        "structure/order-sections",
        "types/enforce-declaration-style",
      ],
    },
    {
      name: "format-tests",
      fileOnly: true,
      expected: ["tests/enforce-structure", "tests/case-style", "tests/description-style"],
    },
    {
      name: "format-refactor",
      fileOnly: false,
      expected: [
        "imports/barrel-style",
        "naming/enforce-convention",
        "structure/abstraction-density",
        "structure/flag-argument-style",
        "structure/io-core-separation",
        "types/state-modeling",
        "refactor/parameter-style",
        "refactor/separate-responsibilities",
        "refactor/dispatch-architecture",
        "refactor/data-representation",
        "refactor/deduplicate-internals",
        "refactor/layer-depth",
      ],
    },
  ])("prepares $name with no additional options", async ({ name, fileOnly, expected }) => {
    const result = await prepareFormatRules({}, [ruleId(name)]);
    expect(result.errors).toEqual([]);
    expect(result.rules.map(({ id }) => id)).toEqual(expected.map(ruleId));
    expect(result.rules.every(({ scope }) => scope === "file")).toBe(fileOnly);
  });

  test("applies the distinct comment policies in safe and recommended presets", async () => {
    const id = ruleId("comments/enforce-policy");
    const common = { redundantComments: "remove", sectionComments: "keep" };
    const safe = { ...common, commentedCode: "keep", docs: { mode: "keep" } };
    const recommended = { ...common, commentedCode: "remove", docs: { mode: "sync-existing" } };
    expect(plugin.presets?.["format-safe"]?.[id]).toEqual(safe);
    expect(plugin.presets?.["format-recommended"]?.[id]).toEqual(recommended);

    const names = ["format-safe", "format-recommended"];
    const variants = await Promise.all(names.map((name) => prepareFormatRules({}, [ruleId(name)])));
    const prompts = variants.map(({ rules }) => rules.find((rule) => rule.id === id)?.instructions);
    expect(prompts[0]).toBeDefined();
    expect(prompts[1]).toBeDefined();
    expect(prompts[0]).not.toEqual(prompts[1]);
  });
});
