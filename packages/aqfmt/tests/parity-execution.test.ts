import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AiBridge, BridgeInput, RulePlugin } from "@aquarius/core/internal";
import { executeFormat } from "../src/format/execute";
import type { FileChange, FormatAnalysisSnapshot } from "../src/format/types";

const roots: string[] = [];
const original = "before\n";
const replacement = "after\n";

const plugin: RulePlugin = {
  namespace: "fixture",
  formatRules: [
    {
      id: "format",
      description: "Format the fixture.",
      scope: "file",
      buildPrompt: () => ({
        applicability: "Fixture files.",
        transformation: "Replace before with after.",
        constraints: ["Preserve the selected file paths."],
      }),
    },
  ],
};

const project = async (
  count: number,
  extra: Record<string, unknown> = {},
): Promise<{ root: string; paths: string[] }> => {
  const root = await mkdtemp(join(tmpdir(), "aquarius-format-parity-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  const paths = Array.from({ length: count }, (_, index) => `src/file-${index}.txt`);
  for (const path of paths) {
    await writeFile(join(root, path), original);
  }
  await writeFile(
    join(root, ".aqfmtrc.json"),
    JSON.stringify({
      files: ["src/**"],
      plugins: ["fixture"],
      rules: { "fixture/format": true },
      ...extra,
    }),
  );
  return { root, paths };
};

const targets = (input: BridgeInput): string[] => {
  const metadata = JSON.parse(input.prompt.split("\n\n").at(-1)!) as { targets: string[] };
  return metadata.targets;
};

const change = (path: string, newText = replacement): FileChange => ({
  op: "replace",
  path,
  oldText: original,
  newText,
  ruleIds: ["fixture/format"],
});

const response = (input: BridgeInput, changes: FileChange[] = []) => ({
  completedRuleIds: input.ruleResources.files.map(({ ruleId }) => ruleId),
  skippedRules: [],
  changes,
  warnings: [],
  errors: [],
  fileResults: targets(input).map((path) => ({ path, status: "completed" as const, reason: "" })),
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("aquarius-format-parity-")
    ) {
      throw new Error("Unexpected cleanup path.");
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("format parity through real execution components", () => {
  test.each([1, 5])(
    "applies file replacements and reports all %s original targets",
    async (count) => {
      const { root, paths } = await project(count);
      const run = vi.fn(async (input: BridgeInput) =>
        response(
          input,
          targets(input).map((path) => change(path)),
        ),
      );

      const execution = await executeFormat(
        { cwd: root, fileBatchSize: 2, maxConcurrency: 2 },
        { fixture: plugin },
        { id: "replacement-fixture", run },
      );

      expect(execution.exitCode).toBe(0);
      expect(run).toHaveBeenCalledTimes(Math.ceil(count / 2));
      expect(execution.result.errors).toEqual([]);
      expect(execution.result.changedFiles).toEqual(paths);
      expect(execution.result.proposedFiles).toEqual(paths);
      expect(execution.result.fileResults).toEqual(
        paths.map((path) => ({ path, status: "completed", reason: "" })),
      );
      expect(execution.result.summary).toEqual({
        totalFiles: count,
        completedFiles: count,
        skippedFiles: 0,
        failedFiles: 0,
        activeRules: 1,
      });
      for (const path of paths) {
        expect(await readFile(join(root, path), "utf8")).toBe(replacement);
      }
    },
  );

  test.each([
    { count: 1, operation: "create" },
    { count: 1, operation: "delete" },
    { count: 1, operation: "move" },
    { count: 5, operation: "create" },
    { count: 5, operation: "delete" },
    { count: 5, operation: "move" },
  ] as const)(
    "rejects file-only $operation for $count files without retry or writes",
    async ({ count, operation }) => {
      const { root, paths } = await project(count);
      const run = vi.fn(async (input: BridgeInput) => {
        const first = targets(input)[0]!;
        const ruleIds = ["fixture/format"];
        let proposed: FileChange;
        if (operation === "create") {
          proposed = { op: "create", path: "src/created.txt", content: "created\n", ruleIds };
        } else if (operation === "delete") {
          proposed = { op: "delete", path: first, ruleIds };
        } else {
          proposed = { op: "move", from: first, to: "src/moved.txt", ruleIds };
        }
        return response(input, [proposed]);
      });

      const execution = await executeFormat(
        { cwd: root, fileBatchSize: 2, maxConcurrency: 1 },
        { fixture: plugin },
        { id: "structural-fixture", run },
      );

      expect(execution.exitCode).toBe(2);
      expect(run).toHaveBeenCalledTimes(1);
      expect(execution.result.errors.length).toBeGreaterThan(0);
      expect(execution.result.changedFiles).toEqual([]);
      for (const path of paths) {
        expect(await readFile(join(root, path), "utf8")).toBe(original);
      }
      await expect(access(join(root, "src/created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(root, "src/moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test.each(["module", "project"] as const)(
    "uses one request for mixed %s scope and keeps the original target universe",
    async (scope) => {
      const { root, paths } = await project(5, {
        rules: { "fixture/format": true, "fixture/structure": true },
      });
      const mixedPlugin: RulePlugin = {
        ...plugin,
        formatRules: [
          ...plugin.formatRules!,
          { ...plugin.formatRules![0]!, id: "structure", scope },
        ],
      };
      const run = vi.fn(async (input: BridgeInput) =>
        response(input, [
          change(paths[0]!),
          {
            op: "move",
            from: paths[1]!,
            to: "src/moved.txt",
            ruleIds: ["fixture/structure"],
          },
          {
            op: "create",
            path: "src/created.txt",
            content: "created\n",
            ruleIds: ["fixture/structure"],
          },
        ]),
      );

      const execution = await executeFormat(
        { cwd: root, fileBatchSize: 1, maxConcurrency: 3 },
        { fixture: mixedPlugin },
        { id: "mixed-scope-fixture", run },
      );

      expect(execution.exitCode).toBe(0);
      expect(run).toHaveBeenCalledTimes(1);
      expect(targets(run.mock.calls[0]![0])).toEqual(paths);
      expect(execution.result.errors).toEqual([]);
      expect(execution.result.summary).toEqual({
        totalFiles: 5,
        completedFiles: 5,
        skippedFiles: 0,
        failedFiles: 0,
        activeRules: 2,
      });
      expect(execution.result.fileResults.map(({ path }) => path)).toEqual(paths);
      expect(execution.result.proposedFiles).toEqual(
        ["src/created.txt", paths[0]!, paths[1]!, "src/moved.txt"].sort(),
      );
      expect(new Set(execution.result.changedFiles)).toEqual(
        new Set(["src/created.txt", paths[0]!, paths[1]!, "src/moved.txt"]),
      );
      expect(await readFile(join(root, paths[0]!), "utf8")).toBe(replacement);
      await expect(access(join(root, paths[1]!))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, "src/moved.txt"), "utf8")).toBe(original);
      expect(await readFile(join(root, "src/created.txt"), "utf8")).toBe("created\n");
    },
  );

  test("preserves a completed batch but skips later batches and writes nothing after failure", async () => {
    const { root, paths } = await project(5);
    let calls = 0;
    const run = vi.fn(async (input: BridgeInput) => {
      calls += 1;
      if (calls === 1) {
        return response(input, [change(targets(input)[0]!)]);
      }
      return {
        ...response(input),
        completedRuleIds: [],
        errors: [
          { code: "READ_FAILED", message: "The selected file could not be read.", ruleIds: [] },
        ],
        fileResults: targets(input).map((path) => ({
          path,
          status: "failed",
          reason: "The selected file could not be read.",
        })),
      };
    });

    const execution = await executeFormat(
      { cwd: root, fileBatchSize: 1, maxConcurrency: 1 },
      { fixture: plugin },
      { id: "partial-failure-fixture", run },
    );

    expect(execution.exitCode).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(execution.result.changedFiles).toEqual([]);
    expect(execution.result.proposedFiles).toEqual([paths[0]]);
    expect(execution.result.summary).toEqual({
      totalFiles: 5,
      completedFiles: 1,
      skippedFiles: 3,
      failedFiles: 1,
      activeRules: 1,
    });
    expect(execution.result.fileResults.map(({ status }) => status)).toEqual([
      "completed",
      "failed",
      "skipped",
      "skipped",
      "skipped",
    ]);
    for (const file of execution.result.fileResults.slice(1)) {
      expect(file.reason.trim()).not.toBe("");
    }
    for (const path of paths) {
      expect(await readFile(join(root, path), "utf8")).toBe(original);
    }
  });

  test("retries one incomplete batch and applies only its replacement proposal", async () => {
    const { root, paths } = await project(2);
    let calls = 0;
    const run = vi.fn(async (input: BridgeInput) => {
      calls += 1;
      if (calls === 1) {
        return {
          ...response(
            input,
            paths.map((path) => change(path, "discarded\n")),
          ),
          completedRuleIds: [],
          fileResults: [],
        };
      }
      return response(input, [change(paths[1]!)]);
    });

    const execution = await executeFormat(
      { cwd: root, fileBatchSize: 2 },
      { fixture: plugin },
      { id: "retry-fixture", run },
    );

    expect(execution.exitCode).toBe(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(execution.result.errors).toEqual([]);
    expect(execution.result.proposedFiles).toEqual([paths[1]]);
    expect(execution.result.changedFiles).toEqual([paths[1]]);
    expect(execution.result.summary.completedFiles).toBe(2);
    expect(await readFile(join(root, paths[0]!), "utf8")).toBe(original);
    expect(await readFile(join(root, paths[1]!), "utf8")).toBe(replacement);
  });

  test("rejects a legacy response without file results instead of guessing completion", async () => {
    const { root, paths } = await project(1);
    const run = vi.fn(async (input: BridgeInput) => {
      const { fileResults: _fileResults, ...legacy } = response(input, [change(paths[0]!)]);
      return legacy;
    });

    const execution = await executeFormat(
      { cwd: root },
      { fixture: plugin },
      { id: "legacy-response-fixture", run },
    );

    expect(execution.exitCode).toBe(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(execution.result.changedFiles).toEqual([]);
    expect(execution.result.summary.completedFiles).toBe(0);
    expect(execution.result.summary.failedFiles).toBe(1);
    expect(await readFile(join(root, paths[0]!), "utf8")).toBe(original);
  });

  test("ignores malformed intermediate reports and still applies a valid final result", async () => {
    const { root, paths } = await project(1);
    const warnings = vi.fn();
    const snapshots: FormatAnalysisSnapshot[] = [];
    const ai: AiBridge = {
      id: "invalid-intermediate-fixture",
      async run(input) {
        input.onAnalysisUpdate?.({
          type: "aquarius.analysis_update",
          revision: 1,
          fileResults: [{ path: paths[0], status: "in_progress", reason: "" }],
          ruleResults: [{ ruleId: "fixture/format", status: "in_progress", reason: "" }],
          proposedFiles: ["../outside.txt"],
          warnings: [],
        });
        expect(await readFile(join(root, paths[0]!), "utf8")).toBe(original);
        return response(input, [change(paths[0]!)]);
      },
    };

    const execution = await executeFormat(
      {
        cwd: root,
        onWarning: warnings,
        onAnalysisUpdate: (snapshot) => snapshots.push(snapshot),
      },
      { fixture: plugin },
      ai,
    );

    expect(execution.exitCode).toBe(0);
    expect(warnings).toHaveBeenCalled();
    expect(execution.result.errors).toEqual([]);
    expect(snapshots.some(({ proposedFiles }) => proposedFiles.includes("../outside.txt"))).toBe(
      false,
    );
    expect(snapshots.at(-1)?.phase).toBe("final");
    expect(execution.result.changedFiles).toEqual(paths);
    expect(await readFile(join(root, paths[0]!), "utf8")).toBe(replacement);
  });

  test.each(["file", "module"] as const)(
    "keeps never-started %s reviews skipped when the initial observer cancels",
    async (scope) => {
      const { root, paths } = await project(2);
      const controller = new AbortController();
      const run = vi.fn(async (input: BridgeInput) => response(input));
      const scopedPlugin: RulePlugin = {
        ...plugin,
        formatRules: [{ ...plugin.formatRules![0]!, scope }],
      };

      const execution = await executeFormat(
        {
          cwd: root,
          signal: controller.signal,
          onAnalysisUpdate: () => controller.abort(),
        },
        { fixture: scopedPlugin },
        { id: "cancel-before-request", run },
      );

      expect(execution.exitCode).toBe(130);
      expect(run).not.toHaveBeenCalled();
      expect(execution.result.summary).toMatchObject({
        totalFiles: 2,
        completedFiles: 0,
        skippedFiles: 2,
        failedFiles: 0,
      });
      expect(execution.result.changedFiles).toEqual([]);
      for (const path of paths) {
        expect(await readFile(join(root, path), "utf8")).toBe(original);
      }
    },
  );

  test.each([false, true])(
    "reports cancellation during final publication without losing actual changes, check=%s",
    async (check) => {
      const { root, paths } = await project(1);
      const controller = new AbortController();
      const snapshots: FormatAnalysisSnapshot[] = [];
      const ai: AiBridge = {
        id: "cancel-at-final-publication",
        async run(input) {
          return response(input, [change(paths[0]!)]);
        },
      };

      const execution = await executeFormat(
        {
          cwd: root,
          check,
          signal: controller.signal,
          onAnalysisUpdate: (snapshot) => {
            snapshots.push(snapshot);
            if (snapshot.phase === "final") controller.abort();
          },
        },
        { fixture: plugin },
        ai,
      );

      expect(execution.exitCode).toBe(130);
      expect(execution.result.errors).toContainEqual(
        expect.objectContaining({ code: "AI_ABORTED" }),
      );
      expect(execution.result.changedFiles).toEqual(check ? [] : paths);
      expect(execution.result.proposedFiles).toEqual(paths);
      expect(snapshots.at(-1)?.phase).toBe("incomplete");
      expect(await readFile(join(root, paths[0]!), "utf8")).toBe(check ? original : replacement);
    },
  );

  test("preserves the last valid provisional proposal as incomplete after timeout", async () => {
    const { root, paths } = await project(1, {
      ai: { adapter: "codex", timeoutMs: 25 },
    });
    const snapshots: FormatAnalysisSnapshot[] = [];
    const run = vi.fn(async (input: BridgeInput) => {
      input.onAnalysisUpdate?.({
        type: "aquarius.analysis_update",
        revision: 1,
        fileResults: [{ path: paths[0], status: "in_progress", reason: "" }],
        ruleResults: [{ ruleId: "fixture/format", status: "in_progress", reason: "" }],
        proposedFiles: paths,
        warnings: [],
      });
      return new Promise<never>(() => {});
    });

    const execution = await executeFormat(
      { cwd: root, onAnalysisUpdate: (snapshot) => snapshots.push(snapshot) },
      { fixture: plugin },
      { id: "provisional-timeout-fixture", run },
    );

    expect(execution.exitCode).toBe(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(execution.result.errors).toContainEqual(expect.objectContaining({ code: "AI_TIMEOUT" }));
    expect(execution.result.changedFiles).toEqual([]);
    expect(snapshots.at(-1)?.phase).toBe("incomplete");
    expect(snapshots.at(-1)?.proposedFiles).toEqual(paths);
    expect(await readFile(join(root, paths[0]!), "utf8")).toBe(original);
  });
});
