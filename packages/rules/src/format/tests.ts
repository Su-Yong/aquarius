import { z } from "zod";
import { createFormatRule, intRangeSchema, nonEmptyStringSchema } from "./shared";

export const testRules = [
  createFormatRule({
    id: "tests/enforce-structure",
    description: "Organize test phases and choose how repeated fixtures are created.",
    scope: "file",
    optionsSchema: z.strictObject({
      aaaStyle: z.enum(["blank-lines", "comments", "preserve"]).optional(),
      fixtures: z
        .strictObject({
          mode: z.enum(["extract-factory", "inline", "preserve"]),
          minRepetitions: intRangeSchema(2).optional(),
          namingPattern: nonEmptyStringSchema.optional(),
        })
        .optional(),
    }),
    buildPrompt: ({ aaaStyle = "blank-lines", fixtures }) => {
      const mode = fixtures?.mode ?? "extract-factory";
      const minRepetitions = fixtures?.minRepetitions ?? 3;
      const namingPattern = fixtures?.namingPattern ?? "create{Entity}Fixture";
      const phaseInstructions = {
        "blank-lines": "Separate identifiable Arrange, Act, and Assert phases with blank lines.",
        comments: "Label identifiable phases with short Arrange, Act, and Assert comments.",
        preserve: "Preserve the current separation between test phases.",
      };
      const fixtureInstructions = {
        "extract-factory": `Extract equivalent fixture setup repeated at least ${minRepetitions} times into a local factory. Name it using the pattern ${JSON.stringify(namingPattern)} and return fresh fixture data for each call.`,
        inline:
          "Inline simple local fixture setup where it remains readable and preserves test isolation.",
        preserve: "Keep fixtures in their current form.",
      };
      return {
        applicability: "Tests with identifiable phases or local test fixture setup.",
        transformation: [phaseInstructions[aaaStyle], fixtureInstructions[mode]].join(" "),
        constraints: [
          "Preserve assertion conditions, count, and order, including intermediate assertions in multi-step scenarios.",
          "Preserve fixture isolation and setup and teardown timing. Never replace fresh per-test fixture data with shared mutable state.",
        ],
      };
    },
  }),
  createFormatRule({
    id: "tests/case-style",
    description: "Choose table-driven tests or individually declared test cases.",
    scope: "file",
    optionsSchema: z.strictObject({
      prefer: z.enum(["table-driven", "explicit"]).optional(),
      minCases: intRangeSchema(2).optional(),
      excludeAsyncIntegration: z.boolean().optional(),
    }),
    buildPrompt: ({ prefer = "table-driven", minCases = 4, excludeAsyncIntegration = true }) => ({
      applicability:
        prefer === "table-driven"
          ? "Repeated test cases with equivalent structure and different input or expected data."
          : "Table-driven tests that can be expanded into equivalent individual cases.",
      transformation: [
        prefer === "table-driven"
          ? `Combine at least ${minCases} structurally equivalent cases into the test framework's table-driven form, retaining one distinct test per row.`
          : "Expand each row of an eligible table-driven test into an individually declared test block with its concrete data and resolved title.",
        excludeAsyncIntegration
          ? "Exclude asynchronous integration tests."
          : "Include asynchronous integration tests only when their per-case setup and execution semantics can be preserved.",
      ].join(" "),
      constraints: [
        "Leave snapshot tests unchanged, including tests that assert on inline snapshots or whose titles are part of snapshot keys.",
        "Preserve generated titles, registration order, fixtures, per-case hooks, assertions, and skip, todo, or focus behavior.",
      ],
    }),
  }),
  createFormatRule({
    id: "tests/description-style",
    description: "Make test titles communicate the tested condition and expected outcome.",
    scope: "file",
    optionsSchema: z.strictObject({
      language: z.enum(["ko", "en", "preserve"]).optional(),
      pattern: nonEmptyStringSchema.optional(),
      onlyRewriteVague: z.boolean().optional(),
    }),
    buildPrompt: ({ language = "preserve", pattern, onlyRewriteVague = true }) => {
      const languageInstructions = {
        ko: "Write revised titles in Korean.",
        en: "Write revised titles in English.",
        preserve: "Preserve the existing title language.",
      };
      return {
        applicability: onlyRewriteVague
          ? "Tests with vague descriptions."
          : "Test titles subject to a description convention.",
        transformation: [
          onlyRewriteVague
            ? "Rewrite vague titles only, such as titles that say the test works without describing its behavior."
            : "Revise titles that do not follow the configured description style, including clear titles where needed.",
          languageInstructions[language],
          pattern
            ? `Follow this title pattern using the test's actual condition and outcome: ${JSON.stringify(pattern)}.`
            : "Describe the actual tested condition and expected outcome in the local title style.",
          "Change title text only.",
        ].join(" "),
        constraints: [
          "Keep snapshot test titles, titles used by external test selectors, and titles containing issue or ticket identifiers unchanged.",
          "Use only behavior demonstrated by the test. Preserve its setup and assertions.",
        ],
      };
    },
  }),
];
