import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { executeFormat } from "../src/format/execute";
import { runCli } from "../src/cli/run";
import { printHuman } from "../src/cli/output";

import type { AiBridge, BridgeInput, RulePlugin, RuleReference } from "@aquarius/core/internal";
import type { FileChange, FormatResult, FormatWarning } from "../src/format/types";

const roots: string[] = [];
const original = 'function label(ok) {\n  if (!ok) { return "no"; } else { return "ok"; }\n}\n';
const replacement = 'function label(ok) {\n  if (!ok) return "no";\n  return "ok";\n}\n';
const plugin: RulePlugin = {
  namespace: "fixture",
  formatRules: [
    {
      id: "format",
      description: "fixture",
      scope: "file",
      buildPrompt: () => ({ applicability: "fixture", transformation: "fixture", constraints: [] }),
    },
  ],
  presets: {
    all: { "fixture/format": true },
  },
};

const project = async (
  tool: "lint" | "format",
  extra: Record<string, unknown> = {},
  git = false,
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "aquarius-engine-test-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "sample.any"), original);
  if (git) execFileSync("git", ["init", "-q", root], { windowsHide: true });
  await writeFile(
    join(root, tool === "lint" ? ".aqlintrc.jsonc" : ".aqfmtrc.jsonc"),
    JSON.stringify({
      files: ["src/**"],
      plugins: ["fixture"],
      rules: tool === "lint" ? { "fixture/first": "error" } : { "fixture/format": true },
      ...extra,
    }),
  );
  return root;
};

const formatReply = () => {
  return {
    completedRuleIds: ["fixture/format"],
    skippedRules: [],
    changes: [
      {
        op: "replace" as const,
        path: "src/sample.any",
        oldText: original,
        newText: replacement,
        ruleIds: ["fixture/format"],
      },
    ],
    warnings: [],
    errors: [],
  };
};

const bridge = (result: unknown): AiBridge => {
  return { id: "fixture", run: vi.fn(async () => result) };
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("aquarius-engine-test-")
    ) {
      throw new Error("Unexpected cleanup path.");
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("requires an explicit AI adapter before transforming files", async () => {
  const root = await project("format");
  const run = await executeFormat({ cwd: root }, { fixture: plugin });
  expect(run.exitCode).toBe(2);
  expect(run.result.errors).toEqual([
    expect.objectContaining({
      code: "AI_ADAPTER_REQUIRED",
      message: expect.stringContaining("ai.adapter"),
    }),
  ]);
  expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(original);
});

test("accepts reference warnings outside target patterns and keeps writes in scope", async () => {
  const root = await project("format", { ignore: ["README.md"] });
  await writeFile(join(root, "README.md"), "Project contract\n");
  const ai = bridge({
    ...formatReply(),
    warnings: [
      {
        code: "CONTRACT_CONFLICT",
        ruleIds: ["fixture/format"],
        message: "A related project contract needs review",
        paths: ["README.md"],
      },
    ],
  });
  const execution = await executeFormat({ cwd: root }, { fixture: plugin }, ai);

  const input = vi.mocked(ai.run).mock.calls[0]![0];
  expect(input.readableFiles).toEqual([".aqfmtrc.jsonc", "README.md", "src/sample.any"]);
  expect(input.ignore).toEqual([]);
  expect(execution.exitCode).toBe(0);
  expect(execution.result.errors).toEqual([]);
  expect(execution.result.warnings).toContainEqual(
    expect.objectContaining({ code: "CONTRACT_CONFLICT", paths: ["README.md"] }),
  );
  expect(execution.result.changedFiles).toEqual(["src/sample.any"]);
  expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(replacement);
  expect(await readFile(join(root, "README.md"), "utf8")).toBe("Project contract\n");
});

test("human CLI preserves execution error rule IDs", () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    printHuman(
      {
        result: {
          changedFiles: [],
          skippedRules: [],
          warnings: [],
          errors: [{ code: "RULE_FAILED", message: "Rule failed.", ruleIds: ["fixture/format"] }],
        },
        exitCode: 2,
      },
      false,
    );
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
    warnings: [
      {
        code: "RULE_CONFLICT",
        ruleIds: ["fixture/format"],
        paths: ["src/sample.any"],
        message: "Kept the selected rule.",
      },
    ],
  };
  await writeFile(
    join(root, "bridge.mjs"),
    `export default { id: "fixture", run: async () => (${JSON.stringify(reply)}) };`,
  );
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

test("JSON output stays machine-readable while progress is written to stderr", async () => {
  const root = await project("format", { rules: {} });
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const writes = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
  try {
    expect(await runCli("0.1.0", { fixture: plugin }, ["--format", "json"])).toBe(0);
    expect(JSON.parse(String(logs.mock.calls[0]?.[0]))).toEqual({
      changedFiles: [],
      skippedRules: [],
      warnings: [],
      errors: [],
    });
    expect(writes.mock.calls.some(([text]) => String(text).includes("[00:00] Preparing"))).toBe(
      true,
    );
  } finally {
    if (tty) Object.defineProperty(process.stderr, "isTTY", tty);
    else Reflect.deleteProperty(process.stderr, "isTTY");
    cwd.mockRestore();
    logs.mockRestore();
    writes.mockRestore();
  }
});

test("cache warnings use stderr while JSON formatting remains successful", async () => {
  const root = await project("format", { ai: { adapter: "./bridge.mjs" } });
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", ".cache"), "This is not a cache directory.");
  const reply = { ...formatReply(), changes: [] };
  await writeFile(
    join(root, "bridge.mjs"),
    [
      'import { readFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      "export default {",
      '  id: "fixture",',
      "  async run(input) {",
      "    for (const file of input.ruleResources.files) {",
      '      await readFile(join(input.ruleResources.directory, file.detailsPath), "utf8");',
      "    }",
      `    return ${JSON.stringify(reply)};`,
      "  },",
      "};",
    ].join("\n"),
  );
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await runCli("0.1.0", { fixture: plugin }, ["--format", "json"])).toBe(0);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logs.mock.calls[0]?.[0]))).toEqual({
      changedFiles: [],
      skippedRules: [],
      warnings: [],
      errors: [],
    });
    expect(errors.mock.calls.flat().join("\n")).toContain("aqfmt:");
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(original);
  } finally {
    cwd.mockRestore();
    logs.mockRestore();
    errors.mockRestore();
  }
});

