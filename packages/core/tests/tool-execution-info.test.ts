import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  AquariusError,
  createAnalysisState,
  reviewUpdateFields,
  runToolExecution,
  type AdapterExecuteRequest,
  type AdapterRunInfo,
  type ProjectConfig,
  type RulePlugin,
  type ToolExecutionHooks,
} from "../src/runtime";

const roots: string[] = [];
const plugin: RulePlugin = {
  namespace: "fixture",
  lintRules: [
    {
      id: "check",
      description: "Check a file.",
      scope: "file",
      buildPrompt: () => ({
        applicability: "JavaScript files",
        criteria: "Inspect the source.",
        evidenceRequirements: ["source"],
      }),
    },
  ],
};

const project = async (config: ProjectConfig = {}): Promise<string> => {
  const cwd = await mkdtemp(join(tmpdir(), "aquarius-execution-info-"));
  roots.push(cwd);
  await Promise.all([
    writeFile(join(cwd, "first.js"), "export {}"),
    writeFile(join(cwd, "second.js"), "export {}"),
    writeFile(
      join(cwd, ".aqlintrc.json"),
      JSON.stringify({
        files: ["*.js"],
        plugins: ["fixture"],
        rules: { "fixture/check": "error" },
        ...config,
      }),
    ),
  ]);
  return cwd;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const hooks: ToolExecutionHooks<object, object> = {
  tool: "lint",
  reviewProgress: "Reviewing",
  unreviewedFile: { status: "skipped", reason: "Not yet reviewed." },
  preparationFailedFile: { status: "failed", reason: "Preparation failed." },
  onPreparationError: () => "stop",
  empty: {},
  outputSchema: { type: "object" },
  buildPrompt: () => "Inspect these files.",
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
      {
        schema: z.strictObject(reviewUpdateFields),
        initial: {},
        apply: () => ({}),
        final: () => ({}),
      },
      options,
    ),
  merge: () => ({}),
  mergeAnalysis: () => ({}),
};

const info: AdapterRunInfo = {
  adapter: "fixture",
  model: "fixture-model",
  details: { serviceTier: "fast" },
};

test.each([
  { fileBatchSize: 4, batches: 1 },
  { fileBatchSize: 1, batches: 2 },
])(
  "publishes session info once before reviewing $batches file group(s)",
  async ({ fileBatchSize, batches }) => {
    const cwd = await project();
    const onAdapterInfo = vi.fn();
    const execute = vi.fn<(request: AdapterExecuteRequest) => void>();
    const dispose = vi.fn();
    const createSession = vi.fn(() => ({ info, execute, dispose }));
    const createAnalysis = vi.fn(hooks.createAnalysis);

    const result = await runToolExecution(
      {
        cwd,
        plugins: { fixture: plugin },
        adapter: { id: "fixture", createSession },
        fileBatchSize,
        onAdapterInfo,
      },
      { ...hooks, createAnalysis },
    );

    expect(result).toMatchObject({ ai: info, exitCode: 0, totalFiles: 2 });
    expect(onAdapterInfo).toHaveBeenCalledExactlyOnceWith(info);
    expect(execute).toHaveBeenCalledTimes(batches);
    expect(createAnalysis).not.toHaveBeenCalled();
    for (const [request] of execute.mock.calls) {
      expect(request).not.toHaveProperty("onAnalysisUpdate");
    }
    expect(dispose).toHaveBeenCalledOnce();
    expect(onAdapterInfo).toHaveBeenCalledAfter(createSession);
    expect(onAdapterInfo).toHaveBeenCalledBefore(execute);
  },
);

