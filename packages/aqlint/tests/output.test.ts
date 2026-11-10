import { expect, test, vi } from "vitest";
import { printHuman } from "../src/cli/output";
import type { LintExecutionResult } from "../src/lint/types";

const execution: LintExecutionResult = {
  exitCode: 1,
  result: {
    changedFiles: [],
    errors: [],
    skippedRules: [],
    summary: {
      totalFiles: 1,
      successFiles: 0,
      warningFiles: 0,
      skippedFiles: 0,
      failedFiles: 1,
      activeRules: 1,
    },
    fileResults: [{ path: "src/file.ts", status: "completed", reason: "" }],
    diagnostics: [
      {
        severity: "error" as const,
        rules: [{ rule: "example/rule\x1b[31m", severity: "error" as const }],
        message: "Reason\x1b[2J",
        locations: [{ path: "src/file.ts", line: 2, column: 3 }],
        evidence: [
          { path: "src/file.ts", line: 2, message: "First detail" },
          { path: "src/file.ts", line: 3, message: "Second detail" },
        ],
      },
    ],
  },
};

test("colors diagnostic fields on a terminal and sanitizes untrusted text", () => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const hasColors = Object.getOwnPropertyDescriptor(process.stdout, "hasColors");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("NO_COLOR", undefined);
  try {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "hasColors", { configurable: true, value: () => true });
    printHuman(execution);
    const lines = log.mock.calls.map(([line]) => String(line));
    const diagnostic = lines.find((line) => line.includes("src/file.ts:2:3"));
    expect(diagnostic).toContain("\x1b[36msrc/file.ts:2:3\x1b[39m");
    expect(diagnostic).toContain("\x1b[31merror\x1b[39m");
    expect(diagnostic).toContain("\x1b[35m[example/rule[31m:error]\x1b[39m");
    expect(diagnostic).toContain("\x1b[1mReason[2J\x1b[22m");
    expect(lines.find((line) => line.includes("First detail"))).toContain(
      "\x1b[2mFirst detail\x1b[22m",
    );
    expect(lines.find((line) => line.includes("Second detail"))).toContain(
      "\x1b[2mSecond detail\x1b[22m",
    );
    expect(lines).toContain("\x1b[31m✖\x1b[39m \x1b[1mLint complete with violations\x1b[22m");
    expect(lines.find((line) => line.includes("Files:"))).toContain("\x1b[36m•\x1b[39m");
    const success = lines.find((line) => line.includes("Success:"));
    expect(success).toContain("\x1b[32m✓\x1b[39m");
    expect(success).toContain("\x1b[1m0");
    expect(lines.find((line) => line.includes("Skipped:"))).toContain("\x1b[33m↷\x1b[39m");
    expect(lines.find((line) => line.includes("Skipped:"))).toContain("\x1b[2m");
    expect(lines.find((line) => line.includes("Warnings:"))).toContain("\x1b[33m⚠\x1b[39m");

    const failed = structuredClone(execution);
    failed.result.fileResults = [
      { path: "src/failed.ts", status: "failed", reason: "Read failed" },
    ];
    failed.result.summary.failedFiles = 1;
    log.mockClear();
    printHuman(failed);
    expect(log.mock.calls.flat().join("\n")).toContain(
      "\x1b[31mfailed\x1b[39m \x1b[36msrc/failed.ts\x1b[39m: \x1b[2mRead failed\x1b[22m",
    );
    expect(log.mock.calls.flat().find((line) => String(line).includes("Failed:"))).toBe(
      "  \x1b[31m✖\x1b[39m Failed:           \x1b[1m1\x1b[22m",
    );
    vi.stubEnv("NO_COLOR", "1");
    log.mockClear();
    printHuman(execution);
    expect(log.mock.calls.flat().join("\n")).not.toContain("\x1b");
    vi.stubEnv("NO_COLOR", undefined);
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    log.mockClear();
    printHuman(execution);
    expect(log.mock.calls.flat().join("\n")).not.toContain("\x1b");
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    if (hasColors) Object.defineProperty(process.stdout, "hasColors", hasColors);
    else Reflect.deleteProperty(process.stdout, "hasColors");
    log.mockRestore();
    vi.unstubAllEnvs();
  }
});

