import { afterEach, expect, test, vi } from "vitest";
import { progressLineText } from "@aquarius/core/internal";
import { analysisLines, printAnalysisSnapshot } from "../src/cli/analysis-output";
import { runCli } from "../src/cli/run";
import { executeLint } from "../src/lint/execute";
import type { LintExecutionOptions } from "../src/lint/execute";
import type { Diagnostic, LintAnalysisSnapshot, LintExecutionResult } from "../src/lint/types";

vi.mock("../src/lint/execute", () => ({ executeLint: vi.fn() }));

const plainLines = (snapshot: LintAnalysisSnapshot): string[] =>
  analysisLines(snapshot).map((line) =>
    progressLineText(line, { isTTY: false } as NodeJS.WriteStream),
  );

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const diagnostic = (message: string): Diagnostic => ({
  severity: "error",
  rules: [{ rule: "fixture/check", severity: "error" }],
  message,
  locations: [{ path: "src/main.ts", line: 1, column: 1 }],
  evidence: [{ path: "src/main.ts", line: 1, message: "Observed evidence" }],
});

const snapshot = (
  revision: number,
  overrides: Partial<LintAnalysisSnapshot> = {},
): LintAnalysisSnapshot => ({
  phase: "provisional",
  revision,
  diagnostics: [],
  fileResults: [
    { path: "src/main.ts", status: "in_progress", reason: "Checking the contract" },
    { path: "src/other.ts", status: "pending", reason: "" },
  ],
  ruleResults: [
    { ruleId: "fixture/check", status: "in_progress", reason: "Checking the contract" },
  ],
  errors: [],
  ...overrides,
});

const finalExecution = (findings: Diagnostic[] = []): LintExecutionResult => ({
  exitCode: findings.length ? 1 : 0,
  result: {
    diagnostics: findings,
    skippedRules: [],
    errors: [],
    fileResults: [{ path: "src/main.ts", status: "completed", reason: "" }],
    summary: {
      totalFiles: 1,
      successFiles: 1,
      warningFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      activeRules: 1,
    },
  },
});

test("renders current findings and review states without update banners", () => {
  const lines = plainLines(
    snapshot(2, {
      diagnostics: [diagnostic("Current diagnostic\nwith unsafe\x1b[2J text")],
      fileResults: [
        { path: "src/main.ts", status: "completed", reason: "Reviewed all applicable rules" },
        { path: "src/other.ts", status: "pending", reason: "" },
      ],
      ruleResults: [
        { ruleId: "fixture/check", status: "completed", reason: "Checked selected scope" },
      ],
    }),
  );
  const text = lines.join("\n");

  expect(lines[0]).toContain("Current diagnostics: 1");
  expect(text).toContain("Current diagnostics: 1");
  expect(text).toContain("Files 2: reviewing 0, reviewed 1");
  expect(text).toContain("File src/main.ts: reviewed");
  expect(text).toContain("Rule fixture/check: reviewed");
  expect(text).toContain("evidence src/main.ts:1: Observed evidence");
  expect(text).not.toContain("\x1b");
  expect(lines.every((line) => !line.includes("\n"))).toBe(true);
  expect(text).not.toContain("FINAL");
  expect(text).not.toContain("PROVISIONAL");
  expect(text).not.toContain("(provisional)");
});

test("does not retain a diagnostic omitted from the replacement snapshot", () => {
  const added = plainLines(snapshot(1, { diagnostics: [diagnostic("First finding")] })).join("\n");
  const revised = plainLines(snapshot(2, { diagnostics: [diagnostic("Revised finding")] })).join(
    "\n",
  );
  const removed = plainLines(snapshot(3)).join("\n");
  const final = plainLines(
    snapshot(4, { phase: "final", diagnostics: [diagnostic("Final finding")] }),
  ).join("\n");

  expect(added).toContain("First finding");
  expect(revised).toContain("Revised finding");
  expect(revised).not.toContain("First finding");
  expect(removed).toContain("Current diagnostics: 0");
  expect(removed).not.toContain("finding");
  expect(final).not.toContain("update #");
  expect(final).toContain("Final finding");
  expect(final).not.toContain("First finding");
  expect(final).not.toContain("Revised finding");
});

