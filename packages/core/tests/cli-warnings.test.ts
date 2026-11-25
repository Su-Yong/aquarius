import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, test, vi } from "vitest";

import { runToolCli } from "../src/cli/run";
import type { ToolExecutionOptions } from "../src/execution/types";

const tool = {
  name: "fixture",
  description: "Fixture tool",
  help: "",
  printHuman: () => {},
  analysisLines: () => [],
};

afterEach(() => vi.restoreAllMocks());

test.each([false, true])(
  "coalesces repeated CLI warnings when execute throws=%s",
  async (throws) => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings = () =>
      stderr.mock.calls.map(([text]) =>
        stripVTControlCharacters(String(text)).replace(/^[⚠✖] /u, ""),
      );

    const execute = async ({ onWarning }: ToolExecutionOptions<object>) => {
      onWarning!("Repeated update warning");
      expect(warnings()).toEqual(["fixture: Repeated update warning"]);
      onWarning!("Another update warning");
      onWarning!("One-time warning");
      onWarning!("Another update warning");
      for (let index = 0; index < 35; index += 1) onWarning!("Repeated update warning");
      expect(warnings()).toEqual([
        "fixture: Repeated update warning",
        "fixture: Another update warning",
        "fixture: One-time warning",
      ]);
      if (throws) throw new Error("Execution failed");
      return { result: {}, exitCode: 0 };
    };

    expect(await runToolCli({ ...tool, execute }, "0.0.0", [])).toBe(throws ? 2 : 0);
    expect(warnings()).toEqual([
      "fixture: Repeated update warning",
      "fixture: Another update warning",
      "fixture: One-time warning",
      "fixture: Repeated update warning (+35 more)",
      "fixture: Another update warning (+1 more)",
      ...(throws ? ["fixture: Execution failed"] : []),
    ]);
  },
);

test("omits analysis and warning callbacks in JSON mode", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  const execute = async (options: ToolExecutionOptions<object>) => {
    expect(options).not.toHaveProperty("onAnalysisUpdate");
    expect(options).not.toHaveProperty("onWarning");
    return { result: { complete: true }, exitCode: 0 };
  };

  expect(await runToolCli({ ...tool, execute }, "0.0.0", ["--format", "json"])).toBe(0);
  expect(stdout).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ complete: true }, null, 2));
  expect(stderr).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
});
