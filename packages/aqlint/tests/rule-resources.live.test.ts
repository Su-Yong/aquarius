import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { codexAdapter } from "@aquarius/codex";
import type { RulePlugin } from "@aquarius/core";
import { executeLint } from "../src/lint/execute";

const liveTest = process.env.AQUARIUS_RULE_RESOURCES_LIVE === "1" ? test : test.skip;

liveTest(
  "reads rule details and skips absent prerequisites without deferred conclusions",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aquarius-rule-resources-live-"));
    const violationToken = `DETAIL_VIOLATION_${randomUUID()}`;
    const source = 'export const fixtureFlag = "bad";\n';
    const plugin: RulePlugin = {
      namespace: "fixture",
      lintRules: [
        {
          id: "flag-value",
          description: "Check the configured fixture flag value.",
          scope: "file",
          buildPrompt: () => ({
            applicability: "Files that export a constant named fixtureFlag.",
            criteria:
              'The fixture contract requires fixtureFlag to equal "good". A literal "bad" violates it. ' +
              `Include ${violationToken} in the diagnostic message to identify this contract.`,
            evidenceRequirements: ["The exported fixtureFlag declaration and its literal value."],
          }),
        },
        {
          id: "archive-handle",
          description: "Check archiveLedger file handles.",
          scope: "file",
          buildPrompt: () => ({
            applicability: "Functions named archiveLedger that open a file handle.",
            criteria: "Every opened file handle must be closed.",
            evidenceRequirements: ["The archiveLedger function and file handle lifecycle."],
          }),
        },
      ],
    };

    try {
      await writeFile(join(root, "fixture.ts"), source);
      await writeFile(
        join(root, ".aqlintrc.json"),
        JSON.stringify({
          files: ["fixture.ts"],
          plugins: ["fixture-live"],
          rules: {
            "fixture/flag-value": "error",
            "fixture/archive-handle": "warn",
          },
          ai: { adapter: "@aquarius/codex", timeoutMs: 120_000 },
        }),
      );
      const beforeEntries = await readdir(root);
      const execution = await executeLint({
        cwd: root,
        plugins: { "fixture-live": plugin },
        adapter: {
          ...codexAdapter,
          id: "codex-rule-resource-test",
          async createSession(context: Parameters<typeof codexAdapter.createSession>[0]) {
            expect(context.ruleResources).toHaveLength(2);
            expect(
              context.ruleResources.find(({ ruleId }) => ruleId === "fixture/flag-value")?.content,
            ).toContain(violationToken);
            const session = await codexAdapter.createSession(context);
            return {
              execute(request) {
                expect(request.prompt).not.toContain(violationToken);
                return session.execute(request);
              },
              dispose: () => session.dispose(),
            };
          },
        },
      });

      console.log(JSON.stringify({ ruleResourcesLive: execution }));
      expect(execution.result.errors).toEqual([]);
      expect(execution.exitCode).toBe(1);
      expect(
        execution.result.diagnostics.some(({ message }) => message.includes(violationToken)),
      ).toBe(true);
      expect(execution.result).not.toHaveProperty("unknowns");
      expect(execution.result.skippedRules).toHaveLength(1);
      expect(execution.result.skippedRules).toEqual(
        expect.arrayContaining([
          { ruleId: "fixture/archive-handle", reason: expect.stringMatching(/\S/) },
        ]),
      );
      expect(execution.result.fileResults).toEqual([
        { path: "fixture.ts", status: "completed", reason: expect.any(String) },
      ]);
      expect(await readFile(join(root, "fixture.ts"), "utf8")).toBe(source);
      expect(await readdir(root)).toEqual(beforeEntries);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  130_000,
);
