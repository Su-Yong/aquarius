import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  AiBridge,
  BridgeInput,
  PathPolicy,
  PreparedRule,
  RuleResources,
} from "@aquarius/core/internal";
import { createFormatAnalysis } from "../src/format/analysis";
import { reviewFormatBatches } from "../src/format/batches";
import { formatResponseJsonSchema } from "../src/format/schemas";
import type {
  FileChange,
  FormatAnalysisSnapshot,
  FormatResponse,
  FormatWarning,
} from "../src/format/types";

const rules: PreparedRule[] = [
  {
    id: "fixture/style",
    scope: "file",
    instructions: { applicability: "Fixture", transformation: "Fixture", constraints: [] },
  },
];

const resources: RuleResources = {
  directory: "/unused-resources",
  files: [
    {
      ruleId: "fixture/style",
      scope: "file",
      applicability: "Fixture",
      detailsPath: ".aquarius-rules-test/style.json",
      contentHash: "unused",
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
  oldText: "before",
  newText: "after",
  ruleIds: ["fixture/style"],
});

const warning = (path: string): FormatWarning => ({
  code: "UNSAFE_TRANSFORMATION",
  message: "Preservation needs further review.",
  ruleIds: ["fixture/style"],
  paths: [path],
});

const selected = (input: BridgeInput): string[] => {
  const metadata = JSON.parse(input.prompt.slice(input.prompt.lastIndexOf("\n\n") + 2));
  return metadata.targets;
};

const fixture = (targets: string[], run: AiBridge["run"]) => {
  const selectedFiles = new Set(targets);
  const policy: PathPolicy = {
    projectRoot: "/project",
    targets,
    readableFiles: [...targets, "context.md"],
    ignoreRules: [],
    isIgnored: () => false,
    canWrite: (path) => selectedFiles.has(path),
  };
  const snapshots: FormatAnalysisSnapshot[] = [];
  const onWarning = vi.fn();
  const analysis = createFormatAnalysis(rules, policy, resources, {
    onUpdate: (snapshot) => snapshots.push(snapshot),
    onWarning,
  });
  const input: Omit<BridgeInput, "signal"> = {
    projectRoot: policy.projectRoot,
    readableFiles: policy.readableFiles,
    ignore: [],
    prompt: "",
    ruleResources: resources,
    outputSchema: formatResponseJsonSchema,
    options: {},
  };
  return {
    snapshots,
    onWarning,
    options: {
      bridge: { id: "fixture", run },
      input,
      rules,
      policy,
      writeScope: { files: ["**/*"] },
      fileBatchSize: 1,
      maxConcurrency: 1,
      timeoutMs: 1_000,
      analysis,
      onWarning,
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("format file groups", () => {
  test("limits concurrency, retains reference files, and orders results by target group", async () => {
    const gates = Array.from({ length: 3 }, () => Promise.withResolvers<RawResponse>());
    const targets = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const calls: BridgeInput[] = [];
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
    const running = reviewFormatBatches({
      ...current.options,
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
    expect(result.changes).toEqual([replacement("a.ts"), replacement("c.ts"), replacement("e.ts")]);
    expect(current.onWarning).not.toHaveBeenCalled();
  });

  test.each([
    { op: "create", path: "new.ts", content: "new", ruleIds: ["fixture/style"] },
    { op: "delete", path: "a.ts", ruleIds: ["fixture/style"] },
    { op: "move", from: "a.ts", to: "new.ts", ruleIds: ["fixture/style"] },
  ] as FileChange[])("rejects $op in a single file group without retry", async (change) => {
    const run = vi.fn(async () => reply(["a.ts"], { changes: [change] }));
    const current = fixture(["a.ts"], run);
    const result = await reviewFormatBatches(current.options);

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.changes).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.retryable).toBe(false);
  });

  test("rejects changes to another group and skips groups that never started", async () => {
    const run = vi.fn(async (input: BridgeInput) =>
      reply(selected(input), {
        changes: [replacement("b.ts")],
      }),
    );
    const current = fixture(["a.ts", "b.ts", "c.ts"], run);
    const result = await reviewFormatBatches(current.options);

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.changes).toEqual([]);
    expect(result.fileResults.slice(1)).toEqual([
      {
        path: "b.ts",
        status: "skipped",
        reason: expect.stringContaining("another file group failed"),
      },
      {
        path: "c.ts",
        status: "skipped",
        reason: expect.stringContaining("another file group failed"),
      },
    ]);
    expect(current.snapshots.at(-1)?.fileResults).toEqual(result.fileResults);
  });

  test("retries one incomplete response and replaces its proposals and warnings", async () => {
    const prompts: string[] = [];
    const run = vi.fn(async (input: BridgeInput) => {
      prompts.push(input.prompt);
      if (prompts.length === 1) {
        return reply(["a.ts"], {
          changes: [replacement("a.ts")],
          warnings: [warning("a.ts")],
        });
      }
      return reply(["a.ts", "b.ts"], { changes: [replacement("b.ts")] });
    });
    const current = fixture(["a.ts", "b.ts"], run);
    const result = await reviewFormatBatches({ ...current.options, fileBatchSize: 2 });

    expect(run).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain("previous attempt");
    expect(result.errors).toEqual([]);
    expect(result.changes).toEqual([replacement("b.ts")]);
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
    const run = vi.fn(async () => {
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
    const current = fixture(["a.ts"], run);

    const result = await reviewFormatBatches(current.options);

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.errors).toEqual([]);
    expect(result.fileResults).toEqual([{ path: "a.ts", status: "completed", reason: "" }]);
    expect(result.changes).toEqual([replacement("a.ts")]);
  });

  test("stops after the second incomplete response", async () => {
    const run = vi.fn(async () => reply([]));
    const current = fixture(["a.ts", "b.ts"], run);
    const result = await reviewFormatBatches(current.options);

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.fileResults[0]?.status).toBe("failed");
    expect(result.fileResults[1]?.status).toBe("skipped");
    expect(result.retryable).toBe(false);
  });

  test("does not retry a malformed response", async () => {
    const run = vi.fn(async () => ({ changes: [] }));
    const current = fixture(["a.ts", "b.ts"], run);
    const result = await reviewFormatBatches(current.options);

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.errors[0]?.code).toBe("INVALID_AI_RESPONSE");
    expect(result.fileResults.map(({ status }) => status)).toEqual(["failed", "skipped"]);
  });

  test("finishes in-flight groups after another group fails without starting more", async () => {
    const first = Promise.withResolvers<RawResponse>();
    const second = Promise.withResolvers<RawResponse>();
    const run = vi.fn(async (input: BridgeInput) =>
      selected(input)[0] === "a.ts" ? first.promise : second.promise,
    );
    const current = fixture(["a.ts", "b.ts", "c.ts", "d.ts"], run);
    const running = reviewFormatBatches({ ...current.options, maxConcurrency: 2 });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    first.resolve(
      reply(["a.ts"], {
        completedRuleIds: [],
        errors: [
          { code: "RULE_FAILED", ruleIds: ["fixture/style"], message: "Cannot review this file." },
        ],
      }),
    );
    await vi.waitFor(() => expect(current.snapshots.at(-1)?.ruleResults[0]?.status).toBe("failed"));
    expect(run.mock.calls[1]?.[0].signal.aborted).toBe(false);
    second.resolve(reply(["b.ts"], { changes: [replacement("b.ts")] }));
    const result = await running;

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.changes).toEqual([replacement("b.ts")]);
    expect(result.fileResults.map(({ status }) => status)).toEqual([
      "failed",
      "completed",
      "skipped",
      "skipped",
    ]);
    expect(current.snapshots.at(-1)?.fileResults).toEqual(result.fileResults);
    expect(current.snapshots.at(-1)?.ruleResults[0]?.status).toBe("failed");
  });

  test("does not begin a retry after a different group has failed", async () => {
    const first = Promise.withResolvers<RawResponse>();
    const second = Promise.withResolvers<RawResponse>();
    const run = vi.fn(async (input: BridgeInput) =>
      selected(input)[0] === "a.ts" ? first.promise : second.promise,
    );
    const current = fixture(["a.ts", "b.ts", "c.ts"], run);
    const running = reviewFormatBatches({ ...current.options, maxConcurrency: 2 });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    second.resolve(reply(["b.ts"], { changes: [replacement("c.ts")] }));
    await vi.waitFor(() => expect(current.snapshots.at(-1)?.ruleResults[0]?.status).toBe("failed"));
    first.resolve(reply([]));
    const result = await running;

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.fileResults.at(-1)?.status).toBe("skipped");
  });

  test("times out a group without retrying or discarding earlier results", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async (input: BridgeInput) => {
      if (selected(input)[0] === "a.ts") {
        return reply(["a.ts"], { changes: [replacement("a.ts")] });
      }
      return new Promise(() => {});
    });
    const current = fixture(["a.ts", "b.ts", "c.ts"], run);
    const running = reviewFormatBatches({ ...current.options, timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(30);
    const result = await running;

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.errors[0]?.code).toBe("AI_TIMEOUT");
    expect(result.changes).toEqual([replacement("a.ts")]);
    expect(result.fileResults.map(({ status }) => status)).toEqual([
      "completed",
      "failed",
      "skipped",
    ]);
  });

  test("cancels in-flight requests, preserves known results, and leaves unstarted groups skipped", async () => {
    const controller = new AbortController();
    const run = vi.fn(async (input: BridgeInput) => {
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
    const running = reviewFormatBatches({ ...current.options, signal: controller.signal });
    await vi.waitFor(() => expect(current.snapshots.at(-1)?.proposedFiles).toContain("b.ts"));
    controller.abort();
    const result = await running;

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0].signal.aborted).toBe(true);
    expect(result.errors.some(({ code }) => code === "AI_ABORTED")).toBe(true);
    expect(result.changes).toEqual([replacement("a.ts")]);
    expect(result.fileResults.map(({ status }) => status)).toEqual([
      "completed",
      "failed",
      "skipped",
    ]);
    expect(current.snapshots.at(-1)?.proposedFiles).toEqual(["a.ts", "b.ts"]);
    expect(current.snapshots.at(-1)?.warnings).toEqual([warning("b.ts")]);
  });

  test("does not call the bridge when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async (input: BridgeInput) => reply(selected(input)));
    const current = fixture(["a.ts", "b.ts"], run);
    const result = await reviewFormatBatches({ ...current.options, signal: controller.signal });

    expect(run).not.toHaveBeenCalled();
    expect(result.fileResults.every(({ status }) => status === "skipped")).toBe(true);
    expect(result.errors[0]?.code).toBe("AI_ABORTED");
    expect(result.skippedRules).toEqual([]);
  });

  test("keeps a group unstarted when its initial report cancels execution", async () => {
    const controller = new AbortController();
    const run = vi.fn(async (input: BridgeInput) => reply(selected(input)));
    const current = fixture(["a.ts", "b.ts"], run);
    const analysis = {
      ...current.options.analysis,
      update: (update: unknown) => {
        current.options.analysis.update(update);
        controller.abort();
      },
    };
    const result = await reviewFormatBatches({
      ...current.options,
      analysis,
      signal: controller.signal,
    });

    expect(run).not.toHaveBeenCalled();
    expect(result.fileResults.every(({ status }) => status === "skipped")).toBe(true);
    expect(result.errors[0]?.code).toBe("AI_ABORTED");
  });

  test("retains a context warning when its referenced file group never starts", async () => {
    const run = vi.fn(async (input: BridgeInput) => {
      const targets = selected(input);
      if (targets[0] === "a.ts") {
        return reply(targets, { warnings: [warning("c.ts")] });
      }
      return reply(targets, {
        completedRuleIds: [],
        errors: [
          { code: "RULE_FAILED", ruleIds: ["fixture/style"], message: "Cannot review b.ts." },
        ],
      });
    });
    const current = fixture(["a.ts", "b.ts", "c.ts"], run);
    const result = await reviewFormatBatches(current.options);

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.fileResults.at(-1)?.status).toBe("skipped");
    expect(result.warnings).toEqual([warning("c.ts")]);
    expect(current.snapshots.at(-1)?.fileResults).toEqual(result.fileResults);
    expect(current.snapshots.at(-1)?.warnings).toEqual(result.warnings);
    expect(current.onWarning).not.toHaveBeenCalled();
  });

  test("only globally skips a rule after every group confirms it is inapplicable", async () => {
    const run = vi.fn(async (input: BridgeInput) =>
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
    const result = await reviewFormatBatches(current.options);

    expect(result.errors).toEqual([]);
    expect(result.skippedRules).toEqual([
      {
        ruleId: "fixture/style",
        reason: "No matching code in a.ts. No matching code in b.ts.",
      },
    ]);
    expect(current.snapshots.at(-1)?.ruleResults[0]?.status).toBe("skipped");
  });
});
