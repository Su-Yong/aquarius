import { execFileSync } from "node:child_process";
import { link, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { AdapterExecuteRequest, RulePlugin } from "@aquarius/core/runtime";
import { printHuman } from "../src/cli/output";
import { executeFormat } from "../src/format/execute";
import type { FileChange, FormatExecutionOptions, FormatResponse } from "../src/format/types";

const roots: string[] = [];
const ruleIds = ["fixture/first", "fixture/second", "fixture/third"];
const plugin: RulePlugin = {
  namespace: "fixture",
  formatRules: ruleIds.map((id) => ({
    id: id.split("/")[1]!,
    description: id,
    scope: "file",
    buildPrompt: () => ({ applicability: "fixture", transformation: "fixture", constraints: [] }),
  })),
};
const original = "before\nlast\n";
const updated = "after\nlast\n";

const project = async (paths: string[], timeoutMs = 1_000, git = false): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "aquarius-partial-"));
  roots.push(root);
  if (git) execFileSync("git", ["init", "-q", root], { windowsHide: true });
  await Promise.all([
    ...paths.map((path) => writeFile(join(root, path), original)),
    writeFile(
      join(root, ".aqfmtrc.json"),
      JSON.stringify({
        files: ["*.txt"],
        plugins: ["fixture"],
        ai: { timeoutMs },
        rules: Object.fromEntries(ruleIds.map((id) => [id, true])),
      }),
    ),
  ]);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const replace = (
  path: string,
  patch = "@@ -1 +1 @@\n-before\n+after\n",
  ruleId = ruleIds[0]!,
): FileChange => ({ op: "replace", path, patch, ruleIds: [ruleId] });

const overlap = (path: string): FileChange[] => [
  replace(path),
  replace(path, "@@ -1 +1 @@\n-before\n+another\n", ruleIds[1]),
  replace(path, "@@ -2 +2 @@\n-last\n+last line updated\n", ruleIds[2]),
];

type Reply = Omit<FormatResponse, "retryable"> & { completedRuleIds: string[] };

const reply = (targets: string[], changes: FileChange[], completedRuleIds = ruleIds): Reply => ({
  completedRuleIds,
  changes,
  fileResults: targets.map((path) => ({ path, status: "completed", reason: "" })),
  skippedRules: [],
  errors: [],
  warnings: [],
});

const fixture = (
  cwd: string,
  respond: (
    input: AdapterExecuteRequest,
    metadata: {
      targets: string[];
      task: string;
      rules: { ruleId: string }[];
      error?: { message: string };
      patches?: unknown[];
    },
  ) => unknown,
) => {
  const execute = vi.fn((input: AdapterExecuteRequest) =>
    respond(input, JSON.parse(input.prompt.slice(input.prompt.lastIndexOf("\n\n") + 2))),
  );
  const dispose = vi.fn();
  const createSession = vi.fn(() => ({ execute, dispose }));
  const run = (options: Partial<FormatExecutionOptions> = {}) =>
    executeFormat({
      cwd,
      plugins: { fixture: plugin },
      adapter: { id: "partial-fixture", createSession },
      ...options,
    });
  return { run, execute, createSession, dispose };
};

