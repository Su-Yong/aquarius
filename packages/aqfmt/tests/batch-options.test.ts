import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runCli } from "../src/cli/run";
import { executeFormat } from "../src/format/execute";
import type { FormatExecutionResult } from "../src/format/types";

vi.mock("../src/format/execute", () => ({ executeFormat: vi.fn() }));

const success: FormatExecutionResult = {
  exitCode: 0,
  result: {
    changedFiles: [],
    proposedFiles: [],
    warnings: [],
    errors: [],
    skippedRules: [],
    fileResults: [],
    summary: {
      totalFiles: 0,
      completedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      activeRules: 0,
    },
  },
};

beforeEach(() => {
  vi.mocked(executeFormat).mockReset().mockResolvedValue(success);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("forwards numeric batch controls and repeatable ignore options", async () => {
  expect(
    await runCli("0.1.0", {}, [
      "--file-batch-size",
      "2",
      "--max-concurrency=5",
      "--ignore-pattern",
      "generated/**",
      "--ignore-pattern",
      "vendor/**",
      "--ignore-path",
      "extra.ignore",
      "--no-ignore",
      "--with-node-modules",
      "--config",
      "custom.json",
      "--format",
      "json",
      "src",
    ]),
  ).toBe(0);
  expect(executeFormat).toHaveBeenCalledWith(
    expect.objectContaining({
      fileBatchSize: 2,
      maxConcurrency: 5,
      ignorePatterns: ["generated/**", "vendor/**"],
      ignorePaths: ["extra.ignore"],
      noIgnore: true,
      withNodeModules: true,
      configPath: "custom.json",
      paths: ["src"],
    }),
    {},
  );
});

test("leaves omitted batch options available for configured defaults", async () => {
  expect(await runCli("0.1.0", {}, ["--format", "json"])).toBe(0);
  expect(vi.mocked(executeFormat).mock.calls[0]![0]).toMatchObject({
    fileBatchSize: undefined,
    maxConcurrency: undefined,
  });
});

test.each(["--file-batch-size", "--max-concurrency", "--ignore-pattern"])(
  "rejects %s without a value before starting execution",
  async (flag) => {
    expect(await runCli("0.1.0", {}, [flag])).toBe(2);
    expect(executeFormat).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(flag));
  },
);

test("passes invalid numeric values to the execution boundary for validation", async () => {
  await runCli("0.1.0", {}, ["--file-batch-size", "not-a-number", "--format", "json"]);
  expect(vi.mocked(executeFormat).mock.calls[0]![0].fileBatchSize).toBeNaN();
});

test("documents setting discovery, scope limits, batching and ignore behavior", async () => {
  expect(await runCli("0.1.0", {}, ["--help"])).toBe(0);
  const help = String(vi.mocked(console.log).mock.calls[0]![0]);
  for (const term of [
    ".aqfmtrc.json takes precedence",
    "--file-batch-size N",
    "--max-concurrency N",
    "config or 4",
    "config or 3",
    "--ignore-pattern PATTERN",
    "--no-ignore",
    "only replace text in assigned files",
    "Module or project rules use one request",
    "timeout applies to each AI request",
    "Git exclusions",
  ]) {
    expect(help).toContain(term);
  }
  expect(executeFormat).not.toHaveBeenCalled();
});
