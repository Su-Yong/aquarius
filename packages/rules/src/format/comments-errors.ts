import { z } from "zod";

import { createFormatRule, intRangeSchema, nonEmptyStringArraySchema } from "./shared";

const documentationLanguage = {
  ko: "Write synchronized summaries in Korean.",
  en: "Write synchronized summaries in English.",
  preserve: "Preserve the existing documentation language.",
};

const commentPolicy = createFormatRule({
  id: "comments/enforce-policy",
  description:
    "Apply separate policies for redundant comments, commented code, sections, and docs.",
  scope: "file",
  optionsSchema: z.strictObject({
    redundantComments: z.enum(["remove", "keep"]).optional(),
    commentedCode: z.enum(["remove", "keep"]).optional(),
    sectionComments: z.enum(["extract-functions", "keep"]).optional(),
    docs: z
      .strictObject({
        mode: z.enum(["sync-existing", "keep"]),
        language: z.enum(["ko", "en", "preserve"]).optional(),
        maxSummarySentences: intRangeSchema(1, 5).optional(),
        tags: nonEmptyStringArraySchema.optional(),
      })
      .optional(),
  }),
  buildPrompt: ({
    redundantComments = "remove",
    commentedCode = "remove",
    sectionComments = "keep",
    docs,
  }) => {
    const mode = docs?.mode ?? "sync-existing";
    const language = docs?.language ?? "preserve";
    const maxSummarySentences = docs?.maxSummarySentences ?? 2;
    const tags = docs?.tags;

    const buildDocumentationSyncInstructions = () => {
      const instructions = [
        `Synchronize existing documentation with verified code and signatures. Keep summaries to at most ${maxSummarySentences} sentences.`,
        documentationLanguage[language],
        tags &&
          `Apply tag synchronization to these configured tags: ${JSON.stringify(tags)}. Preserve other tags.`,
      ];

      return instructions.filter(Boolean).join(" ");
    };

    const documentationInstructions =
      mode === "sync-existing"
        ? buildDocumentationSyncInstructions()
        : "Keep existing documentation comments unchanged.";

    return {
      applicability: "Source comments, commented-out code, and existing documentation comments.",
      transformation: [
        redundantComments === "remove"
          ? "Remove comments that merely repeat what the code already states."
          : "Keep redundant comments.",
        commentedCode === "remove"
          ? "Remove clearly obsolete commented-out code."
          : "Keep commented-out code.",
        sectionComments === "extract-functions"
          ? "Extract cohesive comment-delimited sections into named functions where safe. Keep any rationale or constraints associated with the extracted code."
          : "Keep section comments and their code grouping.",
        documentationInstructions,
      ].join(" "),
      constraints: [
        "Preserve licenses, tool directives, TODO and FIXME notes, rationale, workarounds, and constraint comments.",
        "Do not invent undocumented contracts, examples, or side effects. Preserve evaluation order and scope when extracting a section.",
      ],
    };
  },
});

const errorMessageCase = {
  "lowercase-start":
    "Use a lowercase initial letter where appropriate without altering proper names or acronyms.",
  "sentence-case": "Use sentence case.",
  preserve: "Preserve existing message capitalization.",
};

const errorMessagePeriod = {
  omit: "Omit a trailing period.",
  require: "Use a trailing period.",
  preserve: "Preserve existing trailing punctuation.",
};

const errorStyle = createFormatRule({
  id: "errors/enforce-style",
  description: "Apply the configured style to error creation, wrapping, and messages.",
  scope: "module",
  optionsSchema: z.strictObject({
    preserveCause: z.boolean().optional(),
    messageCase: z.enum(["lowercase-start", "sentence-case", "preserve"]).optional(),
    trailingPeriod: z.enum(["omit", "require", "preserve"]).optional(),
    internalOnly: z.boolean().optional(),
  }),
  buildPrompt: ({
    preserveCause = true,
    messageCase = "preserve",
    trailingPeriod = "omit",
    internalOnly = true,
  }) => ({
    applicability: internalOnly
      ? "Internal error construction, wrapping, and message text."
      : "Error construction, wrapping, and message text across the module.",
    transformation: [
      internalOnly
        ? "Apply the style only to internal errors."
        : "Review error styling across the module, including boundary code, while preserving external error contracts.",
      preserveCause
        ? "When wrapping an error, retain the original cause using the language's supported mechanism if the observable error contract stays the same."
        : "Leave cause handling as written.",
      errorMessageCase[messageCase],
      errorMessagePeriod[trailingPeriod],
    ].join(" "),
    constraints: [
      "Preserve exception conditions, existing causes, public error classes and codes, and externally relied-on messages, including messages asserted in tests.",
      "Keep the message meaning and interpolation intact. Preserve messages consumed by clients, tooling, or other machine readers.",
    ],
  }),
});

export const commentErrorRules = [commentPolicy, errorStyle];
