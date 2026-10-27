import { expect, test, vi } from "vitest";
import { printHuman } from "../src/cli/output";

test("styles formatter warnings by field on a terminal", () => {
  const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const hasColors = Object.getOwnPropertyDescriptor(process.stderr, "hasColors");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("NO_COLOR", undefined);
  try {
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stderr, "hasColors", { configurable: true, value: () => true });
    printHuman({ exitCode: 0, result: { changedFiles: [], errors: [], warnings: [{ code: "NOTICE", ruleIds: ["example/rule"], message: "Details", paths: ["src/file.ts"] }] } }, false);
    expect(log.mock.calls[0]![0]).toContain("\x1b[35m[example/rule]\x1b[39m");
    expect(log.mock.calls[0]![0]).toContain("\x1b[1mDetails\x1b[22m");
    expect(log.mock.calls[1]![0]).toContain("\x1b[36msrc/file.ts\x1b[39m");
    vi.stubEnv("NO_COLOR", "1");
    log.mockClear();
    printHuman({ exitCode: 0, result: { changedFiles: [], errors: [], warnings: [{ code: "NOTICE", ruleIds: [], message: "Details", paths: ["src/file.ts"] }] } }, false);
    expect(log.mock.calls.flat().join("\n")).toBe("⚠ warn NOTICE: Details\n  at src/file.ts");
    vi.stubEnv("NO_COLOR", undefined);
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: false });
    log.mockClear();
    printHuman({ exitCode: 0, result: { changedFiles: [], errors: [], warnings: [{ code: "NOTICE", ruleIds: ["example/rule"], message: "Details", paths: ["src/file.ts"] }] } }, false);
    expect(log.mock.calls.flat().join("\n")).toBe("warn NOTICE [example/rule]: Details\n  at src/file.ts");
  } finally {
    if (tty) Object.defineProperty(process.stderr, "isTTY", tty); else Reflect.deleteProperty(process.stderr, "isTTY");
    if (hasColors) Object.defineProperty(process.stderr, "hasColors", hasColors); else Reflect.deleteProperty(process.stderr, "hasColors");
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
    printHuman({ exitCode: 1, result: { changedFiles: [], wouldChangeFiles: ["a.ts"], restoredFiles: ["b.ts"], warnings: [], errors: [] } }, true);
    expect(log.mock.calls.flat()).toEqual(["⚠ Would format a.ts", "✓ Restored b.ts"]);
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    log.mockClear();
    printHuman({ exitCode: 0, result: { changedFiles: ["a.ts"], warnings: [], errors: [] } }, false);
    expect(log.mock.calls.flat()).toEqual(["Formatted a.ts"]);
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty); else Reflect.deleteProperty(process.stdout, "isTTY");
    log.mockRestore();
    vi.unstubAllEnvs();
  }
});
