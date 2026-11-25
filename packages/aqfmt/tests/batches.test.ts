import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RulePlugin } from "@aqtools/core";
import type { AdapterExecuteRequest, AdapterSession } from "@aqtools/core/runtime";
import { executeFormat } from "../src/format/execute";
import type {
  FileChange,
  FormatAnalysisSnapshot,
  FormatExecutionOptions,
  FormatResponse,
  FormatWarning,
} from "../src/format/types";

const plugin: RulePlugin = {
  namespace: "fixture",
  formatRules: [
    {
      id: "style",
      description: "Fixture",
      scope: "file",
      buildPrompt: () => ({
        applicability: "Fixture",
        transformation: "Fixture",
        constraints: [],
      }),
    },
  ],
};

type RawResponse = Omit<FormatResponse, "retryable"> & { completedRuleIds: string[] };

const reply = (targets: readonly string[], overrides: Partial<RawResponse> = {}): RawResponse => ({
  completedRuleIds: ["fixture/style"],
  changes: [],
  warnings: [],
  errors: [],
  skippedRules: [],
  fileResults: targets.map((path) => ({ path, status: "completed", reason: "" })),
  ...overrides,
});

const replacement = (path: string): FileChange => ({
  op: "replace",
  path,
  patch: "@@ -1 +1 @@\n-before\n+after\n",
  ruleIds: ["fixture/style"],
});

const warning = (path: string): FormatWarning => ({
  code: "UNSAFE_TRANSFORMATION",
  message: "Preservation needs further review.",
  ruleIds: ["fixture/style"],
  paths: [path],
});

const selected = (input: AdapterExecuteRequest): string[] => {
  const metadata = JSON.parse(input.prompt.slice(input.prompt.lastIndexOf("\n\n") + 2));
  return metadata.targets;
};

const roots: string[] = [];

