import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadConfig, resolveBridge } from "@aquarius/core/internal";
import type { RulePlugin } from "@aquarius/core";
import { executeLint } from "../src/lint/execute";
import type { LintAnalysisSnapshot } from "../src/lint/types";

const liveTest = process.env.AQUARIUS_ANALYSIS_LIVE === "1" ? test : test.skip;

liveTest(
  "receives repeated provisional reports from Codex before reconciling its final JSON",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aquarius-analysis-live-"));
    const token = `CHECKED_RULE_${randomUUID()}`;
    const files = {
      "src/first.ts": 'export const fixtureFlag = "bad";\n',
      "src/second.ts": 'export const fixtureFlag = "good";\n',
      "src/third.ts": 'export const fixtureFlag = "bad";\n',
    };
    const plugin: RulePlugin = {
      namespace: "fixture",
      lintRules: [
        {
          id: "flag-value",
          description: "Check fixtureFlag literal values.",
          scope: "file",
          buildPrompt: () => ({
            applicability: "Files exporting a constant named fixtureFlag.",
            criteria:
              'The fixture contract requires fixtureFlag to equal "good". A literal "bad" violates it. ' +
              `Include ${token} in this rule's diagnostic message.`,
            evidenceRequirements: ["The fixtureFlag declaration and its literal value."],
          }),
        },
      ],
    };
    const snapshots: LintAnalysisSnapshot[] = [];
    const reportsBeforeFinal: LintAnalysisSnapshot[] = [];
    const warnings: string[] = [];
    let adapterReturned = false;

    try {
      await mkdir(join(root, "src"));
      for (const [path, text] of Object.entries(files)) {
        await writeFile(join(root, path), text);
      }
      await writeFile(
        join(root, ".aqlintrc.json"),
        JSON.stringify({
          files: ["src/**/*.ts"],
          plugins: ["fixture-live"],
          rules: { "fixture/flag-value": "error" },
          ai: { adapter: "codex", options: { reasoningEffort: "low" }, timeoutMs: 120_000 },
        }),
      );
      const beforeEntries = await readdir(root, { recursive: true });
      const bridge = await resolveBridge(await loadConfig("lint", { cwd: root }));
      const execution = await executeLint(
        {
          cwd: root,
          onWarning: (message) => warnings.push(message),
          onAnalysisUpdate: (snapshot) => {
            snapshots.push(snapshot);
            if (!adapterReturned && snapshot.phase === "provisional" && snapshot.revision > 0) {
              reportsBeforeFinal.push(snapshot);
            }
          },
        },
        { "fixture-live": plugin },
        {
          id: "codex-incremental-live",
          run: async (input) => {
            expect(input.prompt).not.toContain(token);
            const result = await bridge.run(input);
            adapterReturned = true;
            return result;
          },
        },
      );

      console.log(
        JSON.stringify({
          incrementalLive: {
            exitCode: execution.exitCode,
            errors: execution.result.errors,
            updatesBeforeFinal: reportsBeforeFinal.length,
            findingsBeforeFinal: reportsBeforeFinal.filter(
              ({ diagnostics }) => diagnostics.length > 0,
            ).length,
            finalPhase: snapshots.at(-1)?.phase,
            warnings,
            reports: reportsBeforeFinal.map((snapshot) => ({
              revision: snapshot.revision,
              diagnostics: snapshot.diagnostics.length,
              files: snapshot.fileResults.map(({ path, status }) => ({ path, status })),
              rules: snapshot.ruleResults.map(({ ruleId, status }) => ({ ruleId, status })),
            })),
          },
        }),
      );
      expect(execution.result.errors).toEqual([]);
      expect(warnings).toEqual([]);
      expect(execution.exitCode).toBe(1);
      expect(reportsBeforeFinal.length).toBeGreaterThanOrEqual(3);
      expect(
        reportsBeforeFinal.some(({ diagnostics }) =>
          diagnostics.some(({ message }) => message.includes(token)),
        ),
      ).toBe(true);
      expect(
        reportsBeforeFinal.some(({ fileResults }) =>
          fileResults.some(({ status }) => status === "in_progress"),
        ),
      ).toBe(true);
      expect(snapshots.at(-1)!.phase).toBe("final");
      expect(snapshots.at(-1)!.diagnostics).toEqual(execution.result.diagnostics);
      expect(snapshots.at(-1)!.fileResults).toEqual(execution.result.fileResults);
      for (const [path, text] of Object.entries(files)) {
        expect(await readFile(join(root, path), "utf8")).toBe(text);
      }
      expect(await readdir(root, { recursive: true })).toEqual(beforeEntries);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  130_000,
);