test("keeps interrupted findings explicitly provisional", () => {
  const text = plainLines(
    snapshot(3, {
      phase: "incomplete",
      diagnostics: [diagnostic("Still provisional")],
      fileResults: [
        { path: "src/main.ts", status: "completed", reason: "Reported before timeout" },
      ],
      errors: [{ code: "AI_TIMEOUT", message: "Timed out", ruleIds: [] }],
    }),
  ).join("\n");

  expect(text).not.toContain("update #");
  expect(text).toContain("Still provisional");
  expect(text).toContain("error (unconfirmed)");
  expect(text).not.toContain("reviewed");
  expect(text).not.toContain("Execution error AI_TIMEOUT");
  expect(text).not.toContain("FINAL");
});

test("styles review states and findings while keeping untrusted controls out of terminal output", () => {
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("NO_COLOR", undefined);
  const write = vi.fn();
  const stream = { isTTY: true, hasColors: () => true, write } as unknown as NodeJS.WriteStream;
  const current = snapshot(3, {
    diagnostics: [diagnostic("Bad contract\x1b[2J\ncontinued")],
    fileResults: [
      { path: "reviewing.ts", status: "in_progress", reason: "" },
      { path: "reviewed.ts", status: "completed", reason: "" },
      { path: "skipped.ts", status: "skipped", reason: "Not applicable" },
      { path: "failed.ts", status: "failed", reason: "Read failed" },
    ],
  });

  printAnalysisSnapshot(current, stream);
  const output = String(write.mock.calls.at(-1)![0]);
  expect(output).not.toContain("PROVISIONAL");
  expect(output).toContain("\x1b[36mreviewing.ts\x1b[39m: \x1b[36mreviewing\x1b[39m");
  expect(output).toContain("\x1b[32m✓ ");
  expect(output).toContain("\x1b[36mreviewed.ts\x1b[39m: \x1b[32mreviewed\x1b[39m");
  expect(output).toContain("\x1b[33m↷ ");
  expect(output).toContain("\x1b[36mskipped.ts\x1b[39m: \x1b[33mskipped\x1b[39m");
  expect(output).toContain("\x1b[31m✖ ");
  expect(output).toContain("\x1b[36mfailed.ts\x1b[39m: \x1b[31mfailed\x1b[39m");
  expect(output).toContain("\x1b[2m — Read failed\x1b[22m");
  expect(output).toContain("\x1b[35mfixture/check\x1b[39m");
  expect(output).toContain("\x1b[36msrc/main.ts:1:1\x1b[39m\x1b[31m error\x1b[39m");
  expect(output).not.toContain("unknown conclusions");
  expect(output).not.toContain("\x1b[2J");

  printAnalysisSnapshot({ ...current, phase: "final" }, stream);
  expect(write).toHaveBeenLastCalledWith(expect.not.stringContaining("update #"));
  printAnalysisSnapshot({ ...current, phase: "incomplete" }, stream);
  expect(write).toHaveBeenLastCalledWith(expect.stringContaining("error (unconfirmed)"));

  vi.stubEnv("NO_COLOR", "1");
  printAnalysisSnapshot(current, stream);
  const noColor = String(write.mock.calls.at(-1)![0]);
  expect(noColor).not.toContain("\x1b");
  expect(noColor).toContain("✓ File reviewed.ts");

  vi.stubEnv("TERM", "dumb");
  printAnalysisSnapshot(current, stream);
  const plain = String(write.mock.calls.at(-1)![0]);
  expect(plain).not.toContain("\x1b");
  expect(plain).not.toMatch(/[✓↷✖⚠•]/u);
  expect(plain).toContain("File reviewed.ts: reviewed");
});

