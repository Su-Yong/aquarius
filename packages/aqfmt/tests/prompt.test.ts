import { describe, expect, test } from "vitest";
import type { PathPolicy, RuleReference } from "@aquarius/core/runtime";
import { buildFormatPrompt } from "../src/format/prompt";

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
});