test.each([
  { repaired: true, check: false },
  { repaired: false, check: false },
  { repaired: false, check: true },
])(
  "repairs only the failed file in a four-file group ($repaired, check $check)",
  async ({ repaired, check }) => {
    const paths = ["a.txt", "b.txt", "c.txt", "d.txt"];
    const root = await project(paths);
    const bad = paths[1]!;
    const good = paths.filter((path) => path !== bad);
    const patches = overlap(bad);
    const ai = fixture(root, (input, metadata) => {
      if (metadata.task === "format") {
        input.onAnalysisUpdate?.({
          type: "aquarius.analysis_update",
          revision: 1,
          fileResults: [],
          ruleResults: [],
          proposedFiles: paths,
          warnings: [],
        });
        return reply(paths, [...good.map((path) => replace(path)), ...patches]);
      }
      expect(metadata).toMatchObject({ task: "repair-format-replacement", targets: [bad] });
      expect(metadata.patches).toEqual(
        patches.map((change) => {
          if (change.op !== "replace") throw new Error("Expected replace fixture.");
          return { ruleIds: change.ruleIds, patch: change.patch };
        }),
      );
      expect(metadata.error?.message).toMatch(
        /patch 1, hunk 1.*original lines 1-1.*patch 2, hunk 1.*original lines 1-1/,
      );
      expect(input.prompt).toContain("Later rules in the listed order take precedence");
      return reply(
        [bad],
        repaired ? [replace(bad)] : patches,
        metadata.rules.map(({ ruleId }) => ruleId),
      );
    });
    const snapshots: string[][] = [];
    const { result, exitCode } = await ai.run({
      check,
      onAnalysisUpdate: ({ proposedFiles }) => snapshots.push(proposedFiles),
    });
    const accepted = repaired ? paths : good;

    expect(ai.execute).toHaveBeenCalledTimes(2);
    expect(ai.execute.mock.calls[0]?.[0].onAnalysisUpdate).toEqual(expect.any(Function));
    expect(ai.execute.mock.calls[1]?.[0]).not.toHaveProperty("onAnalysisUpdate");
    expect(ai.createSession).toHaveBeenCalledTimes(1);
    expect(ai.dispose).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(repaired ? 0 : 2);
    expect(result.errors).toEqual(
      repaired
        ? []
        : [
            expect.objectContaining({
              code: "REPLACE_OVERLAP",
              ruleIds: ruleIds.slice(0, 2),
            }),
          ],
    );
    expect(result.proposedFiles).toEqual(accepted);
    expect(snapshots.at(-1)).toEqual(accepted);
    expect(result.changedFiles).toEqual(check ? [] : accepted);
    expect(result.wouldChangeFiles).toEqual(check ? accepted : undefined);
    expect(result.summary).toMatchObject({
      completedFiles: accepted.length,
      failedFiles: repaired ? 0 : 1,
    });
    expect(result.fileResults.find(({ path }) => path === bad)?.status).toBe(
      repaired ? "completed" : "failed",
    );
    for (const path of paths) {
      expect(await readFile(join(root, path), "utf8")).toBe(
        !check && accepted.includes(path) ? updated : original,
      );
    }
  },
);

test.each(["success", "timeout", "cancel"])(
  "handles a single-file mismatch repair: %s",
  async (outcome) => {
    const paths = ["a.txt"];
    const root = await project(paths, 40);
    const controller = new AbortController();
    let repairSignal: AbortSignal | undefined;
    const ai = fixture(root, (input, metadata) => {
      if (metadata.task === "format")
        return reply(paths, [replace(paths[0]!, "@@ -1 +1 @@\n-missing\n+after\n")]);
      expect(metadata.targets).toEqual(paths);
      expect(metadata.error?.message).toContain("1 | before\n2 | last");
      repairSignal = input.signal;
      if (outcome === "success") return reply(paths, [replace(paths[0]!)], [ruleIds[0]!]);
      if (outcome === "cancel") controller.abort();
      return new Promise<never>(() => {});
    });

    const { result, exitCode } = await ai.run({ signal: controller.signal });
    expect(ai.execute).toHaveBeenCalledTimes(2);
    expect(repairSignal?.aborted).toBe(outcome !== "success");
    expect(exitCode).toBe(outcome === "success" ? 0 : outcome === "timeout" ? 2 : 130);
    if (outcome !== "success") {
      expect(result.errors).toEqual([
        expect.objectContaining({
          code: outcome === "timeout" ? "AI_TIMEOUT" : "AI_ABORTED",
          ruleIds: [ruleIds[0]],
        }),
      ]);
      expect(result.fileResults[0]?.status).toBe("failed");
      expect(result.changedFiles).toEqual([]);
    }
    expect(await readFile(join(root, paths[0]!), "utf8")).toBe(
      outcome === "success" ? updated : original,
    );
  },
);

