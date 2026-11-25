import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { printAnalysisSnapshot, progressLineText } from "@aquarius/core/cli";
import { analysisLines } from "../src/cli/analysis-output";
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

test("help describes Unified Diff and the write policy for each scope", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(await runCli("0.1.0", ["--help"])).toBe(0);
  const help = log.mock.calls.flat().join("\n");
  expect(help).toContain("Replace operations use Unified Diff patches against the original file.");
  expect(help).toMatch(
    /File-scoped rules[^.]+save validated changes even when other files or batches fail/u,
  );
  expect(help).toMatch(
    /Module or project rules[^.]+write changes only if the entire run succeeds/u,
  );
  expect(executeFormat).not.toHaveBeenCalled();
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
  printAnalysisSnapshot(analysisLines(current), stream);
  const output = String(write.mock.calls.at(-1)![0]);
  expect(output).toContain("\x1b[36mdone.ts\x1b[39m: \x1b[32mreviewed\x1b[39m");
  expect(output).toContain("Details continued");
  expect(output).not.toContain("\x1b[2J");
  expect(output).not.toContain("\x07");

  vi.stubEnv("NO_COLOR", "1");
  printAnalysisSnapshot(analysisLines(current), stream);
  const noColor = String(write.mock.calls.at(-1)![0]);
  expect(noColor).not.toContain("\x1b");
  expect(noColor).toContain("✓ File done.ts");

  vi.stubEnv("TERM", "dumb");
  printAnalysisSnapshot(analysisLines(current), stream);
  const plain = String(write.mock.calls.at(-1)![0]);
  expect(plain).not.toMatch(/[✓↷✖⚠•]/u);
});

test("omits file and rule reviews from incomplete analysis lines", () => {
  const write = vi.fn();
  printAnalysisSnapshot(
    analysisLines(
      snapshot({
        phase: "incomplete",
        fileResults: [{ path: "src/main.ts", status: "failed", reason: "Timed out" }],
      }),
    ),
    { isTTY: false, write } as unknown as NodeJS.WriteStream,
  );
  const output = String(write.mock.calls[0]![0]);
  expect(output).toBe("Formatting review incomplete (provisional)\n");
});

test("prints current progress on stderr before final text output", async () => {
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
  const running = runCli("0.1.0", ["--format", "text"]);
  expect(log).not.toHaveBeenCalled();
  expect(String(write.mock.calls.at(-1)![0])).toContain("Proposed change old.ts");
  release!();
  expect(await running).toBe(0);
  expect(log.mock.calls.flat()).toContain("Formatted src/main.ts");
  const updates = write.mock.calls.map(([value]) => String(value));
  expect(updates.some((value) => value.includes("Proposed files: 0"))).toBe(true);
  const final = updates.at(-1)!;
  expect(final).toContain("Formatting review complete");
  expect(final).toContain("Proposed change src/main.ts");
  expect(final).not.toContain("old.ts");
});

test.each([
  { exitCode: 2, format: "text", code: "AI_TIMEOUT" },
  { exitCode: 130, format: "text", code: "AI_ABORTED" },
  { exitCode: 2, format: "json", code: "AI_TIMEOUT" },
  { exitCode: 130, format: "json", code: "AI_ABORTED" },
])(
  "CLI exit $exitCode separates $format output from progress",
  async ({ exitCode, format, code }) => {
    vi.stubEnv("TERM", "dumb");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = finalExecution();
    result.exitCode = exitCode;
    result.result.changedFiles = [];
    result.result.errors = [{ code, message: "Stopped", ruleIds: [] }];
    const confirmed = {
      code: "CONFIRMED",
      message: "Final warning",
      ruleIds: ["fixture/format"],
      paths: ["src/main.ts", "src/other.ts"],
    };
    result.result.warnings = [confirmed];
    vi.mocked(executeFormat).mockImplementationOnce(async (options) => {
      options.onProgress?.("Progress before failure");
      options.onWarning?.("Warning before failure");
      options.onAnalysisUpdate?.(
        snapshot({
          phase: "incomplete",
          proposedFiles: ["src/main.ts", "src/provisional.ts"],
          warnings: [
            { ...confirmed, paths: [...confirmed.paths].reverse() },
            { ...confirmed, code: "PROVISIONAL", message: "Provisional warning" },
          ],
          errors: result.result.errors,
        }),
      );
      return result;
    });
    expect(await runCli("0.1.0", ["--format", format])).toBe(exitCode);
    if (format === "json") {
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(result.result);
      expect(write).not.toHaveBeenCalled();
      return;
    }
    expect(log.mock.calls.flat()).toContain(
      exitCode === 130 ? "Formatting cancelled" : "Formatting failed",
    );
    const snapshots = write.mock.calls
      .map(([value]) => String(value))
      .filter((value) => value.includes("Formatting review incomplete"));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toContain("Proposed change src/provisional.ts");
    expect(snapshots[0]).toContain("Provisional warning");
    expect(snapshots[0]).not.toContain("Proposed change src/main.ts");
    expect(snapshots[0]).not.toContain("Final warning");
    expect(snapshots[0]).not.toContain("File src/main.ts");
    expect(snapshots[0]).not.toContain("Rules 1");
    expect(write.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(
      log.mock.invocationCallOrder.at(-1)!,
    );
  },
);

test("omits the incomplete snapshot when final output covers its proposals and warnings", async () => {
  vi.stubEnv("TERM", "dumb");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const execution = finalExecution();
  execution.exitCode = 2;
  execution.result.errors = [
    { code: "REPLACE_OVERLAP", message: "Overlapping patches", ruleIds: [] },
  ];
  execution.result.warnings = [
    { code: "NOTICE", message: "Final warning", ruleIds: [], paths: [] },
  ];
  vi.mocked(executeFormat).mockImplementationOnce(async (options) => {
    options.onAnalysisUpdate?.(
      snapshot({
        phase: "incomplete",
        proposedFiles: execution.result.proposedFiles,
        warnings: execution.result.warnings,
        errors: execution.result.errors,
      }),
    );
    return execution;
  });
  expect(await runCli("0.1.0", [])).toBe(2);
  expect(log.mock.calls.flat()).toContain("Formatting completed with errors");
  expect(write.mock.calls.flat().join("\n")).not.toContain("Formatting review incomplete");
});