const captureHuman = (value: LintExecutionResult) => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    printHuman(value);
    return {
      lines: log.mock.calls.map(([line]) => String(line)),
      errors: error.mock.calls.map(([line]) => String(line)),
    };
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    log.mockRestore();
    error.mockRestore();
  }
};

test("prints aligned summary rows with blank lines and no ANSI or terminal markers to a pipe", () => {
  const value = structuredClone(execution);
  value.exitCode = 0;
  value.result.diagnostics = [];
  value.result.summary.successFiles = 1;
  value.result.summary.failedFiles = 0;

  const { lines, errors } = captureHuman(value);
  expect(lines).toEqual([
    "",
    "Lint complete",
    "",
    "  Files:            1",
    "  Success:          1",
    "  Warnings:         0",
    "  Skipped:          0",
    "  Failed:           0",
    "  Active rules:     1",
  ]);
  expect(errors).toEqual([]);
  expect(lines.join("\n")).not.toMatch(/Completed|Unknown/);
});

test("prints diagnostics and sanitized skipped and failed file reasons after the summary", () => {
  const value = structuredClone(execution);
  value.exitCode = 2;
  value.result.fileResults.push(
    { path: "src/skipped.ts\x1b[2J", status: "skipped", reason: "No applicable rule\x1b[31m" },
    { path: "src/failed.ts\x07", status: "failed", reason: "Read failed\x1b[2J" },
  );
  value.result.summary.totalFiles = 3;
  value.result.summary.skippedFiles = 1;
  value.result.summary.failedFiles = 2;

  const { lines } = captureHuman(value);
  expect(lines.join("\n")).toContain("src/file.ts:2:3 error");
  expect(lines.join("\n")).toContain("First detail");
  expect(lines.join("\n")).toContain("Second detail");
  expect(lines).toContain("skipped src/skipped.ts[2J: No applicable rule[31m");
  expect(lines).toContain("failed src/failed.ts: Read failed[2J");
  expect(lines.indexOf("Diagnostics (1)")).toBeGreaterThan(lines.indexOf("  Active rules:     1"));
  expect(lines.indexOf("Skipped / failed files (2)")).toBeGreaterThan(
    lines.indexOf("Diagnostics (1)"),
  );
  expect(lines).toContain("Lint failed");
  expect(lines).toContain("  Files:            3");
  expect(lines).toContain("  Success:          0");
  expect(lines).toContain("  Skipped:          1");
  expect(lines).toContain("  Failed:           2");
  expect(lines.join("\n")).not.toMatch(/[\x07\x1b]/);
});

test("reports every skipped file and distinguishes an all-skipped run from completion", () => {
  const value = structuredClone(execution);
  value.exitCode = 0;
  value.result.diagnostics = [];
  value.result.summary.successFiles = 1;
  value.result.summary.failedFiles = 0;
  value.result.fileResults = [
    { path: "src/file.ts", status: "skipped", reason: "No active rules." },
  ];
  value.result.summary.successFiles = 0;
  value.result.summary.skippedFiles = 1;
  value.result.summary.activeRules = 0;

  const { lines } = captureHuman(value);
  expect(lines).toContain("skipped src/file.ts: No active rules.");
  expect(lines.indexOf("Skipped / failed files (1)")).toBeGreaterThan(
    lines.indexOf("Lint skipped"),
  );
  expect(lines).toContain("Lint skipped");
  expect(lines).toContain("  Files:            1");
  expect(lines).toContain("  Success:          0");
  expect(lines).toContain("  Skipped:          1");
  expect(lines.join("\n")).not.toContain("Lint complete");
});

