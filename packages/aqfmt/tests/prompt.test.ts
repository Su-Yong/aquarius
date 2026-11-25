import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { PathPolicy, RuleReference } from "@aquarius/core/runtime";
import { buildFormatPrompt, buildReplacementRepairPrompt } from "../src/format/prompt";
import { formatAnalysisUpdateSchema, formatResponseSchema } from "../src/format/schemas";

const policy: PathPolicy = {
  projectRoot: "/project",
  targets: ["src/a.ts"],
  readableFiles: ["src/a.ts", "src/context.ts"],
  isIgnored: () => false,
  canWrite: (path) => path.startsWith("src/"),
};

const rule = (scope: RuleReference["scope"]): RuleReference => ({
  ruleId: "fixture/style",
  scope,
  applicability: "Nested branches",
  detailsPath: "rules/style.json",
});

describe("format prompt contracts", () => {
  test("bounds file rules to replacements while preserving reference reading", () => {
    const prompt = buildFormatPrompt([rule("file")], policy, { paths: ["src/**"] });

    expect(prompt).toContain("Only replace operations in the selected target files");
    expect(prompt).toContain("single file or is the only file group");
    expect(prompt).toContain("You may still read the permitted project context");
    expect(prompt).toContain('"targets": [\n    "src/a.ts"');
    expect(prompt).toContain('"detailsPath": "rules/style.json"');
  });

  test.each(["module", "project"] as const)("coordinates %s rules in one request", (scope) => {
    const prompt = buildFormatPrompt([rule("file"), rule(scope)], policy, {});

    expect(prompt).toContain("coordinate all related changes in this single request");
    expect(prompt).not.toContain("All active rules have file scope");
  });

  test("requests explicit final file outcomes and replaceable provisional lists", () => {
    const prompt = buildFormatPrompt([rule("file")], policy, {});

    expect(prompt).toContain("every selected target exactly once, including unchanged files");
    expect(prompt).toContain("New files and move destinations belong in changes");
    expect(prompt).toContain("INCOMPLETE_FILE_REVIEW");
    expect(prompt).toContain("INCOMPLETE_AI_RESPONSE");
    expect(prompt).toContain("aquarius.analysis_update");
    expect(prompt).toContain("proposedFiles and warnings as the complete current lists");
    expect(prompt).toContain("use an empty array to clear it");
    expect(prompt).toContain("never write source files");
  });

  test("embeds the receiver's schema with defaults and instructs timely checkpoints", () => {
    const prompt = buildFormatPrompt([rule("file")], policy, {});
    const metadata = JSON.parse(prompt.split("\n\n").at(-1)!);
    const schema = metadata.analysisUpdates.schema;

    expect(schema).toEqual(z.toJSONSchema(formatAnalysisUpdateSchema));
    expect(schema.required).toEqual(
      expect.arrayContaining(["fileResults", "ruleResults", "proposedFiles", "warnings"]),
    );
    for (const field of ["fileResults", "ruleResults"]) {
      expect(schema.properties[field].default).toEqual([]);
      expect(schema.properties[field].items.required).toContain("reason");
      expect(schema.properties[field].items.properties.reason.default).toBe("");
    }
    expect(prompt).toContain("matching analysisUpdates.schema before the first inspection");
    expect(prompt).toContain("first one or two selected target files");
    expect(prompt).toContain("as in_progress in fileResults");
    expect(prompt).toContain("at least one requested rule as in_progress in ruleResults");
    expect(prompt).toContain("Do not send an empty initial report");
    expect(prompt).toContain("or report uninspected files or rules as completed");
    expect(prompt).toContain("after inspecting at most two new target files");
    expect(prompt).toContain("or finishing a small group of rule reviews");
    expect(prompt).toContain("no more than a few read/search commands between updates");
    expect(prompt).toContain("Do not send empty heartbeats or defer all updates");
    expect(prompt).toContain("immediately when an entry in proposedFiles or warnings is added");
    expect(prompt).toContain("Do not include patch text or a diff");
  });

  test("keeps the final response contract separate and its review reasons required", () => {
    const provisional = {
      type: "aquarius.analysis_update",
      revision: 1,
      fileResults: [{ path: "src/a.ts", status: "in_progress" }],
      proposedFiles: ["src/a.ts"],
      warnings: [],
    };
    const final = {
      completedRuleIds: ["fixture/style"],
      skippedRules: [],
      changes: [],
      warnings: [],
      errors: [],
      fileResults: [{ path: "src/a.ts", status: "completed", reason: "" }],
    };

    expect(formatAnalysisUpdateSchema.safeParse(provisional).success).toBe(true);
    expect(formatResponseSchema.safeParse(provisional).success).toBe(false);
    expect(formatResponseSchema.safeParse(final).success).toBe(true);
    expect(formatAnalysisUpdateSchema.safeParse(final).success).toBe(false);
    expect(
      formatResponseSchema.safeParse({
        ...final,
        fileResults: [{ path: "src/a.ts", status: "completed" }],
      }).success,
    ).toBe(false);
  });

  test("omits provisional update instructions and metadata from replacement repair", () => {
    const prompt = buildReplacementRepairPrompt(
      {
        path: "src/a.ts",
        error: { code: "PATCH_MISMATCH", message: "Context mismatch.", ruleIds: [] },
        repairable: true,
      },
      [],
      [rule("file")],
    );
    const metadata = JSON.parse(prompt.split("\n\n").at(-1)!);

    expect(metadata.task).toBe("repair-format-replacement");
    expect(metadata).not.toHaveProperty("analysisUpdates");
    expect(prompt).not.toContain("aquarius.analysis_update");
  });

  test("requests Unified Diff hunks against the original file", () => {
    const prompt = buildFormatPrompt([rule("file")], policy, {});

    expect(prompt).toContain("Unified Diff");
    expect(prompt).toContain("patch");
    expect(prompt).toContain("@@");
    expect(prompt).toContain("original file");
  });
});
