import { expect, test, vi } from "vitest";
import { printHuman } from "../src/cli/output";
import type { FormatResult } from "../src/format/types";

const emptyResult = (): FormatResult => ({
  changedFiles: [],
  proposedFiles: [],
  skippedRules: [],
  warnings: [],
  errors: [],
  fileResults: [],
  summary: { totalFiles: 0, completedFiles: 0, skippedFiles: 0, failedFiles: 0, activeRules: 0 },
});

test("styles formatter warnings by field on a terminal", () => {
  const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const hasColors = Object.getOwnPropertyDescriptor(process.stderr, "hasColors");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("NO_COLOR", undefined);
  try {
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stderr, "hasColors", { configurable: true, value: () => true });
    printHuman(
      {
        exitCode: 0,
        result: {
          ...emptyResult(),
          changedFiles: [],
          skippedRules: [],
          errors: [],
          warnings: [
            {
              code: "NOTICE",
              ruleIds: ["example/rule"],
              message: "Details",
              paths: ["src/file.ts"],
            },
          ],
        },
      },
      false,
    );
    expect(log.mock.calls[0]![0]).toContain("\x1b[35m[example/rule]\x1b[39m");
    expect(log.mock.calls[0]![0]).toContain("\x1b[1mDetails\x1b[22m");
    expect(log.mock.calls[1]![0]).toContain("\x1b[36msrc/file.ts\x1b[39m");
    vi.stubEnv("NO_COLOR", "1");
    log.mockClear();
    printHuman(
      {
        exitCode: 0,
        result: {
          ...emptyResult(),
          changedFiles: [],
          skippedRules: [],
          errors: [],
          warnings: [{ code: "NOTICE", ruleIds: [], message: "Details", paths: ["src/file.ts"] }],
        },
      },
      false,
    );
    expect(log.mock.calls.flat().join("\n")).toBe("⚠ warn NOTICE: Details\n  at src/file.ts");
    vi.stubEnv("NO_COLOR", undefined);
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: false });
    log.mockClear();
    printHuman(
      {
        exitCode: 0,
        result: {
          ...emptyResult(),
          changedFiles: [],
          skippedRules: [],
          errors: [],
          warnings: [
            {
              code: "NOTICE",
              ruleIds: ["example/rule"],
              message: "Details",
              paths: ["src/file.ts"],
            },
          ],
        },
      },
      false,
    );
    expect(log.mock.calls.flat().join("\n")).toBe(
      "warn NOTICE [example/rule]: Details\n  at src/file.ts",
    );
  } finally {
    if (tty) Object.defineProperty(process.stderr, "isTTY", tty);
    else Reflect.deleteProperty(process.stderr, "isTTY");
    if (hasColors) Object.defineProperty(process.stderr, "hasColors", hasColors);
    else Reflect.deleteProperty(process.stderr, "hasColors");
    log.mockRestore();
    vi.unstubAllEnvs();
  }
});

test("uses status markers for formatter results only on terminals", () => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("NO_COLOR", "1");
  try {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    printHuman(
      {
        exitCode: 1,
        result: {
          ...emptyResult(),
          changedFiles: [],
          skippedRules: [],
          wouldChangeFiles: ["a.ts"],
          restoredFiles: ["b.ts"],
          warnings: [],
          errors: [],
        },
      },
      true,
    );
    expect(log.mock.calls.flat()).toContain("⚠ Would format a.ts");
    expect(log.mock.calls.flat()).toContain("✓ Restored b.ts");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    log.mockClear();
    printHuman(
      {
        exitCode: 0,
        result: {
          ...emptyResult(),
          changedFiles: ["a.ts"],
          skippedRules: [],
          warnings: [],
          errors: [],
        },
      },
      false,
    );
    expect(log.mock.calls.flat()).toContain("Formatted a.ts");
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    log.mockRestore();
    vi.unstubAllEnvs();
  }
});

