import { describe, expect, test } from "vitest";
import { buildTaskPrompt } from "../src/ai/prompt";
import type { RuleResourceFile } from "../src/ai/types";
import type { PathPolicy } from "../src/files/types";

const policy: PathPolicy = {
  projectRoot: "/project",
  targets: ["src/example.ts"],
  readableFiles: ["src/example.ts", "src/context.ts"],
  ignoreRules: [],
  isIgnored: () => false,
  canWrite: (path) => path === "src/example.ts",
};

const ruleFile = (ruleId: string): RuleResourceFile => ({
  ruleId,
  scope: "module",
  applicability: "Modules that publish an API.",
  detailsPath: `.aquarius-rules-fixture/${ruleId.replaceAll("/", "-")}.json`,
  contentHash: "private-resource-integrity-metadata",
});

describe("rule reference prompts", () => {
  test("keeps the requested order and exposes only the index fields", () => {
    const files = [ruleFile("demo/second"), ruleFile("demo/first")];
    const prompt = buildTaskPrompt(["Inspect the source."], files, policy, {
      task: "format",
      writeScope: { files: ["src/**"] },
    });
    const metadata = JSON.parse(prompt.split("\n\n").at(-1)!);

    expect(metadata).toEqual({
      task: "format",
      writeScope: { files: ["src/**"] },
      targets: ["src/example.ts"],
      rules: files.map(({ contentHash: _contentHash, ...reference }) => reference),
    });
    expect(prompt).not.toContain("private-resource-integrity-metadata");
    expect(prompt).not.toContain("/project");
    expect(prompt).not.toContain("src/context.ts");
  });

  test("requires full details for uncertain applicability and accounts for skipped rules", () => {
    const prompt = buildTaskPrompt([], [ruleFile("demo/check")], policy, { task: "lint" });

    expect(prompt).toContain("If applicability is uncertain, read the details");
    expect(prompt).toContain("absent throughout the requested scope");
    expect(prompt).toContain("Do not count a skipped rule as completed");
    expect(prompt).toContain("Never use them as diagnostic or evidence locations");
    expect(prompt).toContain("Report a rule execution error if required details cannot be read");
    expect(prompt).toContain("Read one rule detail file per tool response");
    expect(prompt).toContain("re-read the omitted text in smaller line ranges");
    expect(prompt).toContain("Output truncation is recoverable");
    expect(prompt).toContain("Number source lines separately for each file");
  });

  test.each(["lint", "format", "lint-fix"])(
    "%s permits project reference reading without expanding selected targets",
    (task) => {
      const prompt = buildTaskPrompt([], [ruleFile("demo/check")], policy, {
        task,
        writeScope: { files: ["src/**"] },
      });
      const metadata = JSON.parse(prompt.split("\n\n").at(-1)!);

      expect(prompt).toContain("Project files outside the selected targets may be read as context");
      expect(prompt).toContain("not reference reading");
      expect(prompt).toContain(
        "Inspect available project files before reporting evidence as missing",
      );
      expect(prompt).not.toContain("Project context is limited to the configured files patterns");
      expect(metadata.targets).toEqual(policy.targets);
      expect(metadata.writeScope).toEqual({ files: ["src/**"] });
    },
  );

  test("gives correction tasks their changes and errors contract", () => {
    const prompt = buildTaskPrompt([], [ruleFile("demo/check")], policy, { task: "lint-fix" });

    expect(prompt).toContain("Every supplied rule is linked to an existing diagnostic");
    expect(prompt).toContain("return empty changes and errors arrays");
    expect(prompt).toContain("Do not return completedRuleIds or skippedRules");
    expect(prompt).not.toContain("Account for every requested rule using completedRuleIds");
  });
});