test("scopes repair resources to the proposed file and reports its progress", async () => {
  const bad = "a.txt";
  const good = "b.txt";
  const paths = [bad, good];
  const root = await project(paths);
  const progress = vi.fn();
  const ai = fixture(root, (input, metadata) => {
    const requestedRuleIds = input.ruleResources.map(({ ruleId }) => ruleId);
    if (metadata.task === "format") {
      expect(requestedRuleIds).toEqual(ruleIds);
      return reply(paths, [...overlap(bad).slice(0, 2), replace(good, undefined, ruleIds[2])]);
    }

    expect(requestedRuleIds).toEqual(ruleIds.slice(0, 2));
    expect(metadata.rules.map(({ ruleId }) => ruleId)).toEqual(requestedRuleIds);
    expect(input.prompt).toContain("@@ -oldStart[,oldCount] +newStart[,newCount] @@");
    expect(input.prompt).toContain("{path, status: completed|skipped|failed, reason}");
    expect(input.prompt).toContain("Read one rule detail file per tool response.");
    expect(input.prompt).toContain("without Markdown or additional prose");
    expect(input.prompt).toContain("changes: [], explanatory warnings, and status completed");
    input.onProgress?.("Reading rule details");
    return reply([bad], [replace(bad)], requestedRuleIds);
  });

  const { result, exitCode } = await ai.run({ onProgress: progress });
  expect(ai.execute).toHaveBeenCalledTimes(2);
  for (const [input] of ai.execute.mock.calls) {
    expect(input).not.toHaveProperty("onAnalysisUpdate");
  }
  expect(exitCode).toBe(0);
  expect(result.errors).toEqual([]);
  expect(result.changedFiles).toEqual(paths);
  expect(progress).toHaveBeenCalledWith(`Repairing ${bad}`);
  expect(progress).toHaveBeenCalledWith(`Repairing ${bad}: Reading rule details`);
});

test.each([
  { code: "RULE_CONFLICT", status: "completed", accepted: true },
  { code: "BEHAVIOR_PRESERVATION", status: "completed", accepted: true },
  { code: undefined, status: "completed", accepted: false },
  { code: "RULE_CONFLICT", status: "skipped", accepted: false },
] as const)(
  "checks empty repair with status $status and warning $code",
  async ({ code, status, accepted }) => {
    const path = "a.txt";
    const root = await project([path]);
    const warnings = code
      ? [{ code, message: "Keeping the original is safe.", ruleIds: [ruleIds[0]!], paths: [path] }]
      : [];
    const ai = fixture(root, (input, metadata) => {
      if (metadata.task === "format") return reply([path], overlap(path));
      return {
        ...reply(
          [path],
          [],
          input.ruleResources.map(({ ruleId }) => ruleId),
        ),
        fileResults: [{ path, status, reason: status === "skipped" ? "No safe change." : "" }],
        warnings,
      };
    });

    const { result, exitCode } = await ai.run();
    expect(ai.execute).toHaveBeenCalledTimes(2);
    expect(exitCode).toBe(accepted ? 0 : 2);
    expect(result.fileResults[0]?.status).toBe(accepted ? "completed" : "failed");
    expect(result.errors.map(({ code }) => code)).toEqual(accepted ? [] : ["REPLACE_OVERLAP"]);
    if (!code) expect(result.errors[0]?.message).toContain("No valid replacement was returned.");
    expect(result.warnings).toEqual(accepted ? warnings : []);
    expect(result.proposedFiles).toEqual([]);
    expect(result.changedFiles).toEqual([]);
    expect(await readFile(join(root, path), "utf8")).toBe(original);
  },
);

