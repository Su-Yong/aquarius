import { expect, test } from "vitest";
import { z } from "zod";
import type { PathPolicy, RuleReference } from "@aquarius/core/internal";
import { buildLintPrompt } from "../src/lint/prompt";
import { analysisUpdateSchema, lintResponseSchema } from "../src/lint/schemas";

const rule: RuleReference = {
  ruleId: "fixture/check",
  scope: "file",
  applicability: "Selected source files.",
  detailsPath: ".aquarius-rules-fixture/check.json",
};

const policy: PathPolicy = {
  projectRoot: "/project",
  targets: ["src/example.ts"],
  readableFiles: ["src/example.ts"],
  ignoreRules: [],
  isIgnored: () => false,
  canWrite: (path) => path === "src/example.ts",
};

test("embeds the same delta schema consumed by the analysis receiver", () => {
  const prompt = buildLintPrompt([rule], policy, { files: ["src/**"] });
  const metadata = JSON.parse(prompt.split("\n\n").at(-1)!);

  expect(metadata.analysisUpdates.schema).toEqual(z.toJSONSchema(analysisUpdateSchema));
  expect(metadata.rules).toEqual([rule]);
  expect(metadata.targets).toEqual(["src/example.ts"]);
  expect(metadata.task).toBe("lint");
  expect(prompt).toContain("Before the first inspection");
  expect(prompt).toContain("no more than a few read/search commands between updates");
  expect(prompt).toContain("Keep the same id when revising a finding");
  expect(prompt).toContain("A read/search command ending does not mean");
  expect(prompt).toContain("All intermediate findings and statuses remain provisional");
  expect(prompt).toContain(
    "without Markdown fences, surrounding prose, command output, or private reasoning",
  );
});

test("keeps provisional updates separate from the final lint response contract", () => {
  const delta = {
    type: "aquarius.analysis_update",
    revision: 1,
    diagnostics: [{ id: "finding-1", diagnostic: null }],
    fileResults: [{ path: "src/example.ts", status: "in_progress", reason: "Checking callers." }],
    ruleResults: [{ ruleId: "fixture/check", status: "pending", reason: "Not reviewed yet." }],
  };
  const final = {
    completedRuleIds: ["fixture/check"],
    skippedRules: [],
    diagnostics: [],
    errors: [],
    fileResults: [{ path: "src/example.ts", status: "completed", reason: "" }],
  };

  expect(analysisUpdateSchema.safeParse(delta).success).toBe(true);
  expect(lintResponseSchema.safeParse(delta).success).toBe(false);
  expect(lintResponseSchema.safeParse(final).success).toBe(true);
  expect(analysisUpdateSchema.safeParse(final).success).toBe(false);
});

test("requires ongoing rule review after source checkpoints and requires a supported conclusion without deferred findings", () => {
  const targets = ["src/first.ts", "src/second.ts", "src/third.ts"];
  const prompt = buildLintPrompt(
    [rule],
    { ...policy, targets, readableFiles: targets },
    { files: ["src/**"] },
  );
  const initial = {
    type: "aquarius.analysis_update",
    revision: 1,
    diagnostics: [],
    fileResults: [{ path: "src/first.ts", status: "in_progress", reason: "Beginning review." }],
    ruleResults: [
      { ruleId: "fixture/check", status: "in_progress", reason: "Checking applicability." },
    ],
  };

  expect(analysisUpdateSchema.safeParse(initial).success).toBe(true);
  expect(prompt).toContain("first one or two selected target files");
  expect(prompt).toContain("as in_progress in fileResults");
  expect(prompt).toContain("at least one requested rule as in_progress in ruleResults");
  expect(prompt).toContain("Do not send an empty initial report");
  expect(prompt).toContain("after inspecting at most two new target files");
  expect(prompt).toContain("Continue reviewing rules after the initial source inspection");
  expect(prompt).toContain("Checkpoints do not limit the number of inspections or rule reviews");
  expect(prompt).toContain("reach a conclusion for every requested rule");
  expect(prompt).toContain("Do not return deferred or unknown conclusions");
  expect(prompt).toContain("Do not invent missing project policies");
  expect(prompt).toContain("continue the review");
  expect(prompt).toContain("include the affected ruleIds");
  expect(prompt).toContain("Never invent findings or completion to fill an update");
  expect(prompt).toContain("Use completed only after its full required scope has been checked");
});
