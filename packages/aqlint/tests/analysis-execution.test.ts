import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RulePlugin } from "@aqtools/core";
import type { AdapterExecuteRequest, AiAdapter } from "@aqtools/core/runtime";
import { executeLint } from "../src/lint/execute";
import type { AiDiagnostic, AnalysisUpdate } from "../src/lint/schemas";
import type { LintAnalysisSnapshot } from "../src/lint/types";

const projects: string[] = [];
const source = "const value = 1;\n";
const path = "src/main.ts";
const ruleId = "fixture/check";
const plugin: RulePlugin = {
  namespace: "fixture",
  lintRules: [
    {
      id: "check",
      description: "Check the fixture.",
      scope: "file",
      buildPrompt: () => ({
        applicability: "Fixture source files.",
        criteria: "The fixture must use the required value.",
        evidenceRequirements: ["The declaration in the source file."],
      }),
    },
  ],
  presets: {
    all: { [ruleId]: "error" },
  },
};

const project = async (
  timeoutMs = 5_000,
  paths = [path],
  ai: Record<string, unknown> = {},
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "aquarius-analysis-execution-"));
  projects.push(root);
  await mkdir(join(root, "src"));
  await Promise.all(paths.map((target) => writeFile(join(root, target), source)));
  await writeFile(
    join(root, ".aqlintrc.json"),
    JSON.stringify({
      files: ["src/**"],
      plugins: ["fixture"],
      preset: ["fixture/all"],
      ai: { adapter: "@aqtools/codex", timeoutMs, ...ai },
    }),
  );
  return root;
};

const finding = (message: string, target = path, evidencePath = target): AiDiagnostic => ({
  ruleIds: [ruleId],
  message,
  locations: [{ path: target, line: 1, column: 1 }],
  evidence: [{ path: evidencePath, line: 1, message: "The declaration is here." }],
});

const update = (revision: number, changes: Partial<AnalysisUpdate> = {}): AnalysisUpdate => ({
  type: "aquarius.analysis_update",
  revision,
  diagnostics: [],
  fileResults: [],
  ruleResults: [],
  ...changes,
});

const reply = (diagnostics: AiDiagnostic[] = []) => ({
  completedRuleIds: [ruleId],
  skippedRules: [],
  diagnostics,
  errors: [],
  fileResults: [{ path, status: "completed", reason: "" }],
});

const manyRules = (count: number): RulePlugin => {
  const lintRules = Array.from({ length: count }, (_, index) => ({
    ...plugin.lintRules![0]!,
    id: `check-${index}`,
  }));
  return {
    ...plugin,
    lintRules,
    presets: {
      all: Object.fromEntries(lintRules.map(({ id }) => [`fixture/${id}`, "error"])),
    },
  };
};

const manyFiles = (count: number): string[] => [
  path,
  ...Array.from(
    { length: count - 1 },
    (_, index) => `src/part-${String(index + 1).padStart(2, "0")}.ts`,
  ),
];

const targetsFor = (input: AdapterExecuteRequest): string[] =>
  JSON.parse(input.prompt.split("\n\n").at(-1)!).targets;

const batchReply = (input: AdapterExecuteRequest, diagnostics: AiDiagnostic[] = []) => ({
  ...reply(diagnostics),
  completedRuleIds: input.ruleResources.map(({ ruleId }) => ruleId),
  fileResults: targetsFor(input).map((path) => ({ path, status: "completed", reason: "" })),
});