const fixture = (targets: string[], execute: AdapterSession["execute"]) => {
  const snapshots: FormatAnalysisSnapshot[] = [];
  const onWarning = vi.fn();
  const dispose = vi.fn();
  const createSession = vi.fn(() => ({ execute, dispose }));

  const run = async ({
    timeoutMs,
    ...options
  }: Pick<
    FormatExecutionOptions,
    "fileBatchSize" | "maxConcurrency" | "signal" | "onAnalysisUpdate"
  > & {
    timeoutMs?: number;
  } = {}) => {
    const root = await mkdtemp(join(tmpdir(), "aquarius-format-batches-"));
    roots.push(root);
    await Promise.all([
      ...targets.map((path) => writeFile(join(root, path), "before")),
      writeFile(join(root, "context.md"), "Reference"),
      writeFile(
        join(root, ".aqfmtrc.json"),
        JSON.stringify({
          files: ["*.ts"],
          plugins: ["fixture"],
          rules: { "fixture/style": true },
          ai: { adapter: "./fixture-adapter.mjs", timeoutMs: timeoutMs ?? 1_000 },
        }),
      ),
    ]);
    const execution = await executeFormat({
      cwd: root,
      paths: targets,
      check: true,
      fileBatchSize: 1,
      maxConcurrency: 1,
      plugins: { fixture: plugin },
      adapter: { id: "fixture", createSession },
      onWarning,
      ...options,
      onAnalysisUpdate: (snapshot) => {
        snapshots.push(snapshot);
        options.onAnalysisUpdate?.(snapshot);
      },
    });
    return execution.result;
  };

  return { run, snapshots, onWarning, createSession, dispose };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("format file groups", () => {
  test("limits concurrency, retains reference files, and orders results by target group", async () => {
    const gates = Array.from({ length: 3 }, () => Promise.withResolvers<RawResponse>());
    const targets = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const calls: AdapterExecuteRequest[] = [];
    let active = 0;
    let maximumActive = 0;
    const current = fixture(targets, async (input) => {
      const index = calls.length;
      calls.push(input);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const response = await gates[index]!.promise;
      active -= 1;
      return response;
    });
    const running = current.run({
      fileBatchSize: 2,
      maxConcurrency: 2,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map(selected)).toEqual([
      ["a.ts", "b.ts"],
      ["c.ts", "d.ts"],
    ]);
    expect(calls.every(({ readableFiles }) => readableFiles.includes("context.md"))).toBe(true);

    gates[1]!.resolve(reply(["c.ts", "d.ts"], { changes: [replacement("c.ts")] }));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    gates[2]!.resolve(reply(["e.ts"], { changes: [replacement("e.ts")] }));
    gates[0]!.resolve(reply(["a.ts", "b.ts"], { changes: [replacement("a.ts")] }));
    const result = await running;

    expect(maximumActive).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.fileResults.map(({ path }) => path)).toEqual(targets);
    expect(result.proposedFiles).toEqual(["a.ts", "c.ts", "e.ts"]);
    expect(current.createSession).toHaveBeenCalledTimes(1);
    expect(current.dispose).toHaveBeenCalledTimes(1);
    expect(calls.every(({ ruleResources }) => ruleResources === calls[0]?.ruleResources)).toBe(
      true,
    );
    expect(current.onWarning).not.toHaveBeenCalled();
  });

  test.each([
    { op: "create", path: "new.ts", content: "new", ruleIds: ["fixture/style"] },
    { op: "delete", path: "a.ts", ruleIds: ["fixture/style"] },
    { op: "move", from: "a.ts", to: "new.ts", ruleIds: ["fixture/style"] },
  ] as FileChange[])("rejects $op in a single file group without retry", async (change) => {
    const run = vi.fn(async () => reply(["a.ts"], { changes: [change] }));
    const current = fixture(["a.ts"], run);
    const result = await current.run();

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.proposedFiles).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("rejects changes to another group and still reviews that group's files", async () => {
    const run = vi.fn(async (input: AdapterExecuteRequest) => {
      const [path] = selected(input);
      return reply([path!], {
        changes: [replacement(path === "a.ts" ? "b.ts" : path!)],
      });
    });
    const current = fixture(["a.ts", "b.ts", "c.ts"], run);
    const result = await current.run();

    expect(run).toHaveBeenCalledTimes(3);
    expect(result.errors).toEqual([expect.objectContaining({ code: "CHANGE_OUTSIDE_SCOPE" })]);
    expect(result.proposedFiles).toEqual(["b.ts", "c.ts"]);
    expect(result.wouldChangeFiles).toEqual(["b.ts", "c.ts"]);
    expect(result.fileResults.map(({ status }) => status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(current.snapshots.at(-1)?.fileResults).toEqual(result.fileResults);
  });

  test("retries one incomplete response and replaces its proposals and warnings", async () => {
    const prompts: string[] = [];
    const run = vi.fn(async (input: AdapterExecuteRequest) => {
      prompts.push(input.prompt);
      if (selected(input).includes("c.ts")) return reply(["c.ts"]);
      if (prompts.length === 1) {
        input.onAnalysisUpdate?.({
          type: "aquarius.analysis_update",
          revision: 1,
          fileResults: [],
          ruleResults: [],
          proposedFiles: ["a.ts"],
          warnings: [warning("a.ts")],
        });
        return reply(["a.ts"], {
          changes: [replacement("a.ts")],
          warnings: [warning("a.ts")],
        });
      }
      return reply(["a.ts", "b.ts"], { changes: [replacement("b.ts")] });
    });
    const current = fixture(["a.ts", "b.ts", "c.ts"], run);
    const result = await current.run({ fileBatchSize: 2 });

    expect(run).toHaveBeenCalledTimes(3);
    expect(prompts[1]).toContain("previous attempt");
    expect(result.errors).toEqual([]);
    expect(result.proposedFiles).toEqual(["b.ts"]);
    expect(result.warnings).toEqual([]);
    const firstProposal = current.snapshots.findIndex(({ proposedFiles }) =>
      proposedFiles.includes("a.ts"),
    );
    expect(firstProposal).toBeGreaterThan(-1);
    expect(
      current.snapshots
        .slice(firstProposal + 1)
        .some(({ proposedFiles, warnings }) => proposedFiles.length === 0 && warnings.length === 0),
    ).toBe(true);
    expect(current.snapshots.at(-1)?.proposedFiles).toEqual(["b.ts"]);
    expect(current.onWarning).not.toHaveBeenCalled();
  });

  test("retries explicitly unfinished rule review when file reviews also failed", async () => {
    let attempts = 0;
    const run = vi.fn(async (input: AdapterExecuteRequest) => {
      if (selected(input)[0] === "b.ts") return reply(["b.ts"]);
      attempts += 1;
      if (attempts === 1) {
        return reply(["a.ts"], {
          completedRuleIds: [],
          errors: [
            {
              code: "INCOMPLETE_AI_RESPONSE",
              message: "Rule review unfinished.",
              ruleIds: ["fixture/style"],
            },
          ],
          fileResults: [{ path: "a.ts", status: "failed", reason: "Rule review unfinished." }],
        });
      }
      return reply(["a.ts"], { changes: [replacement("a.ts")] });
    });
    const current = fixture(["a.ts", "b.ts"], run);

    const result = await current.run();

    expect(run).toHaveBeenCalledTimes(3);
    expect(result.errors).toEqual([]);
    expect(result.fileResults.map(({ status }) => status)).toEqual(["completed", "completed"]);
    expect(result.proposedFiles).toEqual(["a.ts"]);
  });

  test("retries an incomplete response in its only file group", async () => {
    const run = vi.fn(async (input: AdapterExecuteRequest) =>
      input.prompt.includes("previous attempt")
        ? reply(["a.ts"], { changes: [replacement("a.ts")] })
        : reply([]),
    );
    const result = await fixture(["a.ts"], run).run();

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.errors).toEqual([]);
    expect(result.wouldChangeFiles).toEqual(["a.ts"]);
  });

  test("stops retrying a group after its second incomplete response", async () => {
    const run = vi.fn(async (input: AdapterExecuteRequest) => {
      const paths = selected(input);
      return paths[0] === "a.ts" ? reply([]) : reply(paths);
    });
    const current = fixture(["a.ts", "b.ts"], run);
    const result = await current.run();

    expect(run.mock.calls.map(([input]) => selected(input))).toEqual([
      ["a.ts"],
      ["a.ts"],
      ["b.ts"],
    ]);
    expect(result.fileResults[0]?.status).toBe("failed");
    expect(result.fileResults[1]?.status).toBe("completed");
  });

  test("does not retry a malformed response", async () => {
    const run = vi.fn(async (input: AdapterExecuteRequest) => {
      const paths = selected(input);
      return paths[0] === "a.ts" ? { changes: [] } : reply(paths);
    });
    const current = fixture(["a.ts", "b.ts"], run);
    const result = await current.run();

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.errors[0]?.code).toBe("INVALID_AI_RESPONSE");
    expect(result.fileResults.map(({ status }) => status)).toEqual(["failed", "completed"]);
  });

  test("keeps in-flight and queued groups running after another group fails", async () => {
    const first = Promise.withResolvers<RawResponse>();
    const second = Promise.withResolvers<RawResponse>();
    const run = vi.fn(async (input: AdapterExecuteRequest) => {
      const [path] = selected(input);
      if (path === "a.ts") return first.promise;
      if (path === "b.ts") return second.promise;
      return reply([path!], { changes: [replacement(path!)] });
    });
    const current = fixture(["a.ts", "b.ts", "c.ts", "d.ts"], run);
    const running = current.run({ maxConcurrency: 2 });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    first.resolve(
      reply(["a.ts"], {
        completedRuleIds: [],
        errors: [
          { code: "RULE_FAILED", ruleIds: ["fixture/style"], message: "Cannot review this file." },
        ],
      }),
    );
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4));
    expect(run.mock.calls[1]?.[0].signal.aborted).toBe(false);
    second.resolve(reply(["b.ts"], { changes: [replacement("b.ts")] }));
    const result = await running;

    expect(result.proposedFiles).toEqual(["b.ts", "c.ts", "d.ts"]);
    expect(result.fileResults.map(({ status }) => status)).toEqual([
      "failed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(current.snapshots.at(-1)?.fileResults).toEqual(result.fileResults);
    expect(current.snapshots.at(-1)?.ruleResults[0]?.status).toBe("failed");
  });

  test("fails the final rule review when planning fails after every group completes", async () => {
    const current = fixture(["a.ts", "b.ts"], async (input: AdapterExecuteRequest) => {
      const [path] = selected(input);
      if (path === "b.ts") {
        await writeFile(join(input.projectRoot, "a.ts"), "user edit");
      }
      return reply([path!], { changes: [replacement(path!)] });
    });

    const result = await current.run();
    expect(result.changedFiles).toEqual([]);
    expect(result.errors[0]?.code).toBe("SOURCE_CHANGED");
    expect(result.wouldChangeFiles).toEqual(["b.ts"]);
    expect(current.snapshots.at(-1)).toMatchObject({
      phase: "incomplete",
      ruleResults: [
        { ruleId: "fixture/style", status: "failed", reason: result.errors[0]?.message },
      ],
    });
  });

  test("retries an incomplete group after a different group has failed", async () => {
    const first = Promise.withResolvers<RawResponse>();
    const second = Promise.withResolvers<RawResponse>();
    const run = vi.fn(async (input: AdapterExecuteRequest) => {
      const paths = selected(input);
      if (paths[0] === "b.ts") return second.promise;
      if (paths[0] === "a.ts" && !input.prompt.includes("previous attempt")) return first.promise;
      return reply(paths);
    });
    const current = fixture(["a.ts", "b.ts", "c.ts"], run);
    const running = current.run({ maxConcurrency: 2 });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    second.resolve(
      reply(["b.ts"], {
        fileResults: [{ path: "b.ts", status: "failed", reason: "Unable to review b.ts." }],
      }),
    );
    await vi.waitFor(() => expect(current.snapshots.at(-1)?.ruleResults[0]?.status).toBe("failed"));
    first.resolve(reply([]));
    const result = await running;

    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls.filter(([input]) => selected(input)[0] === "a.ts")).toHaveLength(2);
    expect(result.fileResults.map(({ status }) => status)).toEqual([
      "completed",
      "failed",
      "completed",
    ]);
  });

  test("keeps provisional analysis when a group times out without retrying", async () => {
    const run = vi.fn(async (input: AdapterExecuteRequest) => {
      const [path] = selected(input);
      if (path === "b.ts") {
        input.onAnalysisUpdate?.({
          type: "aquarius.analysis_update",
          revision: 1,
          fileResults: [{ path, status: "in_progress" }],
          ruleResults: [{ ruleId: "fixture/style", status: "in_progress" }],
          proposedFiles: [path],
          warnings: [warning(path)],
        });
        return new Promise(() => {});
      }
      return reply([path!], { changes: [replacement(path!)] });
    });
    const current = fixture(["a.ts", "b.ts", "c.ts"], run);
    const result = await current.run({ timeoutMs: 25 });

    expect(run).toHaveBeenCalledTimes(3);
    expect(result.errors[0]?.code).toBe("AI_TIMEOUT");
    expect(result.proposedFiles).toEqual(["a.ts", "c.ts"]);
    expect(result.fileResults.map(({ status }) => status)).toEqual([
      "completed",
      "failed",
      "completed",
    ]);
    expect(current.onWarning).not.toHaveBeenCalled();
    expect(current.snapshots).toContainEqual(
      expect.objectContaining({
        phase: "provisional",
        fileResults: expect.arrayContaining([{ path: "b.ts", status: "in_progress", reason: "" }]),
        ruleResults: [expect.objectContaining({ ruleId: "fixture/style", status: "in_progress" })],
        proposedFiles: expect.arrayContaining(["b.ts"]),
        warnings: [warning("b.ts")],
      }),
    );
    expect(current.snapshots.at(-1)).toMatchObject({
      phase: "incomplete",
      proposedFiles: expect.arrayContaining(["a.ts", "b.ts", "c.ts"]),
      warnings: [warning("b.ts")],
    });
  });

  test("cancels in-flight requests, preserves known results, and leaves unstarted groups skipped", async () => {
    const controller = new AbortController();
    const run = vi.fn(async (input: AdapterExecuteRequest) => {
      const targets = selected(input);
      if (targets[0] === "a.ts") {
        return reply(targets, { changes: [replacement("a.ts")] });
      }
      input.onAnalysisUpdate?.({
        type: "aquarius.analysis_update",
        revision: 1,
        fileResults: [{ path: "b.ts", status: "in_progress", reason: "" }],
        ruleResults: [{ ruleId: "fixture/style", status: "in_progress", reason: "" }],
        proposedFiles: ["b.ts"],
        warnings: [warning("b.ts")],
      });
      return new Promise(() => {});
    });
    const current = fixture(["a.ts", "b.ts", "c.ts"], run);
    const running = current.run({ signal: controller.signal });
    await vi.waitFor(() => expect(current.snapshots.at(-1)?.proposedFiles).toContain("b.ts"));
    controller.abort();
    const result = await running;

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0].signal.aborted).toBe(true);
    expect(result.errors.some(({ code }) => code === "AI_ABORTED")).toBe(true);
    expect(result.proposedFiles).toEqual(["a.ts"]);
    expect(result.fileResults.map(({ status }) => status)).toEqual([
      "completed",
      "failed",
      "skipped",
    ]);
    expect(current.snapshots.at(-1)?.proposedFiles).toEqual(["a.ts", "b.ts"]);
    expect(current.snapshots.at(-1)?.warnings).toEqual([warning("b.ts")]);
  });

  test("does not invoke the adapter when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async (input: AdapterExecuteRequest) => reply(selected(input)));
    const current = fixture(["a.ts", "b.ts"], run);
    const result = await current.run({ signal: controller.signal });

    expect(run).not.toHaveBeenCalled();
    expect(result.fileResults.every(({ status }) => status === "skipped")).toBe(true);
    expect(result.errors[0]?.code).toBe("AI_ABORTED");
    expect(result.skippedRules).toEqual([]);
  });

  test("keeps a group unstarted when its initial report cancels execution", async () => {
    const controller = new AbortController();
    const run = vi.fn(async (input: AdapterExecuteRequest) => reply(selected(input)));
    const current = fixture(["a.ts", "b.ts"], run);
    const result = await current.run({
      signal: controller.signal,
      onAnalysisUpdate: () => controller.abort(),
    });

    expect(run).not.toHaveBeenCalled();
    expect(result.fileResults.every(({ status }) => status === "skipped")).toBe(true);
    expect(result.errors[0]?.code).toBe("AI_ABORTED");
  });

  test("retains a context warning when its referenced file group fails", async () => {
    const run = vi.fn(async (input: AdapterExecuteRequest) => {
      const targets = selected(input);
      if (targets[0] === "a.ts") {
        return reply(targets, { warnings: [warning("c.ts")] });
      }
      if (targets[0] === "b.ts") return reply(targets);
      return reply(targets, {
        completedRuleIds: [],
        errors: [
          { code: "RULE_FAILED", ruleIds: ["fixture/style"], message: "Cannot review c.ts." },
        ],
      });
    });
    const current = fixture(["a.ts", "b.ts", "c.ts"], run);
    const result = await current.run();

    expect(run).toHaveBeenCalledTimes(3);
    expect(result.fileResults.at(-1)?.status).toBe("failed");
    expect(result.warnings).toEqual([warning("c.ts")]);
    expect(current.snapshots.at(-1)?.fileResults).toEqual(result.fileResults);
    expect(current.snapshots.at(-1)?.warnings).toEqual(result.warnings);
    expect(current.onWarning).not.toHaveBeenCalled();
  });

  test("only globally skips a rule after every group confirms it is inapplicable", async () => {
    const run = vi.fn(async (input: AdapterExecuteRequest) =>
      reply(selected(input), {
        completedRuleIds: [],
        skippedRules: [
          { ruleId: "fixture/style", reason: `No matching code in ${selected(input)[0]}.` },
        ],
        fileResults: selected(input).map((path) => ({
          path,
          status: "skipped",
          reason: "No requested rule applies.",
        })),
      }),
    );
    const current = fixture(["a.ts", "b.ts"], run);
    const result = await current.run();

    expect(result.errors).toEqual([]);
    expect(result.skippedRules).toEqual([
      {
        ruleId: "fixture/style",
        reason: "No matching code in a.ts. (+1 more batch reasons)",
      },
    ]);
    expect(current.snapshots.at(-1)?.ruleResults[0]).toMatchObject({
      status: "skipped",
      reason: result.skippedRules[0]?.reason,
    });
  });
});
