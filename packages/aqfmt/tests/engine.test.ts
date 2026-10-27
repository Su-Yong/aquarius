import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { executeFormat } from "../src/format/execute";
import { runCli } from "../src/cli/run";
import { printHuman } from "../src/cli/output";

import type { AiBridge, RulePlugin } from "@aquarius/core/internal";
import type { FormatResult } from "../src/format/types";

const roots: string[] = [];
const original = 'function label(ok) {\n  if (!ok) { return "no"; } else { return "ok"; }\n}\n';
const replacement = 'function label(ok) {\n  if (!ok) return "no";\n  return "ok";\n}\n';
const plugin: RulePlugin = {
  namespace: "fixture",
  formatRules: [{
    id: "format", description: "fixture", scope: "file",
    buildPrompt: () => ({ applicability: "fixture", transformation: "fixture", constraints: [] }),
  }],
};

const project = async (tool: "lint" | "format", extra: Record<string, unknown> = {}, git = false): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "aquarius-engine-test-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "sample.any"), original);
  if (git) execFileSync("git", ["init", "-q", root], { windowsHide: true });
  await writeFile(join(root, tool === "lint" ? ".aqlintrc.jsonc" : ".aqfmtrc.jsonc"), JSON.stringify({
    files: ["src/**"], plugins: ["fixture"],
    rules: [{ rule: tool === "lint" ? "fixture/first" : "fixture/format" }],
    ...extra,
  }));
  return root;
};

const formatReply = () => {
  return {
    completedRuleIds: ["fixture/format"],
    changes: [{ op: "replace", path: "src/sample.any", oldText: original, newText: replacement, ruleIds: ["fixture/format"] }],
    warnings: [], errors: [],
  };
};

const bridge = (result: unknown): AiBridge => {
  return { id: "fixture", run: vi.fn(async () => result) };
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("aquarius-engine-test-")) {
      throw new Error("Unexpected cleanup path.");
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("human CLI preserves execution error rule IDs", () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    printHuman({
      result: {
        changedFiles: [],
        warnings: [],
        errors: [{ code: "RULE_FAILED", message: "Rule failed.", ruleIds: ["fixture/format"] }],
      },
      exitCode: 2,
    }, false);
    expect(errors.mock.calls.flat().join("\n")).toContain("fixture/format");
  } finally {
    errors.mockRestore();
  }
});

test("human CLI preserves warning rules and paths", async () => {
  const root = await project("format", { ai: { adapter: "./bridge.mjs" } });
  const reply = {
    ...formatReply(),
    changes: [],
    warnings: [{
      code: "RULE_CONFLICT",
      ruleIds: ["fixture/format"],
      paths: ["src/sample.any"],
      message: "Kept the selected rule.",
    }],
  };
  await writeFile(join(root, "bridge.mjs"), `export default { id: "fixture", run: async () => (${JSON.stringify(reply)}) };`);
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await runCli("0.1.0", { fixture: plugin }, [])).toBe(0);
    const output = errors.mock.calls.flat().join("\n");
    expect(output).toContain("fixture/format");
    expect(output).toContain("src/sample.any");
  } finally {
    cwd.mockRestore();
    logs.mockRestore();
    errors.mockRestore();
  }
});

describe("format execution", () => {
  test("timeout stops a request without retry or source writes", async () => {
    const root = await project("format", { ai: { timeoutMs: 25 } });
    const runSpy = vi.fn(() => new Promise<unknown>(() => {}));
    const result = await executeFormat({ cwd: root }, { fixture: plugin }, { id: "slow", run: runSpy });
    expect(result.exitCode).toBe(2);
    expect(result.result.errors[0]!.code).toBe("AI_TIMEOUT");
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, "src", "sample.any"), "utf8")).toBe(original);
  });
});

describe("format/check/undo through real core components", () => {
  test("check does not write, normal format writes, no-op retains undo, and undo restores", async () => {
    const root = await project("format", {}, true);
    const ai = bridge(formatReply());
    const checked = await executeFormat({ cwd: root, check: true }, { fixture: plugin }, ai);
    expect(checked.exitCode).toBe(1);
    expect((checked.result as FormatResult).wouldChangeFiles).toEqual(["src/sample.any"]);
    expect(await readFile(join(root, "src", "sample.any"), "utf8")).toBe(original);

    const formatted = await executeFormat({ cwd: root }, { fixture: plugin }, ai);
    expect(formatted.exitCode).toBe(0);
    expect((formatted.result as FormatResult).changedFiles).toEqual(["src/sample.any"]);
    expect(await readFile(join(root, "src", "sample.any"), "utf8")).toBe(replacement);
    const noOp = await executeFormat({ cwd: root }, { fixture: plugin }, bridge({ ...formatReply(), changes: [] }));
    expect(noOp.exitCode).toBe(0);
    expect((noOp.result as FormatResult).changedFiles).toEqual([]);

    const undone = await executeFormat({ cwd: root, undo: true }, { fixture: plugin });
    expect(undone.exitCode).toBe(0);
    expect((undone.result as FormatResult).restoredFiles).toEqual(["src/sample.any"]);
    expect(await readFile(join(root, "src", "sample.any"), "utf8")).toBe(original);
  });

  test("rejects stale AI changes and keeps the user's concurrent edit", async () => {
    const root = await project("format");
    const userContent = original + "// User edit while AI was running\n";
    const ai: AiBridge = {
      id: "concurrent",
      async run() {
        await writeFile(join(root, "src", "sample.any"), userContent);
        return formatReply();
      },
    };
    const run = await executeFormat({ cwd: root }, { fixture: plugin }, ai);
    expect(run.exitCode).toBe(2);
    expect(await readFile(join(root, "src", "sample.any"), "utf8")).toBe(userContent);
  });

  test("rejects the whole format response when one change is outside scope", async () => {
    const root = await project("format");
    const response = formatReply();
    response.changes.push({ ...response.changes[0]!, path: "../outside.any" });
    const run = await executeFormat({ cwd: root }, { fixture: plugin }, bridge(response));
    expect(run.exitCode).toBe(2);
    expect((run.result as FormatResult).changedFiles).toEqual([]);
    expect(await readFile(join(root, "src", "sample.any"), "utf8")).toBe(original);
  });
});