afterEach(async () => {
  await Promise.all(projects.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("incremental lint execution", () => {
  test.each([
    { fileCount: 1, requestCount: 1 },
    { fileCount: 5, requestCount: 2 },
  ])(
    "omits the adapter's update callback for $requestCount request(s) without analysis or warning observers",
    async ({ fileCount, requestCount }) => {
      const root = await project(5_000, manyFiles(fileCount));
      const run = vi.fn(async (input: AdapterExecuteRequest) => batchReply(input));
      const execution = await executeLint({
        cwd: root,
        plugins: { fixture: plugin },
        adapter: { id: "unobserved", run },
      });

      expect(execution.exitCode).toBe(0);
      expect(run).toHaveBeenCalledTimes(requestCount);
      for (const [input] of run.mock.calls) {
        expect(input.onAnalysisUpdate).toBeUndefined();
      }
    },
  );

  test("forwards every repeated warning to a programmatic observer", async () => {
    const root = await project();
    const onWarning = vi.fn();
    const execution = await executeLint({
      cwd: root,
      plugins: { fixture: plugin },
      onWarning,
      adapter: {
        id: "warnings-only",
        run: async (input) => {
          const invalid = { ...update(1), revision: "1" };
          input.onAnalysisUpdate?.(invalid);
          input.onAnalysisUpdate?.(invalid);
          return batchReply(input);
        },
      },
    });

    const warning =
      "Ignored a provisional analysis update (INVALID_ANALYSIS_UPDATE): revision Invalid input: expected number, received string";
    expect(execution.exitCode).toBe(0);
    expect(onWarning.mock.calls).toEqual([[warning], [warning]]);
  });

  test.each([false, true])(
    "retries incomplete file groups once without discarding another group's findings: %s",
    async (stillIncomplete) => {
      const targets = manyFiles(5);
      const root = await project(5_000, targets);
      let attempts = 0;
      const snapshots: LintAnalysisSnapshot[] = [];
      const execution = await executeLint({
        cwd: root,
        onAnalysisUpdate: (snapshot) => snapshots.push(snapshot),
        plugins: { fixture: plugin },
        adapter: {
          id: "retry-incomplete",
          run: async (input) => {
            const batch = targetsFor(input);
            if (!batch.includes(path)) {
              return batchReply(input, [finding("Independent finding", batch[0]!)]);
            }
            attempts += 1;
            if (attempts === 2) {
              expect(input.prompt).toContain("previous attempt");
              await vi.waitFor(() =>
                expect(snapshots.at(-1)!.diagnostics.map(({ message }) => message)).toEqual([
                  "Independent finding",
                ]),
              );
              expect(snapshots.at(-1)!.fileResults.some(({ status }) => status === "failed")).toBe(
                false,
              );
            }
            if (attempts === 1 || stillIncomplete) {
              input.onAnalysisUpdate?.(
                update(1, {
                  fileResults: [{ path, status: "failed", reason: "Review did not finish." }],
                  diagnostics: [{ id: "D1", diagnostic: finding("Tentative finding") }],
                }),
              );
              await vi.waitFor(() =>
                expect(snapshots.at(-1)!.diagnostics.map(({ message }) => message)).toEqual(
                  expect.arrayContaining(["Tentative finding", "Independent finding"]),
                ),
              );
              return {
                ...batchReply(input),
                completedRuleIds: [],
                errors: [
                  {
                    code: "INCOMPLETE_FILE_REVIEW",
                    message: "Review did not finish.",
                    ruleIds: [],
                  },
                ],
                fileResults: batch.map((path) => ({
                  path,
                  status: "failed",
                  reason: "Review did not finish.",
                })),
              };
            }
            return batchReply(input);
          },
        },
      });

      expect(attempts).toBe(2);
      expect(execution.exitCode).toBe(stillIncomplete ? 2 : 1);
      expect(execution.result.diagnostics.map(({ message }) => message)).toEqual([
        "Independent finding",
      ]);
      expect(execution.result.errors).toHaveLength(stillIncomplete ? 1 : 0);
      expect(execution.result.summary.successFiles).toBe(stillIncomplete ? 0 : 4);
      expect(snapshots.at(-1)!.phase).toBe(stillIncomplete ? "incomplete" : "final");
      expect(snapshots.at(-1)!.diagnostics).toHaveLength(stillIncomplete ? 2 : 1);
    },
  );

  test("batches files with every rule, full context, and isolated provisional finding IDs", async () => {
    const targets = manyFiles(13);
    const contextPath = "src/context.ts";
    const root = await project(5_000, [...targets, contextPath]);
    const snapshots: LintAnalysisSnapshot[] = [];
    const warnings: string[] = [];
    const requested: string[][] = [];
    let active = 0;
    let peak = 0;
    const adapter: AiAdapter = {
      id: "batched",
      run: async (input) => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          const metadata = JSON.parse(input.prompt.split("\n\n").at(-1)!);
          const batch = targetsFor(input);
          const ids = input.ruleResources.map(({ ruleId }) => ruleId);
          requested.push(batch);
          expect(batch.length).toBeLessThanOrEqual(4);
          expect(ids).toHaveLength(35);
          expect(metadata.rules.map(({ ruleId }: { ruleId: string }) => ruleId)).toEqual(ids);
          expect(input.readableFiles).toEqual([".aqlintrc.json", ...targets, contextPath].sort());
          const firstPath = batch[0]!;
          const provisional = {
            ...finding(`${firstPath} provisional`, firstPath, contextPath),
            ruleIds: [ids[0]!],
          };
          input.onAnalysisUpdate?.(
            update(1, {
              diagnostics: [{ id: "D1", diagnostic: provisional }],
              fileResults: batch.map((path) => ({ path, status: "completed", reason: "" })),
            }),
          );
          await vi.waitFor(() =>
            expect(
              snapshots.at(-1)!.diagnostics.some(({ message }) => message === provisional.message),
            ).toBe(true),
          );
          if (firstPath === path) {
            input.onAnalysisUpdate?.(update(2, { diagnostics: [{ id: "D1", diagnostic: null }] }));
            await vi.waitFor(() =>
              expect(
                snapshots
                  .at(-1)!
                  .diagnostics.some(({ message }) => message === provisional.message),
              ).toBe(false),
            );
            return batchReply(input);
          }
          return batchReply(input, [
            { ...finding(`${firstPath} final`, firstPath, contextPath), ruleIds: [ids[0]!] },
          ]);
        } finally {
          active -= 1;
        }
      },
    };
    const execution = await executeLint({
      cwd: root,
      paths: targets,
      onAnalysisUpdate: (snapshot) => snapshots.push(snapshot),
      onWarning: (message) => warnings.push(message),
      plugins: { fixture: manyRules(35) },
      adapter,
    });

    expect(execution.exitCode).toBe(1);
    expect(execution.result.errors).toEqual([]);
    expect(requested.map((batch) => batch.length)).toEqual([4, 4, 4, 1]);
    expect(requested.flat().sort()).toEqual(targets);
    expect(peak).toBe(3);
    expect(warnings).toEqual([]);
    expect(execution.result.diagnostics.map(({ message }) => message)).toEqual(
      [targets[4], targets[8], targets[12]].map((path) => `${path} final`),
    );
    expect(execution.result.summary).toMatchObject({
      totalFiles: 13,
      successFiles: 10,
      warningFiles: 0,
      failedFiles: 3,
      activeRules: 35,
    });
    expect(
      snapshots.some(
        ({ phase, fileResults }) =>
          phase === "provisional" &&
          fileResults.some(({ status }) => status === "completed") &&
          fileResults.some(({ status }) => status === "pending"),
      ),
    ).toBe(true);
    expect(snapshots.at(-1)!.diagnostics).toEqual(execution.result.diagnostics);
    expect(snapshots.at(-1)!.ruleResults.every(({ status }) => status === "completed")).toBe(true);
  });

  test("does not split a single file when many rules are active", async () => {
    const root = await project();
    const run = vi.fn(async (input: AdapterExecuteRequest) => {
      expect(input.ruleResources).toHaveLength(35);
      expect(targetsFor(input)).toEqual([path]);
      return batchReply(input);
    });
    const execution = await executeLint({
      cwd: root,
      plugins: { fixture: manyRules(35) },
      adapter: { id: "one", run },
    });

    expect(execution.exitCode).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("reports completed, failed, cancelled, and unstarted file groups", async () => {
    const targets = manyFiles(5);
    const root = await project(5_000, targets);
    const [completed, failed, cancelled, ...unstarted] = targets;
    const secondRule = "fixture/second";
    const snapshots: LintAnalysisSnapshot[] = [];
    const scopedPlugin: RulePlugin = {
      ...plugin,
      lintRules: [...plugin.lintRules!, { ...plugin.lintRules![0]!, id: "second" }],
      presets: { all: { [ruleId]: "error", [secondRule]: "error" } },
    };
    const error = {
      code: "READ_FAILED",
      message: "Rule details unavailable.",
      ruleIds: [ruleId],
    };
    const groupStarted = Promise.withResolvers<void>();
    const dispose = vi.fn();
    const execute = vi.fn(async (input: AdapterExecuteRequest) => {
      const target = targetsFor(input)[0]!;
      if (target === completed) {
        return batchReply(input, [finding("Confirmed finding", target)]);
      }
      if (target === failed) {
        await groupStarted.promise;
        return {
          ...batchReply(input),
          completedRuleIds: [secondRule],
          errors: [error],
          fileResults: [
            {
              path: target,
              status: "failed",
              reason: "Rule details unavailable.",
            },
          ],
        };
      }
      expect(target).toBe(cancelled);
      input.onAnalysisUpdate?.(
        update(1, {
          ruleResults: [{ ruleId: secondRule, status: "completed", reason: "" }],
        }),
      );
      await vi.waitFor(() => {
        expect(
          snapshots.at(-1)?.ruleResults.find(({ ruleId }) => ruleId === secondRule)?.status,
        ).toBe("in_progress");
      });
      groupStarted.resolve();
      return await new Promise((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
      });
    });
    const createSession = vi.fn(() => ({ execute, dispose }));

    const execution = await executeLint({
      cwd: root,
      fileBatchSize: 1,
      maxConcurrency: 2,
      plugins: { fixture: scopedPlugin },
      onAnalysisUpdate: (snapshot) => snapshots.push(snapshot),
      adapter: { id: "partial-batch-failure", createSession },
    });

    expect(execution.exitCode).toBe(2);
    expect(createSession).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(3);
    expect(dispose).toHaveBeenCalledOnce();
    expect(execution.result.errors).toEqual([error]);
    expect(snapshots.at(-1)).toMatchObject({
      phase: "incomplete",
      ruleResults: [
        { ruleId, status: "failed", reason: error.message },
        {
          ruleId: secondRule,
          status: "failed",
          reason: expect.stringContaining("every file group"),
        },
      ],
    });
    expect(execution.result.diagnostics.map(({ message }) => message)).toEqual([
      "Confirmed finding",
    ]);
    expect(execution.result.fileResults).toEqual([
      { path: completed, status: "completed", reason: "" },
      { path: failed, status: "failed", reason: "Rule details unavailable." },
      {
        path: cancelled,
        status: "skipped",
        reason: "Cancelled because another file group failed.",
      },
      ...unstarted.map((path) => ({
        path,
        status: "skipped",
        reason: "Not started because another file group failed.",
      })),
    ]);
  });

  test.each(["module", "project"] as const)(
    "does not divide the scope of a %s rule",
    async (scope) => {
      const targets = manyFiles(5);
      const root = await project(5_000, targets);
      const scopedPlugin: RulePlugin = {
        ...plugin,
        lintRules: [{ ...plugin.lintRules![0]!, scope }],
      };
      const run = vi.fn(async (input: AdapterExecuteRequest) => {
        expect(targetsFor(input)).toEqual(targets);
        return batchReply(input);
      });
      const execution = await executeLint({
        cwd: root,
        fileBatchSize: 1,
        plugins: { fixture: scopedPlugin },
        adapter: { id: "scoped", run },
      });

      expect(execution.exitCode).toBe(0);
      expect(run).toHaveBeenCalledOnce();
      expect(execution.result.summary.successFiles).toBe(targets.length);
    },
  );

  test("reports a rule as skipped only when every file batch skips it", async () => {
    const targets = manyFiles(9);
    const root = await project(5_000, targets);
    const execution = await executeLint({
      cwd: root,
      plugins: { fixture: manyRules(17) },
      adapter: {
        id: "all-batches-skipped",
        run: async (input) => ({
          ...batchReply(input),
          completedRuleIds: [],
          skippedRules: input.ruleResources.map(({ ruleId }) => ({
            ruleId,
            reason: "No matching prerequisite.",
          })),
          fileResults: targetsFor(input).map((path) => ({
            path,
            status: "skipped",
            reason: "No matching prerequisite.",
          })),
        }),
      },
    });

    expect(execution.exitCode).toBe(0);
    expect(execution.result.skippedRules).toHaveLength(17);
    expect(new Set(execution.result.skippedRules.map(({ ruleId }) => ruleId)).size).toBe(17);
    expect(execution.result.fileResults.map(({ status }) => status)).toEqual(
      targets.map(() => "skipped"),
    );
    expect(execution.result.summary.skippedFiles).toBe(9);
  });

  test("publishes canonical file outcomes and retains provisional findings in the incomplete snapshot", async () => {
    const targets = manyFiles(5);
    const failedPath = targets[1]!;
    const root = await project(5_000, targets);
    const snapshots: LintAnalysisSnapshot[] = [];
    const warnings: string[] = [];
    const execution = await executeLint({
      cwd: root,
      onAnalysisUpdate: (snapshot) => snapshots.push(snapshot),
      onWarning: (message) => warnings.push(message),
      plugins: { fixture: plugin },
      adapter: {
        id: "incomplete-skipped-file",
        run: async (input) => {
          const batch = targetsFor(input);
          if (!batch.includes(path)) return batchReply(input);

          input.onAnalysisUpdate?.(
            update(1, {
              diagnostics: [{ id: "D1", diagnostic: finding("Tentative finding") }],
              fileResults: [{ path, status: "in_progress", reason: "Checking the source." }],
              ruleResults: [{ ruleId, status: "in_progress", reason: "Review is ongoing." }],
            }),
          );
          await vi.waitFor(() => expect(snapshots.at(-1)!.diagnostics).toHaveLength(1));
          return {
            ...batchReply(input),
            fileResults: batch.map((target) => {
              if (target === path) {
                return { path: target, status: "skipped", reason: "No applicable rule." };
              }
              if (target === failedPath) {
                return { path: target, status: "failed", reason: "Source review failed." };
              }
              return { path: target, status: "completed", reason: "" };
            }),
          };
        },
      },
    });

    expect(execution.exitCode).toBe(2);
    expect(warnings).toEqual([]);
    expect(execution.result.diagnostics).toEqual([]);
    expect(execution.result.fileResults.find((file) => file.path === path)?.status).toBe("skipped");
    const latest = snapshots.at(-1)!;
    expect(latest.phase).toBe("incomplete");
    expect(latest.diagnostics.map(({ message }) => message)).toEqual(["Tentative finding"]);
    expect(latest.fileResults.find((file) => file.path === path)?.status).toBe("skipped");
    expect(latest.fileResults.find((file) => file.path === failedPath)?.status).toBe("failed");
    expect(latest.ruleResults[0]!.status).toBe("failed");
  });

  test("keeps a rule in progress when one batch skips it and another still needs review", async () => {
    const targets = manyFiles(2);
    const root = await project(5_000, targets);
    const snapshots: LintAnalysisSnapshot[] = [];
    const warnings: string[] = [];
    const execution = await executeLint({
      cwd: root,
      fileBatchSize: 1,
      maxConcurrency: 1,
      onAnalysisUpdate: (snapshot) => snapshots.push(snapshot),
      onWarning: (message) => warnings.push(message),
      plugins: { fixture: plugin },
      adapter: {
        id: "mixed-rule-outcomes",
        run: async (input) => {
          const target = targetsFor(input)[0]!;
          if (target === path) {
            return {
              ...batchReply(input),
              completedRuleIds: [],
              skippedRules: [{ ruleId, reason: "No applicable prerequisite in this file." }],
              fileResults: [{ path: target, status: "skipped", reason: "No applicable rule." }],
            };
          }
          await vi.waitFor(() => expect(snapshots.at(-1)!.fileResults[0]!.status).toBe("skipped"));
          expect(snapshots.at(-1)!.ruleResults[0]!.status).toBe("in_progress");
          input.onAnalysisUpdate?.(
            update(1, {
              diagnostics: [{ id: "D1", diagnostic: finding("Applicable here", target) }],
              ruleResults: [{ ruleId, status: "in_progress", reason: "Checking this file." }],
            }),
          );
          await vi.waitFor(() => expect(snapshots.at(-1)!.diagnostics).toHaveLength(1));
          return batchReply(input, [finding("Applicable here", target)]);
        },
      },
    });

    expect(execution.exitCode).toBe(1);
    expect(warnings).toEqual([]);
    expect(execution.result.skippedRules).toEqual([]);
    expect(execution.result.summary).toMatchObject({
      successFiles: 0,
      skippedFiles: 1,
      failedFiles: 1,
    });
    expect(snapshots.at(-1)!.ruleResults).toEqual([{ ruleId, status: "completed", reason: "" }]);
  });

  test("does not silently accept a removed unknown result from a file batch", async () => {
    const root = await project(5_000, manyFiles(5));
    const execution = await executeLint({
      cwd: root,
      maxConcurrency: 1,
      plugins: { fixture: plugin },
      adapter: {
        id: "legacy-result",
        run: async (input) => ({ ...batchReply(input), unknowns: [] }),
      },
    });

    expect(execution.exitCode).toBe(2);
    expect(execution.result.errors).toContainEqual(
      expect.objectContaining({ code: "INVALID_AI_RESPONSE" }),
    );
    expect(execution.result.summary).toMatchObject({
      successFiles: 0,
      failedFiles: 4,
      skippedFiles: 1,
    });
    expect(execution.result).not.toHaveProperty("unknowns");
  });

  test.each(["diagnostic", "file status"])(
    "rejects a primary %s outside its file batch",
    async (kind) => {
      const targets = manyFiles(5);
      const root = await project(5_000, targets);
      const execution = await executeLint({
        cwd: root,
        plugins: { fixture: plugin },
        adapter: {
          id: "foreign-target",
          run: async (input) => {
            const result = batchReply(input);
            if (!targetsFor(input).includes(path)) return result;
            if (kind === "diagnostic") {
              result.diagnostics.push(finding("Outside this batch", targets[4]!));
            } else {
              result.fileResults.push({ path: targets[4]!, status: "completed", reason: "" });
            }
            return result;
          },
        },
      });

      expect(execution.exitCode).toBe(2);
      const errorCode = kind === "diagnostic" ? "INVALID_RESULT_LOCATION" : "INVALID_RESULT_PATH";
      expect(execution.result.errors.some(({ code }) => code === errorCode)).toBe(true);
      expect(execution.result.diagnostics).toEqual([]);
      expect(execution.result.fileResults).toHaveLength(targets.length);
    },
  );

  test("cancels active file groups, starts no queued groups, and ignores late updates", async () => {
    const root = await project(5_000, manyFiles(13));
    const controller = new AbortController();
    const requests: AdapterExecuteRequest[] = [];
    const snapshots: LintAnalysisSnapshot[] = [];
    const execution = await executeLint({
      cwd: root,
      signal: controller.signal,
      onAnalysisUpdate: (snapshot) => snapshots.push(snapshot),
      plugins: { fixture: plugin },
      adapter: {
        id: "cancel-batches",
        run: async (input) => {
          requests.push(input);
          if (requests.length === 3) controller.abort();
          return new Promise(() => {});
        },
      },
    });

    expect(execution.exitCode).toBe(130);
    expect(requests).toHaveLength(3);
    expect(requests.every(({ signal }) => signal.aborted)).toBe(true);
    expect(snapshots.at(-1)!.phase).toBe("incomplete");
    const count = snapshots.length;
    for (const request of requests) request.onAnalysisUpdate?.(update(99));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(snapshots).toHaveLength(count);
  });

  test.each([
    { label: "configuration", overrides: {}, expectedSizes: [2, 2, 2, 1], expectedPeak: 2 },
    {
      label: "execution overrides",
      overrides: { fileBatchSize: 3, maxConcurrency: 1 },
      expectedSizes: [3, 3, 1],
      expectedPeak: 1,
    },
    {
      label: "limits above target count",
      overrides: { fileBatchSize: 20, maxConcurrency: 20 },
      expectedSizes: [7],
      expectedPeak: 1,
    },
  ])(
    "uses $label for file batch size and concurrency",
    async ({ overrides, expectedSizes, expectedPeak }) => {
      const targets = manyFiles(7);
      const root = await project(5_000, targets, { fileBatchSize: 2, maxConcurrency: 2 });
      const requested: string[][] = [];
      let active = 0;
      let peak = 0;
      const execution = await executeLint({
        cwd: root,
        ...overrides,
        plugins: { fixture: plugin },
        adapter: {
          id: "configured-limits",
          run: async (input) => {
            requested.push(targetsFor(input));
            active += 1;
            peak = Math.max(peak, active);
            try {
              await new Promise<void>((resolve) => setImmediate(resolve));
              return batchReply(input);
            } finally {
              active -= 1;
            }
          },
        },
      });

      expect(execution.exitCode).toBe(0);
      expect(requested.map((batch) => batch.length)).toEqual(expectedSizes);
      expect(requested.flat()).toEqual(targets);
      expect(peak).toBe(expectedPeak);
    },
  );

  test.each(
    (["fileBatchSize", "maxConcurrency"] as const).flatMap((option) =>
      [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].map(
        (value) => ({ option, value }),
      ),
    ),
  )(
    "rejects invalid execution option $option=$value before calling AI",
    async ({ option, value }) => {
      const root = await project();
      const run = vi.fn(async (input: AdapterExecuteRequest) => batchReply(input));
      const execution = await executeLint({
        cwd: root,
        [option]: value,
        plugins: { fixture: plugin },
        adapter: { id: "invalid-limits", run },
      });

      expect(execution.exitCode).toBe(2);
      expect(execution.result.errors[0]?.code).toBe("INVALID_ARGUMENTS");
      expect(run).not.toHaveBeenCalled();
    },
  );

  test("publishes additions, revisions, and withdrawals before the final response", async () => {
    const root = await project();
    const snapshots: LintAnalysisSnapshot[] = [];
    const observedBeforeFinal: boolean[] = [];
    let returningFinal = false;
    const adapter: AiAdapter = {
      id: "incremental",
      run: async (input) => {
        input.onProgress?.(`Inspecting ${path}`);
        expect(snapshots.at(-1)!.fileResults[0]!.status).toBe("pending");
        input.onAnalysisUpdate?.(
          update(1, {
            diagnostics: [{ id: "D1", diagnostic: finding("First interpretation") }],
            fileResults: [{ path, status: "in_progress", reason: "Checking the rule." }],
            ruleResults: [{ ruleId, status: "in_progress", reason: "Checking the source." }],
          }),
        );
        await vi.waitFor(() => expect(snapshots.at(-1)!.revision).toBe(1));
        expect(snapshots.at(-1)!.diagnostics.map(({ message }) => message)).toEqual([
          "First interpretation",
        ]);

        input.onAnalysisUpdate?.(
          update(2, {
            diagnostics: [{ id: "D1", diagnostic: finding("Revised interpretation") }],
          }),
        );
        await vi.waitFor(() => expect(snapshots.at(-1)!.revision).toBe(2));
        expect(snapshots.at(-1)!.diagnostics.map(({ message }) => message)).toEqual([
          "Revised interpretation",
        ]);

        input.onAnalysisUpdate?.(
          update(3, {
            diagnostics: [{ id: "D1", diagnostic: null }],
            fileResults: [{ path, status: "completed", reason: "All applicable checks finished." }],
            ruleResults: [{ ruleId, status: "completed", reason: "All target scope checked." }],
          }),
        );
        await vi.waitFor(() => expect(snapshots.at(-1)!.revision).toBe(3));
        expect(snapshots.at(-1)!.diagnostics).toEqual([]);
        expect(snapshots.at(-1)!.phase).toBe("provisional");
        returningFinal = true;
        return reply();
      },
    };
    const execution = await executeLint({
      cwd: root,
      onAnalysisUpdate: (snapshot) => {
        if (snapshot.phase === "provisional" && snapshot.revision > 0) {
          observedBeforeFinal.push(!returningFinal);
        }
        snapshots.push(snapshot);
      },
      plugins: { fixture: plugin },
      adapter,
    });

    expect(execution.exitCode).toBe(0);
    expect(observedBeforeFinal).toEqual([true, true, true]);
    expect(
      snapshots.filter(({ phase, revision }) => phase === "provisional" && revision > 0),
    ).toHaveLength(3);
    expect(snapshots.at(-1)!.phase).toBe("final");
    expect(snapshots.at(-1)!.diagnostics).toEqual(execution.result.diagnostics);
    expect(snapshots.at(-1)!.fileResults).toEqual(execution.result.fileResults);
    expect(snapshots.at(-1)!.ruleResults).toEqual([{ ruleId, status: "completed", reason: "" }]);
    expect(execution.result).not.toHaveProperty("type");
    expect(execution.result).not.toHaveProperty("revision");
  });

  test("replaces provisional findings with the canonical final JSON", async () => {
    const root = await project();
    const snapshots: LintAnalysisSnapshot[] = [];
    const adapter: AiAdapter = {
      id: "reconcile",
      run: async (input) => {
        input.onAnalysisUpdate?.(
          update(1, {
            diagnostics: [{ id: "D1", diagnostic: finding("Superseded finding") }],
          }),
        );
        await vi.waitFor(() => expect(snapshots.at(-1)!.revision).toBe(1));
        return reply([finding("Final finding")]);
      },
    };
    const execution = await executeLint({
      cwd: root,
      onAnalysisUpdate: (value) => snapshots.push(value),
      plugins: { fixture: plugin },
      adapter,
    });

    expect(execution.exitCode).toBe(1);
    expect(snapshots.at(-1)!.diagnostics).toEqual(execution.result.diagnostics);
    expect(snapshots.at(-1)!.diagnostics.map(({ message }) => message)).toEqual(["Final finding"]);
    expect(snapshots.at(-1)!.phase).toBe("final");
  });

  test.each(["timeout", "adapter failure", "invalid final"])(
    "preserves findings as incomplete after %s without promoting them into final JSON",
    async (failure) => {
      const root = await project(failure === "timeout" ? 500 : 5_000);
      const snapshots: LintAnalysisSnapshot[] = [];
      let request: AdapterExecuteRequest | undefined;
      const adapter: AiAdapter = {
        id: "interrupted",
        run: async (input) => {
          request = input;
          input.onAnalysisUpdate?.(
            update(1, {
              diagnostics: [{ id: "D1", diagnostic: finding("Provisional finding") }],
              fileResults: [{ path, status: "in_progress", reason: "Review is ongoing." }],
            }),
          );
          await vi.waitFor(() => expect(snapshots.at(-1)!.revision).toBe(1));
          if (failure === "timeout") return new Promise(() => {});
          if (failure === "adapter failure") throw new Error("Fixture adapter failed.");
          return {};
        },
      };
      const execution = await executeLint({
        cwd: root,
        onAnalysisUpdate: (value) => snapshots.push(value),
        plugins: { fixture: plugin },
        adapter,
      });

      expect(execution.exitCode).toBe(2);
      expect(execution.result.errors.length).toBeGreaterThan(0);
      expect(execution.result.diagnostics).toEqual([]);
      expect(execution.result.fileResults[0]!.status).toBe("failed");
      expect(snapshots.some(({ phase }) => phase === "final")).toBe(false);
      expect(snapshots.at(-1)!.phase).toBe("incomplete");
      expect(snapshots.at(-1)!.diagnostics[0]!.message).toBe("Provisional finding");
      const count = snapshots.length;
      request!.onAnalysisUpdate?.(update(9, { diagnostics: [{ id: "D1", diagnostic: null }] }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(snapshots).toHaveLength(count);
    },
  );
});
