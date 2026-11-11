import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { progressLineText } from "@aquarius/core/internal";
import { analysisLines, printAnalysisSnapshot } from "../src/cli/analysis-output";
import { runCli } from "../src/cli/run";
import { executeFormat } from "../src/format/execute";
import type { FormatAnalysisSnapshot, FormatExecutionResult } from "../src/format/types";

vi.mock("../src/format/execute", () => ({ executeFormat: vi.fn() }));

const snapshot = (overrides: Partial<FormatAnalysisSnapshot> = {}): FormatAnalysisSnapshot => ({
  phase: "provisional",
  revision: 1,
  fileResults: [
    { path: "src/main.ts", status: "in_progress", reason: "Checking branches" },
    { path: "src/other.ts", status: "pending", reason: "" },
  ],
  ruleResults: [{ ruleId: "fixture/format", status: "in_progress", reason: "" }],
  proposedFiles: [],
  warnings: [],
  errors: [],
  ...overrides,
});

const finalExecution = (): FormatExecutionResult => ({
  exitCode: 0,
  result: {
    changedFiles: ["src/main.ts"],
    proposedFiles: ["src/main.ts"],
    fileResults: [{ path: "src/main.ts", status: "completed", reason: "" }],
    summary: {
      totalFiles: 1,
      completedFiles: 1,
      skippedFiles: 0,
      failedFiles: 0,
      activeRules: 1,
    },
    warnings: [],
    errors: [],
    skippedRules: [],
  },
});

beforeEach(() => {
  vi.mocked(executeFormat).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("shows file and rule review states, proposals and warning context without claiming writes", () => {
  const current = snapshot({
    proposedFiles: ["src/main.ts"],
    warnings: [
      {
        code: "UNCERTAIN",
        message: "Needs context",
        ruleIds: ["fixture/format"],
        paths: ["README.md"],
      },
    ],
  });
  const text = analysisLines(current)
    .map((line) => progressLineText(line, { isTTY: false } as NodeJS.WriteStream))
    .join("\n");
  expect(text).toContain("Formatting review in progress (provisional)");
  expect(text).toContain("Files 2: reviewing 1, reviewed 0, skipped 0, failed 0, pending 1");
  expect(text).toContain("Rules 1: reviewing 1");
  expect(text).toContain("File src/main.ts: reviewing — Checking branches");
  expect(text).toContain("Proposed change src/main.ts");
  expect(text).toContain("warn UNCERTAIN [fixture/format]: Needs context");
  expect(text).toContain("at README.md");
  expect(text).not.toContain("Formatted ");
});

test("styles terminal output and removes untrusted controls and line breaks", () => {
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("NO_COLOR", undefined);
  const write = vi.fn();
  const stream = { isTTY: true, hasColors: () => true, write } as unknown as NodeJS.WriteStream;
  const current = snapshot({
    fileResults: [
      { path: "done.ts", status: "completed", reason: "" },
      { path: "skipped.ts", status: "skipped", reason: "Not applicable" },
      { path: "failed.ts", status: "failed", reason: "Read\x07 failed" },
    ],
    proposedFiles: ["done.ts\x1b[2J"],
    warnings: [{ code: "NOTICE", ruleIds: [], message: "Details\ncontinued", paths: [] }],
  });
  printAnalysisSnapshot(current, stream);
  const output = String(write.mock.calls.at(-1)![0]);
  expect(output).toContain("\x1b[36mdone.ts\x1b[39m: \x1b[32mreviewed\x1b[39m");
  expect(output).toContain("Details continued");
  expect(output).not.toContain("\x1b[2J");
  expect(output).not.toContain("\x07");

  vi.stubEnv("NO_COLOR", "1");
  printAnalysisSnapshot(current, stream);
  const noColor = String(write.mock.calls.at(-1)![0]);
  expect(noColor).not.toContain("\x1b");
  expect(noColor).toContain("✓ File done.ts");

  vi.stubEnv("TERM", "dumb");
  printAnalysisSnapshot(current, stream);
  const plain = String(write.mock.calls.at(-1)![0]);
  expect(plain).not.toMatch(/[✓↷✖⚠•]/u);
});

test("keeps incomplete review status explicit even when there are no proposals", () => {
  const write = vi.fn();
  printAnalysisSnapshot(
    snapshot({
      phase: "incomplete",
      fileResults: [{ path: "src/main.ts", status: "failed", reason: "Timed out" }],
    }),
    { isTTY: false, write } as unknown as NodeJS.WriteStream,
  );
  const output = String(write.mock.calls[0]![0]);
  expect(output).toContain("Formatting review incomplete");
  expect(output).toContain("failed 1");
  expect(output).toContain("File src/main.ts: failed — Timed out");
  expect(output).not.toContain("Formatting review complete");
});

test("prints cumulative progress on stderr before one final stdout JSON", async () => {
  vi.stubEnv("TERM", "dumb");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = finalExecution();
  vi.mocked(executeFormat).mockImplementationOnce(async (options) => {
    options.onAnalysisUpdate?.(snapshot({ proposedFiles: ["old.ts"] }));
    await pending;
    options.onAnalysisUpdate?.(snapshot({ revision: 2, proposedFiles: [] }));
    options.onAnalysisUpdate?.(
      snapshot({
        revision: 3,
        phase: "final",
        fileResults: result.result.fileResults,
        ruleResults: [{ ruleId: "fixture/format", status: "completed", reason: "" }],
        proposedFiles: result.result.proposedFiles,
      }),
    );
    return result;
  });
  const running = runCli("0.1.0", {}, ["--format", "json"]);
  expect(log).not.toHaveBeenCalled();
  expect(String(write.mock.calls.at(-1)![0])).toContain("Proposed change old.ts");
  release!();
  expect(await running).toBe(0);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(result.result);
  const updates = write.mock.calls.map(([value]) => String(value));
  expect(updates.some((value) => value.includes("Proposed files: 0"))).toBe(true);
  const final = updates.at(-1)!;
  expect(final).toContain("Formatting review complete");
  expect(final).toContain("Proposed change src/main.ts");
  expect(final).not.toContain("old.ts");
});

test.each([2, 130])(
  "retains incomplete stderr state after final JSON for exit %s",
  async (exitCode) => {
    vi.stubEnv("TERM", "dumb");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = finalExecution();
    result.exitCode = exitCode;
    result.result.changedFiles = [];
    result.result.errors = [{ code: "AI_ABORTED", message: "Stopped", ruleIds: [] }];
    vi.mocked(executeFormat).mockImplementationOnce(async (options) => {
      options.onAnalysisUpdate?.(
        snapshot({
          phase: "incomplete",
          proposedFiles: ["src/main.ts"],
          errors: result.result.errors,
        }),
      );
      return result;
    });
    expect(await runCli("0.1.0", {}, ["--format", "json"])).toBe(exitCode);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(result.result);
    expect(String(write.mock.calls.at(-1)![0])).toContain("Formatting review incomplete");
    expect(String(write.mock.calls.at(-1)![0])).toContain("Proposed change src/main.ts");
    expect(write.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(
      log.mock.invocationCallOrder[0]!,
    );
  },
);
