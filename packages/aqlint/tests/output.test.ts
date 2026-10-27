import { expect, test, vi } from "vitest";
import { printHuman } from "../src/cli/output";

const execution = {
  exitCode: 1,
  result: {
    changedFiles: [], unknowns: [], errors: [],
    diagnostics: [{
      severity: "error" as const,
      rules: [{ rule: "example/rule\x1b[31m", severity: "error" as const }],
      message: "Reason\x1b[2J",
      locations: [{ path: "src/file.ts", line: 2, column: 3 }],
      evidence: [{ path: "src/file.ts", line: 2, message: "First detail" }, { path: "src/file.ts", line: 3, message: "Second detail" }],
    }],
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
    expect(lines[0]).toContain("\x1b[36msrc/file.ts:2:3\x1b[39m");
    expect(lines[0]).toContain("\x1b[31merror\x1b[39m");
    expect(lines[0]).toContain("\x1b[35m[example/rule[31m:error]\x1b[39m");
    expect(lines[0]).toContain("\x1b[1mReason[2J\x1b[22m");
    expect(lines[1]).toContain("\x1b[2mFirst detail\x1b[22m");
    expect(lines[2]).toContain("\x1b[2mSecond detail\x1b[22m");
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
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty); else Reflect.deleteProperty(process.stdout, "isTTY");
    if (hasColors) Object.defineProperty(process.stdout, "hasColors", hasColors); else Reflect.deleteProperty(process.stdout, "hasColors");
    log.mockRestore();
    vi.unstubAllEnvs();
  }
});