test.each([
  { fileBatchSize: 4, batches: 1, observer: "warning" },
  { fileBatchSize: 1, batches: 2, observer: "warning" },
  { fileBatchSize: 4, batches: 1, observer: "snapshot" },
  { fileBatchSize: 1, batches: 2, observer: "snapshot" },
])(
  "tracks analysis for $batches group(s) with only a $observer observer",
  async ({ fileBatchSize, batches, observer }) => {
    const cwd = await project();
    const onWarning = vi.fn();
    const onAnalysisUpdate = vi.fn();
    const createAnalysis = vi.fn(hooks.createAnalysis);
    const execute = vi.fn(({ onAnalysisUpdate }: AdapterExecuteRequest) => {
      onAnalysisUpdate?.({
        type: "aquarius.analysis_update",
        revision: 1,
        fileResults: [],
        ruleResults: [{ ruleId: "fixture/check", status: "in_progress", reason: "" }],
      });
      onAnalysisUpdate?.({ type: "aquarius.analysis_update", revision: "invalid" });
    });

    const result = await runToolExecution(
      {
        cwd,
        plugins: { fixture: plugin },
        adapter: { id: "fixture", createSession: () => ({ execute, dispose() {} }) },
        fileBatchSize,
        ...(observer === "warning" ? { onWarning } : { onAnalysisUpdate }),
      },
      { ...hooks, createAnalysis },
    );

    expect(result.exitCode).toBe(0);
    expect(createAnalysis).toHaveBeenCalledTimes(batches);
    expect(execute).toHaveBeenCalledTimes(batches);
    if (observer === "warning") {
      expect(onWarning).toHaveBeenCalledTimes(batches);
      expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("INVALID_ANALYSIS_UPDATE"));
    } else {
      expect(onAnalysisUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "provisional",
          ruleResults: [
            expect.objectContaining({ ruleId: "fixture/check", status: "in_progress" }),
          ],
        }),
      );
      expect(onAnalysisUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: "final" }),
      );
    }
  },
);

const earlyExits: {
  label: string;
  config: ProjectConfig;
  configPath?: string;
  expected: { activeRules: number; totalFiles: number | null; exitCode: number };
}[] = [
  {
    label: "no rules",
    config: { rules: {} },
    expected: { activeRules: 0, totalFiles: 2, exitCode: 0 },
  },
  {
    label: "no targets",
    config: { files: ["*.txt"] },
    expected: { activeRules: 1, totalFiles: 0, exitCode: 0 },
  },
  {
    label: "failed preparation",
    config: { rules: { "fixture/missing": "error" } },
    expected: { activeRules: 0, totalFiles: null, exitCode: 2 },
  },
  {
    label: "a missing configuration",
    config: {},
    configPath: "missing.json",
    expected: { activeRules: 0, totalFiles: null, exitCode: 2 },
  },
  {
    label: "invalid adapter options",
    config: { ai: { options: { unexpected: true } } },
    expected: { activeRules: 1, totalFiles: 2, exitCode: 2 },
  },
];

test.each(earlyExits)("omits metadata with $label", async ({ config, configPath, expected }) => {
  const cwd = await project(config);
  const onAdapterInfo = vi.fn();
  const createSession = vi.fn(() => ({ info, execute() {}, dispose() {} }));

  const result = await runToolExecution(
    {
      cwd,
      configPath,
      plugins: { fixture: plugin },
      adapter: { id: "fixture", optionsSchema: z.strictObject({}), createSession },
      noErrorOnUnmatchedPattern: true,
      onAdapterInfo,
    },
    hooks,
  );

  expect(result).toMatchObject(expected);
  expect(result).not.toHaveProperty("ai");
  expect(createSession).not.toHaveBeenCalled();
  expect(onAdapterInfo).not.toHaveBeenCalled();
});

test.each(["createSession", "execute"] as const)(
  "keeps only successfully created session metadata when %s fails",
  async (failure) => {
    const cwd = await project();
    const onAdapterInfo = vi.fn();
    const fail = () => {
      throw new AquariusError("FIXTURE_FAILED", "Adapter failed.");
    };
    const createSession =
      failure === "createSession" ? fail : () => ({ info, execute: fail, dispose() {} });

    const result = await runToolExecution(
      {
        cwd,
        plugins: { fixture: plugin },
        adapter: { id: "fixture", createSession },
        onAdapterInfo,
      },
      hooks,
    );

    expect(result.exitCode).toBe(2);
    expect(result.response.errors).toContainEqual(
      expect.objectContaining({ code: "FIXTURE_FAILED" }),
    );
    if (failure === "execute") {
      expect(result.ai).toEqual(info);
      expect(onAdapterInfo).toHaveBeenCalledExactlyOnceWith(info);
    } else {
      expect(result).not.toHaveProperty("ai");
      expect(onAdapterInfo).not.toHaveBeenCalled();
    }
  },
);
