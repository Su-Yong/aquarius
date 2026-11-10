import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PathPolicy, PreparedRule } from "@aquarius/core/internal";
import { createLintAnalysis } from "../src/lint/analysis";
import { normalizeLintResponse } from "../src/lint/results";
import type { AnalysisUpdate } from "../src/lint/schemas";
import type { LintAnalysisSnapshot, LintResult } from "../src/lint/types";

const roots: string[] = [];
const rules: PreparedRule[] = [
  {
    id: "fixture/first",
    scope: "file",
    severity: "warn",
    instructions: {
      applicability: "Source files",
      criteria: "Check the contract",
      evidenceRequirements: [],
    },
  },
  {
    id: "fixture/second",
    scope: "project",
    severity: "error",
    instructions: {
      applicability: "Source files",
      criteria: "Check the contract",
      evidenceRequirements: [],
    },
  },
];

const createPolicy = async (): Promise<PathPolicy> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aqlint-analysis-test-")));
  roots.push(root);
  for (const path of ["a.ts", "b.ts", "contract.md", "outside.txt"]) {
    await writeFile(join(root, path), "first line\nsecond line\n");
  }
  return {
    projectRoot: root,
    targets: ["a.ts", "b.ts"],
    readableFiles: ["a.ts", "b.ts", "contract.md"],
    ignoreRules: [],
    isIgnored: (path) => path === "outside.txt",
    canWrite: (path) => path === "a.ts" || path === "b.ts",
  };
};

const diagnostic = (message = "A supported violation", ruleId = "fixture/first") => ({
  ruleIds: [ruleId],
  message,
  locations: [{ path: "a.ts", line: 1, column: 1 }],
  evidence: [{ path: "contract.md", line: 1, message: "The relevant contract" }],
});

const update = (revision: number, changes: Partial<AnalysisUpdate> = {}): AnalysisUpdate => ({
  type: "aquarius.analysis_update",
  revision,
  diagnostics: [],
  fileResults: [],
  ruleResults: [],
  ...changes,
});

