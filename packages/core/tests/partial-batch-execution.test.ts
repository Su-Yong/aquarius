import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  AquariusError,
  createAnalysisState,
  runToolExecution,
  type ReviewResponse,
  type RulePlugin,
  type ToolExecutionHooks,
} from "../src/runtime";

const roots: string[] = [];
const ruleId = "fixture/format";
const plugin: RulePlugin = {
  namespace: "fixture",
  formatRules: [
    {
      id: "format",
      description: "Format a file.",
      scope: "file",
      buildPrompt: () => ({
        applicability: "JavaScript files",
        transformation: "Format source.",
        constraints: ["Preserve behavior."],
      }),
    },
  ],
};

const project = async (fileCount: number): Promise<string> => {
  const cwd = await mkdtemp(join(tmpdir(), "aquarius-partial-batch-"));
  roots.push(cwd);
  await Promise.all([
    writeFile(
      join(cwd, ".aqfmtrc.json"),
      JSON.stringify({ files: ["*.js"], plugins: ["fixture"], rules: { [ruleId]: true } }),
    ),
    ...Array.from({ length: fileCount }, (_, index) =>
      writeFile(join(cwd, `${String(index + 1).padStart(2, "0")}.js`), "export {}"),
    ),
  ]);
  return cwd;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const hooks: ToolExecutionHooks<object, object> = {
  tool: "format",
  continueOnBatchFailure: true,
  retrySingleFileGroup: true,
  afterReviewOnFailure: true,
  reviewProgress: "Reviewing",
  unreviewedFile: { status: "skipped", reason: "Not yet reviewed." },
  preparationFailedFile: { status: "skipped", reason: "Preparation failed." },
  onPreparationError: () => "stop",
  empty: {},
  outputSchema: { type: "object" },
  buildPrompt: (_resources, policy) => policy.targets.join(" "),
  normalize: (_raw, _rules, policy) => ({
    fileResults: policy.targets.map((path) => ({ path, status: "completed", reason: "" })),
    errors: [],
    skippedRules: [],
    retryable: false,
  }),
  createAnalysis: (rules, policy, _resources, options) =>
    createAnalysisState(
      rules,
      policy,
      { parse: () => undefined, initial: {}, apply: () => ({}), final: () => ({}) },
      options,
    ),
  merge: () => ({}),
  mergeAnalysis: () => ({}),
};

test("continues after a group throws and passes all file results to the final review hook", async () => {
  const cwd = await project(5);
  const afterReview = vi.fn(async (response: ReviewResponse) => response);
  const calls: string[] = [];
  const result = await runToolExecution(
    {
      cwd,
      plugins: { fixture: plugin },
      adapter: {
        id: "fixture",
        createSession: () => ({
          execute({ prompt }) {
            calls.push(prompt);
            if (prompt === "02.js") throw new AquariusError("FIXTURE_FAILED", "Group failed.");
          },
          dispose() {},
        }),
      },
      fileBatchSize: 1,
      maxConcurrency: 1,
    },
    { ...hooks, afterReview },
  );

  expect(calls).toEqual(["01.js", "02.js", "03.js", "04.js", "05.js"]);
  expect(result.exitCode).toBe(2);
  expect(result.response.fileResults.map(({ status }) => status)).toEqual([
    "completed",
    "failed",
    "completed",
    "completed",
    "completed",
  ]);
  expect(afterReview).toHaveBeenCalledExactlyOnceWith(
    result.response,
    expect.objectContaining({ targets: calls }),
    [expect.objectContaining({ id: ruleId })],
  );
});

test("retries a single incomplete group before calling its follow-up hook without a group prefix", async () => {
  const cwd = await project(1);
  const progress = vi.fn();
  const calls: string[] = [];
  const session = {
    execute({ prompt, onProgress }: { prompt: string; onProgress?: (message: string) => void }) {
      calls.push(prompt);
      onProgress?.("Fixture activity");
    },
    dispose() {},
  };
  const afterBatch = vi.fn(async (response: ReviewResponse) => response);
  const result = await runToolExecution(
    {
      cwd,
      plugins: { fixture: plugin },
      adapter: { id: "fixture", createSession: () => session },
      onProgress: progress,
    },
    {
      ...hooks,
      normalize: async (...args) => ({
        ...(await hooks.normalize(...args)),
        ...(calls.length === 1 && {
          retryable: true,
          errors: [{ code: "INCOMPLETE_AI_RESPONSE", message: "Incomplete.", ruleIds: [ruleId] }],
        }),
      }),
      afterBatch,
    },
  );

  expect(result.exitCode).toBe(0);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain("INCOMPLETE_AI_RESPONSE");
  expect(progress.mock.calls.filter(([message]) => message.includes("Fixture activity"))).toEqual([
    ["Fixture activity"],
    ["Fixture activity"],
  ]);
  expect(afterBatch).toHaveBeenCalledExactlyOnceWith(
    result.response,
    expect.objectContaining({
      policy: expect.objectContaining({ targets: ["01.js"] }),
      session: expect.objectContaining({ info: { adapter: "fixture" } }),
    }),
  );
});

test("summarizes distinct skip reasons for 35 groups in the response and final snapshot", async () => {
  const cwd = await project(35);
  const onAnalysisUpdate = vi.fn();
  const result = await runToolExecution(
    {
      cwd,
      plugins: { fixture: plugin },
      adapter: {
        id: "fixture",
        createSession: () => ({ execute() {}, dispose() {} }),
      },
      fileBatchSize: 1,
      onAnalysisUpdate,
    },
    {
      ...hooks,
      normalize: async (...args) => ({
        ...(await hooks.normalize(...args)),
        skippedRules: [{ ruleId, reason: `Not applicable to ${args[2].targets[0]}` }],
      }),
    },
  );

  const skipped = { ruleId, reason: "Not applicable to 01.js (+34 more batch reasons)" };
  expect(result.response.skippedRules).toEqual([skipped]);
  expect(onAnalysisUpdate).toHaveBeenLastCalledWith(
    expect.objectContaining({ phase: "final", ruleResults: [{ ...skipped, status: "skipped" }] }),
  );
});

test.each(["cancelled", "disposal failed"] as const)(
  "blocks the final review hook when the batch is %s",
  async (outcome) => {
    const cwd = await project(2);
    const controller = new AbortController();
    const afterReview = vi.fn(async (response: ReviewResponse) => response);
    const execute = vi.fn(() => {
      if (outcome === "cancelled") controller.abort();
    });
    const result = await runToolExecution(
      {
        cwd,
        plugins: { fixture: plugin },
        adapter: {
          id: "fixture",
          createSession: () => ({
            execute,
            dispose() {
              if (outcome === "disposal failed") {
                throw new AquariusError("FIXTURE_FAILED", "Disposal failed.");
              }
            },
          }),
        },
        fileBatchSize: 1,
        maxConcurrency: 1,
        signal: controller.signal,
      },
      { ...hooks, afterReview },
    );

    expect(afterReview).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(outcome === "cancelled" ? 1 : 2);
    expect(result.exitCode).toBe(outcome === "cancelled" ? 130 : 2);
  },
);

test("keeps the follow-up's attributed cancellation without duplicating the cancellation error", async () => {
  const cwd = await project(1);
  const controller = new AbortController();
  const error = { code: "AI_ABORTED", message: "Follow-up cancelled.", ruleIds: [ruleId] };
  const result = await runToolExecution(
    {
      cwd,
      plugins: { fixture: plugin },
      adapter: { id: "fixture", run() {} },
      signal: controller.signal,
    },
    {
      ...hooks,
      afterBatch: async (response) => {
        controller.abort();
        return {
          ...response,
          errors: [error],
          fileResults: [{ path: "01.js", status: "failed", reason: error.message }],
        };
      },
    },
  );

  expect(result.exitCode).toBe(130);
  expect(result.response.errors).toEqual([error]);
  expect(result.response.fileResults[0]?.status).toBe("failed");
});