test.each([true, false])(
  "reports skipped targets without claiming completion with tty=%s",
  (isTTY) => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("NO_COLOR", "1");
    try {
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: isTTY });
      const result = emptyResult();
      result.fileResults = [{ path: "a.ts", status: "skipped", reason: "No active rules." }];
      result.summary = { ...result.summary, totalFiles: 1, skippedFiles: 1 };
      printHuman({ result, exitCode: 0 }, false);
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("Formatting skipped");
      expect(output).toMatch(/Files:\s+1/);
      expect(output).toMatch(/Skipped:\s+1/);
      expect(output).toContain("skipped a.ts: No active rules.");
      expect(output).not.toContain("Formatting complete");
    } finally {
      if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor);
      else Reflect.deleteProperty(process.stdout, "isTTY");
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  },
);

test("distinguishes unknown targets from an empty selection", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const result = emptyResult();
    result.summary.totalFiles = null;
    printHuman({ result, exitCode: 2 }, false);
    expect(log.mock.calls.flat().join("\n")).toMatch(
      /Formatting not started[\s\S]*Files:\s+undetermined/,
    );
    log.mockClear();
    result.summary.totalFiles = 0;
    printHuman({ result, exitCode: 0 }, false);
    expect(log.mock.calls.flat().join("\n")).toContain("No files selected");
  } finally {
    log.mockRestore();
  }
});

test("preserves valid reviews and labels proposals as unapplied on failure", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = emptyResult();
    result.proposedFiles = ["a.ts\x1b[2J"];
    result.fileResults = [
      { path: "a.ts", status: "completed", reason: "" },
      { path: "b.ts", status: "failed", reason: "Request\x07 failed" },
      { path: "c.ts", status: "skipped", reason: "Another batch failed" },
    ];
    result.summary = {
      totalFiles: 3,
      completedFiles: 1,
      failedFiles: 1,
      skippedFiles: 1,
      activeRules: 1,
    };
    result.errors = [{ code: "AI_TIMEOUT", message: "Timed out", ruleIds: [] }];
    printHuman({ result, exitCode: 2 }, false);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Formatting failed");
    expect(output).toMatch(/Reviewed:\s+1/);
    expect(output).toMatch(/Written files:\s+0/);
    expect(output).toContain("Proposed (not applied) a.ts");
    expect(output).toContain("failed b.ts: Request failed");
    expect(output).toContain("skipped c.ts: Another batch failed");
    expect(output).not.toContain("Formatted ");
    expect(output).not.toContain("\x1b[2J");
    expect(output).not.toContain("\x07");
    expect(error.mock.calls.flat().join("\n")).toContain("AI_TIMEOUT");
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test.each([
  { check: false, heading: "Formatting completed with errors", action: "✓ Formatted", written: 1 },
  {
    check: true,
    heading: "Formatting check completed with errors",
    action: "⚠ Would format",
    written: 0,
  },
])("reports partial results once in $heading", ({ check, heading, action, written }) => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("NO_COLOR", "1");
  try {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const result = emptyResult();
    result.proposedFiles = ["good.ts", "pending.ts"];
    result.summary = { ...result.summary, totalFiles: 2, completedFiles: 1, failedFiles: 1 };
    if (check) result.wouldChangeFiles = ["good.ts"];
    else result.changedFiles = ["good.ts"];
    printHuman({ result, exitCode: 2 }, check);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain(heading);
    expect(output).toMatch(new RegExp(`Written files:\\s+${written}`));
    expect(output).toContain(`${action} good.ts`);
    expect(output).toContain("Proposed (not applied) pending.ts");
    expect(output).not.toContain("Proposed (not applied) good.ts");
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    log.mockRestore();
    vi.unstubAllEnvs();
  }
});

test("undo output reports restored files without a review summary", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    printHuman({ result: { ...emptyResult(), restoredFiles: ["a.ts"] }, exitCode: 0 }, false);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Undo complete");
    expect(output).toContain("Restored files: 1");
    expect(output).toContain("Restored a.ts");
    expect(output).not.toContain("Reviewed:");
    expect(output).not.toContain("Formatting complete");
  } finally {
    log.mockRestore();
  }
});

test("cancellation is distinct from successful formatting", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    printHuman({ result: emptyResult(), exitCode: 130 }, false);
    expect(log.mock.calls.flat().join("\n")).toContain("Formatting cancelled");
    expect(log.mock.calls.flat().join("\n")).not.toContain("Formatting complete");
  } finally {
    log.mockRestore();
  }
});