describe("format execution", () => {
  test("fails missing required rule options before calling AI or changing files", async () => {
    const root = await project("format", {
      rules: { "fixture/format": true, "fixture/configured": true },
    });
    const configuredPlugin: RulePlugin = {
      ...plugin,
      formatRules: [
        ...plugin.formatRules!,
        {
          ...plugin.formatRules![0]!,
          id: "configured",
          optionsSchema: z.object({ requiredValue: z.string() }).strict(),
        },
      ],
    };
    const ai = bridge(formatReply());

    const execution = await executeFormat({ cwd: root }, { fixture: configuredPlugin }, ai);

    expect(execution.exitCode).toBe(2);
    expect(execution.result.errors).toContainEqual(
      expect.objectContaining({
        code: "RULE_OPTIONS_INVALID",
        ruleIds: ["fixture/configured"],
        message: expect.stringContaining("requiredValue"),
      }),
    );
    expect(ai.run).not.toHaveBeenCalled();
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(original);
  });

  test("runs preset-only selections and skips registered lint rules", async () => {
    const root = await project("format", { preset: ["fixture/all"], rules: undefined });
    const lintPrompt = vi.fn(() => ({
      applicability: "fixture",
      criteria: "Check the fixture.",
      evidenceRequirements: [],
    }));
    const mixedPlugin: RulePlugin = {
      ...plugin,
      lintRules: [
        {
          id: "lint",
          description: "fixture lint",
          scope: "file",
          buildPrompt: lintPrompt,
        },
      ],
      presets: {
        all: { "fixture/lint": "warn", "fixture/format": true },
      },
    };
    const ai = bridge(formatReply());

    const execution = await executeFormat({ cwd: root }, { fixture: mixedPlugin }, ai);

    expect(execution.exitCode).toBe(0);
    expect(execution.result.errors).toEqual([]);
    expect(execution.result.changedFiles).toEqual(["src/sample.any"]);
    expect(lintPrompt).not.toHaveBeenCalled();
    expect(ai.run).toHaveBeenCalledTimes(1);
    const input = vi.mocked(ai.run).mock.calls[0]![0];
    expect(input.ruleResources.files.map(({ ruleId }) => ruleId)).toEqual(["fixture/format"]);
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(replacement);
  });

  test("reports an unknown preset without invoking AI", async () => {
    const root = await project("format", { preset: ["fixture/missing"], rules: {} });
    const ai = bridge(formatReply());

    const execution = await executeFormat({ cwd: root }, { fixture: plugin }, ai);

    expect(execution.exitCode).toBe(2);
    expect(execution.result.errors).toContainEqual(
      expect.objectContaining({ code: "PRESET_NOT_FOUND" }),
    );
    expect(execution.result.changedFiles).toEqual([]);
    expect(ai.run).not.toHaveBeenCalled();
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(original);
  });

  test.each([false, true])(
    "keeps valid formatting results after a rule preparation failure with check=%s",
    async (check) => {
      const root = await project("format", {
        preset: ["fixture/all"],
        rules: { "fixture/broken": true },
      });
      const partiallyValidPlugin: RulePlugin = {
        ...plugin,
        formatRules: [
          ...plugin.formatRules!,
          {
            id: "broken",
            description: "A rule whose prompt cannot be prepared.",
            scope: "file",
            buildPrompt: () => {
              throw new Error("Cannot prepare this rule.");
            },
          },
        ],
      };
      const ai = bridge(formatReply());

      const execution = await executeFormat(
        { cwd: root, check },
        { fixture: partiallyValidPlugin },
        ai,
      );

      expect(execution.exitCode).toBe(2);
      expect(execution.result.errors).toEqual([
        expect.objectContaining({ code: "RULE_PROMPT_FAILED", ruleIds: ["fixture/broken"] }),
      ]);
      expect(ai.run).toHaveBeenCalledTimes(1);
      if (check) {
        expect(execution.result.wouldChangeFiles).toEqual(["src/sample.any"]);
        expect(execution.result.changedFiles).toEqual([]);
        expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(original);
      } else {
        expect(execution.result.changedFiles).toEqual(["src/sample.any"]);
        expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(replacement);
      }
    },
  );

  test("passes ordered rule references with complete readable details and disposes them", async () => {
    const root = await project("format", {
      rules: { "fixture/second": true, "fixture/first": true },
    });
    const orderedPlugin: RulePlugin = {
      namespace: "fixture",
      formatRules: ["first", "second"].map((id) => ({
        id,
        description: id,
        scope: "file",
        buildPrompt: () => ({
          applicability: `Apply ${id} to the fixture.`,
          transformation: `Detailed transformation for ${id}.`,
          constraints: [`Preserve ${id} behavior.`],
        }),
      })),
    };
    let resourcesDirectory: string | undefined;
    const ai: AiBridge = {
      id: "read-details",
      async run(input) {
        resourcesDirectory = input.ruleResources.directory;
        const metadata = JSON.parse(input.prompt.split("\n\n").at(-1)!) as {
          rules: RuleReference[];
        };
        expect(metadata.rules.map(({ ruleId }) => ruleId)).toEqual([
          "fixture/second",
          "fixture/first",
        ]);
        expect(input.prompt).toContain("Later rules take precedence");
        expect(input.prompt).not.toContain("Detailed transformation");
        for (const [index, file] of input.ruleResources.files.entries()) {
          const detail = JSON.parse(
            await readFile(join(input.ruleResources.directory, file.detailsPath), "utf8"),
          );
          expect(metadata.rules[index]).toEqual({
            ruleId: file.ruleId,
            scope: file.scope,
            applicability: file.applicability,
            detailsPath: file.detailsPath,
          });
          expect(detail.ruleId).toBe(file.ruleId);
          expect(detail.instructions.transformation).toContain("Detailed transformation");
          expect(detail.instructions.constraints).toHaveLength(1);
        }
        return {
          completedRuleIds: metadata.rules.map(({ ruleId }) => ruleId),
          skippedRules: [],
          changes: [],
          warnings: [],
          errors: [],
        };
      },
    };

    const execution = await executeFormat({ cwd: root }, { fixture: orderedPlugin }, ai);
    expect(execution.exitCode).toBe(0);
    expect(resourcesDirectory).toBeDefined();
    await expect(access(resourcesDirectory!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["rejection", "timeout", "abort", "invalid-response"] as const)(
    "disposes rule resources after an adapter %s without writing files",
    async (failure) => {
      const root = await project("format", { ai: { adapter: "codex", timeoutMs: 25 } });
      const controller = new AbortController();
      let resourcesDirectory: string | undefined;
      const ai: AiBridge = {
        id: "failing",
        async run(input: BridgeInput) {
          resourcesDirectory = input.ruleResources.directory;
          await access(resourcesDirectory);
          if (failure === "rejection") {
            throw new Error("Adapter failed while reading rule details.");
          }
          if (failure === "invalid-response") {
            return { changes: [] };
          }
          if (failure === "abort") {
            controller.abort();
            return formatReply();
          }
          return new Promise<never>((_resolve, reject) => {
            input.signal.addEventListener("abort", () => reject(new Error("Request stopped.")), {
              once: true,
            });
          });
        },
      };

      const execution = await executeFormat(
        { cwd: root, signal: controller.signal },
        { fixture: plugin },
        ai,
      );
      expect(execution.exitCode).toBe(failure === "abort" ? 130 : 2);
      expect(execution.result.errors.length).toBeGreaterThan(0);
      expect(execution.result.changedFiles).toEqual([]);
      expect(resourcesDirectory).toBeDefined();
      await expect(access(resourcesDirectory!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(original);
    },
  );

  test("returns confirmed inapplicable rules without treating them as errors", async () => {
    const root = await project("format");
    const skippedRules = [{ ruleId: "fixture/format", reason: "No applicable branch exists." }];
    const execution = await executeFormat(
      { cwd: root },
      { fixture: plugin },
      bridge({ ...formatReply(), completedRuleIds: [], skippedRules, changes: [] }),
    );
    expect(execution.exitCode).toBe(0);
    expect(execution.result.skippedRules).toEqual(skippedRules);
    expect(execution.result.errors).toEqual([]);
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(original);
  });

  test("does not apply changes when reading rule details failed", async () => {
    const root = await project("format");
    const execution = await executeFormat(
      { cwd: root },
      { fixture: plugin },
      bridge({
        ...formatReply(),
        completedRuleIds: [],
        errors: [
          {
            code: "RULE_RESOURCE_READ_FAILED",
            message: "The rule details could not be read.",
            ruleIds: ["fixture/format"],
          },
        ],
      }),
    );
    expect(execution.exitCode).toBe(2);
    expect(execution.result.errors).toContainEqual(
      expect.objectContaining({ code: "RULE_RESOURCE_READ_FAILED" }),
    );
    expect(execution.result.changedFiles).toEqual([]);
    expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(original);
  });

  test.each(["create", "move", "warning"] as const)(
    "rejects a resource-directory %s even when all project paths are selected",
    async (operation) => {
      const root = await project("format", { files: ["**/*"] });
      let internalPath: string | undefined;
      const ai: AiBridge = {
        id: "internal-path",
        async run(input) {
          const resourceDirectory = input.ruleResources.files[0]!.detailsPath.split("/")[0]!;
          internalPath = `${resourceDirectory}/unexpected.any`;
          const changes: FileChange[] = [];
          const warnings: FormatWarning[] = [];
          if (operation === "create") {
            changes.push({
              op: "create",
              path: internalPath,
              content: "This must not become project source.",
              ruleIds: ["fixture/format"],
            });
          } else if (operation === "move") {
            changes.push({
              op: "move",
              from: "src/sample.any",
              to: internalPath,
              ruleIds: ["fixture/format"],
            });
          } else {
            changes.push(...formatReply().changes);
            warnings.push({
              code: "UNCERTAIN",
              ruleIds: ["fixture/format"],
              message: "This is an internal rule resource, not source evidence.",
              paths: [internalPath],
            });
          }
          return { ...formatReply(), changes, warnings };
        },
      };

      const execution = await executeFormat({ cwd: root }, { fixture: plugin }, ai);
      expect(execution.exitCode).toBe(2);
      expect(execution.result.errors.length).toBeGreaterThan(0);
      expect(execution.result.changedFiles).toEqual([]);
      expect(internalPath).toBeDefined();
      await expect(access(join(root, internalPath!))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, "src/sample.any"), "utf8")).toBe(original);
    },
  );

  test.each([
    { name: "plugin registration only", config: { rules: undefined } },
    {
      name: "a disabled preset rule",
      config: { preset: ["fixture/all"], rules: { "fixture/format": false } },
    },
  ])("does not prepare rule resources for $name", async ({ config }) => {
    const root = await project("format", config);
    await mkdir(join(root, "node_modules"));
    const buildPrompt = vi.fn(plugin.formatRules![0]!.buildPrompt);
    const observedPlugin: RulePlugin = {
      ...plugin,
      formatRules: [{ ...plugin.formatRules![0]!, buildPrompt }],
    };
    const ai = bridge(formatReply());

    const execution = await executeFormat({ cwd: root }, { fixture: observedPlugin }, ai);

    expect(execution.exitCode).toBe(0);
    expect(execution.result.errors).toEqual([]);
    expect(execution.result.skippedRules).toEqual([]);
    expect(buildPrompt).not.toHaveBeenCalled();
    expect(ai.run).not.toHaveBeenCalled();
    await expect(access(join(root, "node_modules/.cache"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("validates explicit target paths even when no rules are active", async () => {
    const root = await project("format", { rules: {} });
    const ai = bridge(formatReply());

    const rejected = await executeFormat(
      { cwd: root, paths: ["missing.any"] },
      { fixture: plugin },
      ai,
    );
    const allowed = await executeFormat(
      { cwd: root, paths: ["missing.any"], noErrorOnUnmatchedPattern: true },
      { fixture: plugin },
      ai,
    );

    expect(rejected.exitCode).toBe(2);
    expect(rejected.result.errors).toContainEqual(
      expect.objectContaining({ code: "TARGET_UNMATCHED" }),
    );
    expect(allowed.exitCode).toBe(0);
    expect(allowed.result.errors).toEqual([]);
    expect(ai.run).not.toHaveBeenCalled();
  });

  test("reports actual formatting stages in check mode", async () => {
    const root = await project("format");
    const onProgress = vi.fn();
    const run = await executeFormat(
      { cwd: root, check: true, onProgress },
      { fixture: plugin },
      {
        id: "progress",
        run: async (input) => {
          input.onProgress?.("Inspecting src/sample.any");
          return formatReply();
        },
      },
    );
    expect(run.exitCode).toBe(1);
    expect(onProgress.mock.calls.map(([stage]) => stage)).toEqual([
      "Preparing rules",
      "Selecting files",
      "Formatting files with AI",
      "Inspecting src/sample.any",
      "Checking changes",
    ]);
  });

  test("timeout stops a request without retry or source writes", async () => {
    const root = await project("format", { ai: { adapter: "codex", timeoutMs: 25 } });
    const runSpy = vi.fn(() => new Promise<unknown>(() => {}));
    const result = await executeFormat(
      { cwd: root },
      { fixture: plugin },
      { id: "slow", run: runSpy },
    );
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
    const noOp = await executeFormat(
      { cwd: root },
      { fixture: plugin },
      bridge({ ...formatReply(), changes: [] }),
    );
    expect(noOp.exitCode).toBe(0);
    expect((noOp.result as FormatResult).changedFiles).toEqual([]);

    await mkdir(join(root, "node_modules"));
    await writeFile(
      join(root, ".aqfmtrc.jsonc"),
      JSON.stringify({ plugins: ["unavailable-plugin"], preset: ["unavailable/all"] }),
    );
    const undone = await executeFormat({ cwd: root, undo: true }, { fixture: plugin });
    expect(undone.exitCode).toBe(0);
    expect((undone.result as FormatResult).restoredFiles).toEqual(["src/sample.any"]);
    expect(await readFile(join(root, "src", "sample.any"), "utf8")).toBe(original);
    await expect(access(join(root, "node_modules/.cache"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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