const finalResult = async (
  policy: PathPolicy,
  findings = [diagnostic("Final conclusion")],
): Promise<LintResult> => {
  return normalizeLintResponse(
    {
      completedRuleIds: ["fixture/first"],
      skippedRules: [{ ruleId: "fixture/second", reason: "No applicable project contract" }],
      diagnostics: findings,
      errors: [],
      fileResults: [
        { path: "a.ts", status: "completed", reason: "" },
        { path: "b.ts", status: "skipped", reason: "No applicable rule" },
      ],
    },
    rules,
    policy,
  );
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cumulative provisional analysis", () => {
  test("begins pending and never infers review completion from reading a file", async () => {
    const policy = await createPolicy();
    const snapshots: LintAnalysisSnapshot[] = [];
    const analysis = createLintAnalysis(rules, policy, {
      onUpdate: (snapshot) => snapshots.push(snapshot),
    });

    await readFile(join(policy.projectRoot, "a.ts"));
    await analysis.flush();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      phase: "provisional",
      revision: 0,
      diagnostics: [],
    });
    expect(snapshots[0]!.fileResults.map(({ status }) => status)).toEqual(["pending", "pending"]);
    expect(snapshots[0]!.ruleResults.map(({ status }) => status)).toEqual(["pending", "pending"]);
  });

  test("publishes successive additions, revisions and withdrawals before finalization", async () => {
    const policy = await createPolicy();
    const snapshots: LintAnalysisSnapshot[] = [];
    const analysis = createLintAnalysis(rules, policy, {
      onUpdate: (snapshot) => snapshots.push(snapshot),
    });
    analysis.update(
      update(1, {
        diagnostics: [{ id: "D1", diagnostic: diagnostic("Initial finding") }],
        fileResults: [{ path: "a.ts", status: "in_progress", reason: "Checking callers" }],
        ruleResults: [
          { ruleId: "fixture/first", status: "in_progress", reason: "Checking evidence" },
        ],
      }),
    );
    analysis.update(
      update(2, {
        diagnostics: [{ id: "D1", diagnostic: diagnostic("Revised finding") }],
        fileResults: [{ path: "a.ts", status: "completed", reason: "" }],
        ruleResults: [{ ruleId: "fixture/first", status: "completed", reason: "" }],
      }),
    );
    analysis.update(update(3, { diagnostics: [{ id: "D1", diagnostic: null }] }));
    await analysis.flush();

    expect(snapshots.map(({ revision }) => revision)).toEqual([0, 1, 2, 3]);
    expect(snapshots.every(({ phase }) => phase === "provisional")).toBe(true);
    expect(snapshots[1]!.diagnostics[0]!.message).toBe("Initial finding");
    expect(snapshots[2]!.diagnostics[0]!.message).toBe("Revised finding");
    expect(snapshots[3]!.diagnostics).toEqual([]);
    expect(snapshots[1]!.fileResults[0]!.status).toBe("in_progress");
    expect(snapshots[3]!.fileResults[0]!.status).toBe("completed");
    expect(snapshots[3]!.fileResults[1]!.status).toBe("pending");
  });

  test("rejects legacy uncertainty updates without changing the current analysis", async () => {
    const policy = await createPolicy();
    const onUpdate = vi.fn();
    const onWarning = vi.fn();
    const analysis = createLintAnalysis(rules, policy, { onUpdate, onWarning });

    analysis.update({ ...update(1), unknowns: [] });
    await analysis.flush();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.lastCall![0]).not.toHaveProperty("unknowns");
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("INVALID_ANALYSIS_UPDATE"));
  });

  test("groups equivalent findings and recomputes contributors after a withdrawal", async () => {
    const policy = await createPolicy();
    const snapshots: LintAnalysisSnapshot[] = [];
    const analysis = createLintAnalysis(rules, policy, {
      onUpdate: (snapshot) => snapshots.push(snapshot),
    });
    analysis.update(
      update(1, {
        diagnostics: [
          { id: "D1", diagnostic: diagnostic() },
          { id: "D2", diagnostic: diagnostic("A supported violation", "fixture/second") },
        ],
      }),
    );
    await analysis.flush();

    expect(snapshots.at(-1)!.diagnostics).toHaveLength(1);
    expect(snapshots.at(-1)!.diagnostics[0]!.severity).toBe("error");
    expect(snapshots.at(-1)!.diagnostics[0]!.rules).toHaveLength(2);
    analysis.update(update(2, { diagnostics: [{ id: "D2", diagnostic: null }] }));
    await analysis.flush();
    expect(snapshots.at(-1)!.diagnostics[0]!.rules).toEqual([
      { rule: "fixture/first", severity: "warn" },
    ]);
    expect(snapshots.at(-1)!.diagnostics[0]!.severity).toBe("warn");
  });

  test("ignores repeated and out-of-order revisions", async () => {
    const policy = await createPolicy();
    const onUpdate = vi.fn();
    const onWarning = vi.fn();
    const analysis = createLintAnalysis(rules, policy, { onUpdate, onWarning });
    analysis.update(update(3, { diagnostics: [{ id: "D1", diagnostic: diagnostic("Latest") }] }));
    analysis.update(update(2, { diagnostics: [{ id: "D1", diagnostic: diagnostic("Stale") }] }));
    analysis.update(update(3, { diagnostics: [{ id: "D1", diagnostic: null }] }));
    await analysis.flush();

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.lastCall![0].diagnostics[0].message).toBe("Latest");
    expect(onWarning).not.toHaveBeenCalled();
  });

  test("rejects a whole update when a later item has inaccessible evidence", async () => {
    const policy = await createPolicy();
    const onUpdate = vi.fn();
    const onWarning = vi.fn();
    const analysis = createLintAnalysis(rules, policy, { onUpdate, onWarning });
    analysis.update(
      update(1, { diagnostics: [{ id: "D1", diagnostic: diagnostic("Keep this") }] }),
    );
    await analysis.flush();
    const bad = diagnostic("Do not accept this");
    bad.evidence[0]!.path = "outside.txt";
    analysis.update(
      update(2, {
        diagnostics: [
          { id: "D1", diagnostic: null },
          { id: "D2", diagnostic: bad },
        ],
        fileResults: [{ path: "a.ts", status: "completed", reason: "" }],
      }),
    );
    await analysis.flush();

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("INVALID_RESULT_PATH"));
    const current = onUpdate.mock.lastCall![0] as LintAnalysisSnapshot;
    expect(current.revision).toBe(1);
    expect(current.diagnostics[0]!.message).toBe("Keep this");
    expect(current.fileResults[0]!.status).toBe("pending");

    analysis.update(
      update(2, { diagnostics: [{ id: "D1", diagnostic: diagnostic("Valid revision") }] }),
    );
    await analysis.flush();
    expect(onUpdate.mock.lastCall![0].diagnostics[0].message).toBe("Valid revision");
  });

  test.each([
    {
      name: "diagnostic IDs",
      change: {
        diagnostics: [
          { id: "D1", diagnostic: diagnostic() },
          { id: "D1", diagnostic: diagnostic() },
        ],
      },
    },
    {
      name: "file paths",
      change: {
        fileResults: [
          { path: "a.ts", status: "pending" as const, reason: "" },
          { path: "a.ts", status: "completed" as const, reason: "" },
        ],
      },
    },
    {
      name: "rule IDs",
      change: {
        ruleResults: [
          { ruleId: "fixture/first", status: "pending" as const, reason: "" },
          { ruleId: "fixture/first", status: "completed" as const, reason: "" },
        ],
      },
    },
  ])("rejects duplicate $name within a single update", async ({ change }) => {
    const policy = await createPolicy();
    const onUpdate = vi.fn();
    const onWarning = vi.fn();
    const analysis = createLintAnalysis(rules, policy, { onUpdate, onWarning });
    analysis.update(update(1, change));
    await analysis.flush();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("DUPLICATE_ANALYSIS_ITEM"));
  });

  test.each([
    {
      name: "unknown diagnostic withdrawal",
      change: { diagnostics: [{ id: "missing", diagnostic: null }] },
    },
    {
      name: "unselected file",
      change: { fileResults: [{ path: "contract.md", status: "completed" as const, reason: "" }] },
    },
    {
      name: "path traversal",
      change: { fileResults: [{ path: "../a.ts", status: "completed" as const, reason: "" }] },
    },
    {
      name: "unrequested rule",
      change: { ruleResults: [{ ruleId: "other/rule", status: "completed" as const, reason: "" }] },
    },
    {
      name: "empty skip reason",
      change: { fileResults: [{ path: "a.ts", status: "skipped" as const, reason: " " }] },
    },
    {
      name: "empty rule failure reason",
      change: { ruleResults: [{ ruleId: "fixture/first", status: "failed" as const, reason: "" }] },
    },
  ])("rejects $name without changing the prior state", async ({ change }) => {
    const policy = await createPolicy();
    const onUpdate = vi.fn();
    const onWarning = vi.fn();
    const analysis = createLintAnalysis(rules, policy, { onUpdate, onWarning });
    analysis.update(update(1, change));
    await analysis.flush();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  test.each(["file", "rule"])(
    "requires withdrawal before marking a finding's %s skipped",
    async (kind) => {
      const policy = await createPolicy();
      const snapshots: LintAnalysisSnapshot[] = [];
      const onWarning = vi.fn();
      const analysis = createLintAnalysis(rules, policy, {
        onUpdate: (snapshot) => snapshots.push(snapshot),
        onWarning,
      });
      analysis.update(update(1, { diagnostics: [{ id: "D1", diagnostic: diagnostic() }] }));
      const skip: Partial<AnalysisUpdate> =
        kind === "file"
          ? {
              fileResults: [
                { path: "a.ts", status: "skipped", reason: "No applicable prerequisite" },
              ],
            }
          : {
              ruleResults: [
                {
                  ruleId: "fixture/first",
                  status: "skipped",
                  reason: "No applicable prerequisite",
                },
              ],
            };
      analysis.update(update(2, skip));
      await analysis.flush();
      expect(snapshots.at(-1)!.revision).toBe(1);
      expect(onWarning).toHaveBeenCalledTimes(1);

      analysis.update(update(3, { ...skip, diagnostics: [{ id: "D1", diagnostic: null }] }));
      await analysis.flush();
      expect(snapshots.at(-1)!.revision).toBe(3);
      expect(snapshots.at(-1)!.diagnostics).toEqual([]);
      expect(
        kind === "file"
          ? snapshots.at(-1)!.fileResults[0]!.status
          : snapshots.at(-1)!.ruleResults[0]!.status,
      ).toBe("skipped");
    },
  );

  test.each([
    null,
    {},
    { type: "command_execution" },
    update(0),
    update(1, { diagnostics: [{ id: " ", diagnostic: diagnostic() }] }),
  ])("rejects malformed wire input %j", async (raw) => {
    const policy = await createPolicy();
    const onUpdate = vi.fn();
    const onWarning = vi.fn();
    const analysis = createLintAnalysis(rules, policy, { onUpdate, onWarning });
    analysis.update(raw);
    await analysis.flush();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("INVALID_ANALYSIS_UPDATE"));
  });

  test("replaces provisional findings with the validated final result and rejects late updates", async () => {
    const policy = await createPolicy();
    const snapshots: LintAnalysisSnapshot[] = [];
    const analysis = createLintAnalysis(rules, policy, {
      onUpdate: (snapshot) => snapshots.push(snapshot),
    });
    const canonical = await finalResult(policy);
    analysis.update(
      update(1, {
        diagnostics: [{ id: "D1", diagnostic: diagnostic("Withdrawn by final review") }],
      }),
    );
    const finished = analysis.finish(canonical);
    analysis.update(update(2, { diagnostics: [{ id: "D2", diagnostic: diagnostic("Too late") }] }));
    const snapshot = await finished;

    expect(snapshots.map(({ phase }) => phase)).toEqual(["provisional", "provisional", "final"]);
    expect(snapshot.diagnostics).toEqual(canonical.diagnostics);
    expect(snapshot).not.toHaveProperty("unknowns");
    expect(snapshot.fileResults).toEqual(canonical.fileResults);
    expect(snapshot.ruleResults).toEqual([
      { ruleId: "fixture/first", status: "completed", reason: "" },
      { ruleId: "fixture/second", status: "skipped", reason: "No applicable project contract" },
    ]);
    analysis.update(update(99));
    await analysis.flush();
    expect(snapshots).toHaveLength(3);
  });

  test.each(["AI_TIMEOUT", "AI_ABORTED", "CODEX_EXECUTION_FAILED"])(
    "retains validated findings as incomplete for %s",
    async (code) => {
      const policy = await createPolicy();
      const onUpdate = vi.fn();
      const analysis = createLintAnalysis(rules, policy, { onUpdate });
      analysis.update(
        update(1, {
          diagnostics: [{ id: "D1", diagnostic: diagnostic() }],
          fileResults: [{ path: "a.ts", status: "in_progress", reason: "Checking callers" }],
        }),
      );
      const errors = [{ code, message: "The run did not finish", ruleIds: [] }];
      const interrupted = analysis.interrupt(errors);
      analysis.update(update(2, { diagnostics: [{ id: "D1", diagnostic: null }] }));
      const snapshot = await interrupted;

      expect(snapshot.phase).toBe("incomplete");
      expect(snapshot.diagnostics).toHaveLength(1);
      expect(snapshot.errors).toEqual(errors);
      expect(snapshot.fileResults[0]!.status).toBe("in_progress");
      expect(snapshot.fileResults[1]!.status).toBe("pending");
      expect(onUpdate.mock.calls.some(([state]) => state.phase === "final")).toBe(false);
      expect(onUpdate).toHaveBeenCalledTimes(3);
    },
  );

  test("allows canonical provisional results before fixing and later finalization", async () => {
    const policy = await createPolicy();
    const analysis = createLintAnalysis(rules, policy);
    const canonical = await finalResult(policy);
    const provisional = await analysis.finish(canonical, "provisional");
    expect(provisional.phase).toBe("provisional");
    analysis.update(update(99));
    const final = await analysis.finish(canonical);
    expect(final.phase).toBe("final");
    expect(final.revision).toBe(provisional.revision + 1);
    expect(final.diagnostics).toEqual(canonical.diagnostics);
  });

  test("keeps canonical initial results provisional when fixing fails", async () => {
    const policy = await createPolicy();
    const analysis = createLintAnalysis(rules, policy);
    const canonical = await finalResult(policy);
    await analysis.finish(canonical, "provisional");
    const interrupted = await analysis.interrupt([
      { code: "FIX_FAILED", message: "No correction result", ruleIds: [] },
    ]);
    expect(interrupted.phase).toBe("incomplete");
    expect(interrupted.diagnostics).toEqual(canonical.diagnostics);
  });

  test("does not label a failed final response as final", async () => {
    const policy = await createPolicy();
    const analysis = createLintAnalysis(rules, policy);
    analysis.update(
      update(1, { diagnostics: [{ id: "D1", diagnostic: diagnostic("Keep provisional") }] }),
    );
    const invalid = await finalResult(policy);
    invalid.errors.push({
      code: "INVALID_AI_RESPONSE",
      message: "Missing final evidence",
      ruleIds: [],
    });
    const snapshot = await analysis.finish(invalid);
    expect(snapshot.phase).toBe("incomplete");
    expect(snapshot.diagnostics[0]!.message).toBe("Keep provisional");
  });

  test("isolates observer mutations and exceptions from current state", async () => {
    const policy = await createPolicy();
    const received: LintAnalysisSnapshot[] = [];
    const onWarning = vi.fn();
    const analysis = createLintAnalysis(rules, policy, {
      onUpdate: (snapshot) => {
        received.push(structuredClone(snapshot));
        snapshot.fileResults[0]!.reason = "observer mutation";
        if (snapshot.diagnostics[0]) snapshot.diagnostics[0].message = "observer mutation";
        throw new Error("observer exception");
      },
      onWarning,
    });
    const raw = update(1, { diagnostics: [{ id: "D1", diagnostic: diagnostic("Original") }] });
    analysis.update(raw);
    raw.diagnostics[0]!.diagnostic!.message = "input mutation";
    await analysis.flush();
    analysis.update(update(2));
    await analysis.flush();

    expect(received.at(-1)!.diagnostics[0]!.message).toBe("Original");
    expect(received.at(-1)!.fileResults[0]!.reason).toBe("");
    const canonical = await finalResult(policy);
    const final = await analysis.finish(canonical);
    expect(final.diagnostics).toEqual(canonical.diagnostics);
    expect(onWarning).toHaveBeenCalledTimes(4);
  });

  test("does not let rejected asynchronous observers interrupt finalization", async () => {
    const policy = await createPolicy();
    const analysis = createLintAnalysis(rules, policy, {
      onUpdate: async () => {
        throw new Error("Asynchronous observer failure");
      },
      onWarning: async () => {
        throw new Error("Asynchronous warning observer failure");
      },
    });
    const canonical = await finalResult(policy);
    const snapshot = await analysis.finish(canonical);
    expect(snapshot.phase).toBe("final");
    expect(snapshot.diagnostics).toEqual(canonical.diagnostics);
  });
});