test("CLI shows multiple cumulative updates before producing its single final JSON", async () => {
  vi.stubEnv("TERM", "dumb");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  let options: LintExecutionOptions | undefined;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execution = finalExecution([diagnostic("Canonical final finding")]);
  vi.mocked(executeLint).mockImplementationOnce(async (received) => {
    options = received;
    received.onAnalysisUpdate?.(
      snapshot(1, { diagnostics: [diagnostic("First provisional finding")] }),
    );
    await pending;
    received.onAnalysisUpdate?.(
      snapshot(4, {
        phase: "final",
        diagnostics: execution.result.diagnostics,
        fileResults: execution.result.fileResults,
        ruleResults: [{ ruleId: "fixture/check", status: "completed", reason: "" }],
      }),
    );
    return execution;
  });

  const running = runCli("0.1.0", {}, ["--format", "json"]);
  expect(log).not.toHaveBeenCalled();
  expect(String(write.mock.calls.at(-1)![0])).toContain("First provisional finding");
  options!.onAnalysisUpdate?.(
    snapshot(2, { diagnostics: [diagnostic("Revised provisional finding")] }),
  );
  const revised = String(write.mock.calls.at(-1)![0]);
  expect(revised).toContain("Revised provisional finding");
  expect(revised).not.toContain("First provisional finding");
  options!.onAnalysisUpdate?.(snapshot(3));
  const withdrawn = String(write.mock.calls.at(-1)![0]);
  expect(withdrawn).toContain("Current diagnostics: 0");
  expect(withdrawn).not.toContain("Revised provisional finding");
  expect(log).not.toHaveBeenCalled();

  release!();
  expect(await running).toBe(1);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(execution.result);
  const lastSnapshot = String(write.mock.calls.at(-1)![0]);
  expect(lastSnapshot).not.toContain("update #");
  expect(lastSnapshot).toContain("Canonical final finding");
  expect(lastSnapshot).not.toContain("provisional finding");
});

test("CLI preserves an incomplete snapshot after the final timeout JSON", async () => {
  vi.stubEnv("TERM", "dumb");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const failure = finalExecution();
  failure.exitCode = 2;
  failure.result.errors.push({ code: "AI_TIMEOUT", message: "Timed out", ruleIds: [] });
  failure.result.fileResults[0] = { path: "src/main.ts", status: "failed", reason: "Timed out" };
  failure.result.summary.successFiles = 0;
  failure.result.summary.failedFiles = 1;
  vi.mocked(executeLint).mockImplementationOnce(async (received) => {
    received.onAnalysisUpdate?.(snapshot(1, { diagnostics: [diagnostic("Unconfirmed finding")] }));
    received.onAnalysisUpdate?.(
      snapshot(2, {
        phase: "incomplete",
        diagnostics: [diagnostic("Unconfirmed finding")],
        errors: failure.result.errors,
      }),
    );
    return failure;
  });

  expect(await runCli("0.1.0", {}, ["--format", "json"])).toBe(2);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(failure.result);
  const retained = String(write.mock.calls.at(-1)![0]);
  expect(retained).toContain("error (unconfirmed)");
  expect(retained).toContain("Unconfirmed finding");
  expect(retained).not.toContain("FINAL");
  expect(write.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(log.mock.invocationCallOrder[0]!);
});

test("does not repeat failed reviews or errors after final output when no partial findings remain", () => {
  const write = vi.fn();
  printAnalysisSnapshot(
    snapshot(8, {
      phase: "incomplete",
      errors: [
        { code: "INCOMPLETE_REVIEW", message: "The rule review did not finish.", ruleIds: [] },
      ],
    }),
    { isTTY: false, write } as unknown as NodeJS.WriteStream,
  );

  expect(write).not.toHaveBeenCalled();
});
