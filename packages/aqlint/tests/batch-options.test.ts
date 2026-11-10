import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runCli } from "../src/cli/run";
import { executeLint } from "../src/lint/execute";
import type { LintExecutionResult } from "../src/lint/types";

vi.mock("../src/lint/execute", () => ({ executeLint: vi.fn() }));

const success: LintExecutionResult = {
  exitCode: 0,
  result: {
    diagnostics: [],
    errors: [],
    skippedRules: [],
    fileResults: [],
    summary: {
      totalFiles: 0,
      successFiles: 0,
      warningFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      activeRules: 0,
    },
  },
};

beforeEach(() => {
  vi.mocked(executeLint).mockReset().mockResolvedValue(success);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("forwards explicit batching overrides as numbers", async () => {
  const code = await runCli("0.1.0", {}, [
    "--file-batch-size",
    "2",
    "--max-concurrency=5",
    "--config",
    "custom.json",
    "--format",
    "json",
    "src",
  ]);

  expect(code).toBe(0);
  expect(executeLint).toHaveBeenCalledWith(
    expect.objectContaining({
      fileBatchSize: 2,
      maxConcurrency: 5,
      configPath: "custom.json",
      paths: ["src"],
    }),
    {},
  );
});

test("leaves omitted batching options available for configuration defaults", async () => {
  expect(await runCli("0.1.0", {}, ["--format", "json"])).toBe(0);
  expect(vi.mocked(executeLint).mock.calls[0]![0]).toMatchObject({
    fileBatchSize: undefined,
    maxConcurrency: undefined,
  });
});

test.each(["--file-batch-size", "--max-concurrency"])(
  "rejects %s without its required value",
  async (flag) => {
    expect(await runCli("0.1.0", {}, [flag])).toBe(2);
    expect(executeLint).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(flag));
  },
);

test("documents both batching controls in help", async () => {
  expect(await runCli("0.1.0", {}, ["--help"])).toBe(0);
  const help = String(vi.mocked(console.log).mock.calls[0]![0]);

  expect(help).toContain("--file-batch-size N");
  expect(help).toContain("--max-concurrency N");
  expect(help).toContain("config or 4");
  expect(help).toContain("config or 3");
  expect(executeLint).not.toHaveBeenCalled();
});

test("documents explicit preset and rule selection in help", async () => {
  expect(await runCli("0.1.0", {}, ["--help"])).toBe(0);
  const help = String(vi.mocked(console.log).mock.calls[0]![0]);

  expect(help).toContain("without activating them");
  expect(help).toContain("preset array");
  expect(help).toContain("rules object");
  expect(help).toContain("[level, options]");
  expect(help).toContain("direct\nrules take precedence");
  expect(executeLint).not.toHaveBeenCalled();
});