test("distinguishes no selected files from an undetermined selection", () => {
  const value = structuredClone(execution);
  value.exitCode = 0;
  value.result.diagnostics = [];
  value.result.summary.successFiles = 1;
  value.result.summary.failedFiles = 0;
  value.result.fileResults = [];
  value.result.summary.totalFiles = 0;
  value.result.summary.successFiles = 0;

  expect(captureHuman(value).lines).toEqual(
    expect.arrayContaining(["No files selected", "  Files:            0"]),
  );

  value.exitCode = 2;
  value.result.summary.totalFiles = null;
  value.result.summary.activeRules = 0;
  value.result.errors = [{ code: "CONFIG_INVALID", message: "Invalid configuration", ruleIds: [] }];
  const { lines, errors } = captureHuman(value);
  expect(lines).toContain("Lint not started");
  expect(lines).toContain("  Files:            undetermined");
  expect(errors).toContain("Execution errors (1)");
  expect(errors).toContain("error CONFIG_INVALID: Invalid configuration");
  expect(lines).not.toContain("  Files:            0");
});

test("keeps warning messages and evidence below the summary", () => {
  const value = structuredClone(execution);
  value.exitCode = 0;
  value.result.diagnostics[0]!.severity = "warn";
  value.result.diagnostics[0]!.rules[0]!.severity = "warn";
  value.result.diagnostics[0]!.message = "The module bypasses its public entry.";
  value.result.summary.successFiles = 0;
  value.result.summary.warningFiles = 1;
  value.result.summary.failedFiles = 0;

  const { lines } = captureHuman(value);
  const detailsIndex = lines.indexOf("Diagnostics (1)");
  expect(detailsIndex).toBeGreaterThan(lines.indexOf("  Active rules:     1"));
  expect(lines).toContain("Lint complete with warnings");
  expect(lines).toContain("  Success:          0");
  expect(lines).toContain("  Warnings:         1");
  expect(lines.join("\n")).not.toContain("Unknown");
  expect(lines[detailsIndex + 1]).toContain("src/file.ts:2:3 warn");
  expect(lines[detailsIndex + 1]).toContain("The module bypasses its public entry.");
  expect(lines[detailsIndex + 2]).toBe("  evidence src/file.ts:2: First detail");
  expect(lines[detailsIndex + 3]).toBe("  evidence src/file.ts:3: Second detail");
});

test("shows skipped rule reasons without treating them as failed files", () => {
  const value = structuredClone(execution);
  value.exitCode = 0;
  value.result.diagnostics = [];
  value.result.summary.successFiles = 1;
  value.result.summary.failedFiles = 0;
  value.result.skippedRules = [
    { ruleId: "example/archive-handles", reason: "No archive handles are opened." },
  ];

  const { lines, errors } = captureHuman(value);
  expect(lines).toContain("  Success:          1");
  expect(lines).toContain("  Failed:           0");
  expect(lines).toContain("Skipped rules (1)");
  expect(lines).toContain("example/archive-handles: No archive handles are opened.");
  expect(errors).toEqual([]);
});

test("reports cancellation without presenting a successful completion", () => {
  const value = structuredClone(execution);
  value.exitCode = 130;
  value.result.diagnostics = [];
  value.result.summary.successFiles = 1;
  value.result.summary.failedFiles = 0;
  value.result.errors = [{ code: "AI_ABORTED", message: "Execution was cancelled.", ruleIds: [] }];
  value.result.fileResults = [
    { path: "src/file.ts", status: "failed", reason: "Execution was cancelled." },
  ];
  value.result.summary.successFiles = 0;
  value.result.summary.failedFiles = 1;

  const { lines, errors } = captureHuman(value);
  expect(lines).toContain("failed src/file.ts: Execution was cancelled.");
  expect(lines.indexOf("Skipped / failed files (1)")).toBeGreaterThan(
    lines.indexOf("Lint cancelled"),
  );
  expect(lines).toContain("Lint cancelled");
  expect(lines).toContain("  Success:          0");
  expect(lines).toContain("  Failed:           1");
  expect(lines.join("\n")).not.toContain("Lint complete");
  expect(errors).toContain("Execution errors (1)");
  expect(errors).toContain("error AI_ABORTED: Execution was cancelled.");
});