test("reports unapplied proposals after source edits, deletions, and a batch error", async () => {
  const paths = ["a.txt", "b.txt", "c.txt", "d.txt"];
  const root = await project(paths);
  const ai = fixture(root, async (_input, metadata) => {
    const [path] = metadata.targets as [string];
    if (path === "b.txt") await writeFile(join(root, path), "my external edit\n");
    if (path === "c.txt") await unlink(join(root, "a.txt"));
    if (path === "d.txt") {
      return {
        ...reply([path], [replace(path)], []),
        errors: [{ code: "READ_FAILED", message: "Cannot read required context.", ruleIds: [] }],
      };
    }
    return reply([path], [replace(path)]);
  });
  const execution = await ai.run({ fileBatchSize: 1, maxConcurrency: 1 });
  const { result, exitCode } = execution;

  expect(ai.execute).toHaveBeenCalledTimes(4);
  expect(exitCode).toBe(2);
  expect(result.errors).toEqual([
    expect.objectContaining({ code: "SOURCE_CHANGED", ruleIds: [] }),
    expect.objectContaining({ code: "READ_FAILED", ruleIds: [] }),
    expect.objectContaining({ code: "SOURCE_MISSING", ruleIds: [] }),
  ]);
  expect(result.fileResults.map(({ status }) => status)).toEqual([
    "failed",
    "failed",
    "completed",
    "failed",
  ]);
  expect(result.proposedFiles).toEqual(paths);
  expect(result.changedFiles).toEqual(["c.txt"]);
  await expect(readFile(join(root, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(root, "b.txt"), "utf8")).toBe("my external edit\n");
  expect(await readFile(join(root, "c.txt"), "utf8")).toBe(updated);
  expect(await readFile(join(root, "d.txt"), "utf8")).toBe(original);

  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    printHuman(execution, false);
    expect(
      log.mock.calls
        .flat()
        .join("\n")
        .match(/Proposed \(not applied\) \w\.txt/g),
    ).toEqual([
      "Proposed (not applied) a.txt",
      "Proposed (not applied) b.txt",
      "Proposed (not applied) d.txt",
    ]);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("rejects both hard links across different groups before trying to repair either", async () => {
  const root = await project(["a.txt", "c.txt"]);
  await link(join(root, "a.txt"), join(root, "b.txt"));
  const ai = fixture(root, (_input, metadata) => {
    const [path] = metadata.targets as [string];
    return reply([path], path === "a.txt" ? overlap(path) : [replace(path)]);
  });
  const { result, exitCode } = await ai.run({ fileBatchSize: 1, maxConcurrency: 1 });

  expect(ai.execute).toHaveBeenCalledTimes(3);
  expect(exitCode).toBe(2);
  expect(result.errors).toEqual([
    expect.objectContaining({
      code: "PATH_ALIAS_CONFLICT",
      message: expect.stringContaining("a.txt, b.txt"),
      ruleIds: [],
    }),
  ]);
  expect(result.fileResults.map(({ status }) => status)).toEqual(["failed", "failed", "completed"]);
  expect(result.proposedFiles).toEqual(["a.txt", "b.txt", "c.txt"]);
  expect(result.changedFiles).toEqual(["c.txt"]);
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe(original);
  expect(await readFile(join(root, "b.txt"), "utf8")).toBe(original);
});

test("one undo restores 111 writes after a failed batch and a later zero-write run", async () => {
  const paths = Array.from({ length: 112 }, (_, index) => `${String(index).padStart(3, "0")}.txt`);
  const root = await project(paths, 1_000, true);
  const bad = paths[1]!;
  const ai = fixture(root, (_input, { targets }) => {
    if (targets.includes(bad)) throw new Error("Failed batch");
    return reply(
      targets,
      targets.map((path) => replace(path)),
    );
  });
  const accepted = paths.filter((path) => path !== bad);

  const applied = await ai.run({ fileBatchSize: 1, maxConcurrency: 3 });
  expect(ai.execute).toHaveBeenCalledTimes(paths.length);
  expect(applied.exitCode).toBe(2);
  expect(applied.result.changedFiles).toEqual(accepted);
  expect(applied.result.summary).toMatchObject({ completedFiles: 111, failedFiles: 1 });
  const failed = await ai.run({ paths: [bad] });
  expect(failed.exitCode).toBe(2);
  expect(failed.result.changedFiles).toEqual([]);
  await writeFile(join(root, bad), "user edit after partial apply\n");

  const undo = await ai.run({ undo: true });
  expect(undo.exitCode).toBe(0);
  expect(undo.result.restoredFiles).toEqual(accepted);
  expect(await Promise.all(accepted.map((path) => readFile(join(root, path), "utf8")))).toEqual(
    accepted.map(() => original),
  );
  expect(await readFile(join(root, bad), "utf8")).toBe("user edit after partial apply\n");
}, 30_000);
