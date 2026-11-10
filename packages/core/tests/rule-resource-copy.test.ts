import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { codexBridge, copyCodexRuleResources, createCodexSnapshot } from "../src/ai/codex";
import { prepareRuleResources } from "../src/ai/rule-resources";
import type { RuleResourceFile, RuleResources } from "../src/ai/types";

const directories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "aquarius-rule-copy-test-"));
  directories.push(directory);
  return directory;
};

const ruleFile = async (directory: string): Promise<RuleResourceFile> => {
  const detailsPath = ".aquarius-rules-fixture/lint-example.json";
  const contents = JSON.stringify({
    ruleId: "fixture/example",
    scope: "file",
    instructions: {
      applicability: "Files declaring a value.",
      criteria: "A declared value must be named.",
      evidenceRequirements: ["The declaration."],
    },
  });
  await mkdir(dirname(join(directory, detailsPath)), { recursive: true });
  await writeFile(join(directory, detailsPath), contents);
  return {
    ruleId: "fixture/example",
    scope: "file",
    applicability: "Files declaring a value.",
    detailsPath,
    contentHash: createHash("sha256").update(contents).digest("hex"),
  };
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Codex rule resources", () => {
  test("copies real prepared resources using their logical paths and only the selected rules", async () => {
    const project = await temporaryDirectory();
    const view = await temporaryDirectory();
    const firstInstructions = {
      applicability: "Functions accepting borrowed input.",
      criteria: "Do not mutate borrowed input.",
      evidenceRequirements: ["The input contract and mutation."],
      exceptions: ["Explicit ownership transfer."],
      procedure: ["Read callers and aliases."],
    };
    const secondInstructions = {
      applicability: "Modules exposing an entry point.",
      criteria: "Use the public entry point.",
      evidenceRequirements: ["The public API contract."],
    };
    const prepared = await prepareRuleResources({
      projectRoot: project,
      tool: "lint",
      rules: [
        { id: "fixture/first", scope: "file", instructions: firstInstructions },
        { id: "fixture/second", scope: "module", instructions: secondInstructions },
      ],
    });
    try {
      const [first, second] = prepared.resources.files;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      const selected = { ...prepared.resources, files: [second!] };

      await copyCodexRuleResources(selected, view, new AbortController().signal);

      const actual = JSON.parse(await readFile(join(view, second!.detailsPath), "utf8"));
      expect(actual).toEqual({
        ruleId: "fixture/second",
        scope: "module",
        instructions: secondInstructions,
      });
      await expect(readFile(join(view, first!.detailsPath))).rejects.toThrow();
      await prepared.dispose();
      expect(JSON.parse(await readFile(join(view, second!.detailsPath), "utf8"))).toEqual(actual);
    } finally {
      await prepared.dispose();
    }
  });

  test("copies only listed details without changing project files or source resources", async () => {
    const source = await temporaryDirectory();
    const view = await temporaryDirectory();
    const file = await ruleFile(source);
    const original = await readFile(join(source, file.detailsPath));
    await writeFile(join(source, ".aquarius-rules-fixture", "unlisted.json"), "not requested");
    await writeFile(join(view, "source.ts"), "export const answer = 42;\n");

    await expect(
      copyCodexRuleResources(
        { directory: source, files: [file] },
        view,
        new AbortController().signal,
      ),
    ).resolves.toEqual([file.detailsPath]);

    expect(await readFile(join(view, file.detailsPath))).toEqual(original);
    expect(await readFile(join(source, file.detailsPath))).toEqual(original);
    expect(await readFile(join(view, "source.ts"), "utf8")).toBe("export const answer = 42;\n");
    await expect(
      readFile(join(view, ".aquarius-rules-fixture", "unlisted.json")),
    ).rejects.toThrow();
    if (process.platform !== "win32") {
      expect((await stat(join(view, file.detailsPath))).mode & 0o222).toBe(0);
    }
  });

  test.each([
    "../outside.json",
    "/outside.json",
    ".aquarius-rules-fixture/../outside.json",
    ".aquarius-rules-fixture\\lint-example.json",
    ".aquarius-rules-fixture/invalid:name.json",
    "source/rule.json",
  ])("rejects invalid logical paths before writing: %s", async (detailsPath) => {
    const source = await temporaryDirectory();
    const view = await temporaryDirectory();
    const file = await ruleFile(source);

    await expect(
      copyCodexRuleResources(
        { directory: source, files: [{ ...file, detailsPath }] },
        view,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(await readdir(view)).toEqual([]);
  });

  test("rejects duplicate paths and duplicate rule IDs", async () => {
    const source = await temporaryDirectory();
    const view = await temporaryDirectory();
    const file = await ruleFile(source);
    for (const duplicate of [
      { ...file, ruleId: "fixture/other" },
      { ...file, detailsPath: ".aquarius-rules-fixture/another.json" },
    ]) {
      await expect(
        copyCodexRuleResources(
          { directory: source, files: [file, duplicate] },
          view,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "CODEX_RULE_RESOURCES_INVALID" });
    }
    expect(await readdir(view)).toEqual([]);
  });

  test("rejects modified detail content", async () => {
    const source = await temporaryDirectory();
    const view = await temporaryDirectory();
    const file = await ruleFile(source);
    await writeFile(join(source, file.detailsPath), "changed after preparation");

    await expect(
      copyCodexRuleResources(
        { directory: source, files: [file] },
        view,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CODEX_RULE_RESOURCE_CHANGED" });
    expect(await readdir(view)).toEqual([]);
  });

  test("does not follow detail file or resource-directory symlinks", async () => {
    const source = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const view = await temporaryDirectory();
    const file = await ruleFile(source);
    const contents = await readFile(join(source, file.detailsPath));
    await writeFile(join(outside, "external.json"), contents);
    await rm(join(source, file.detailsPath));
    await symlink(join(outside, "external.json"), join(source, file.detailsPath), "file");

    await expect(
      copyCodexRuleResources(
        { directory: source, files: [file] },
        view,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CODEX_READABLE_PATH_UNSUPPORTED" });

    const linkedDirectory = join(outside, "resources");
    await symlink(source, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    await expect(
      copyCodexRuleResources(
        { directory: linkedDirectory, files: [file] },
        view,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CODEX_RULE_RESOURCES_INVALID" });
    expect(await readdir(view)).toEqual([]);
  });

  test("rejects nonregular detail files and missing required resources", async () => {
    const source = await temporaryDirectory();
    const view = await temporaryDirectory();
    const file = await ruleFile(source);
    await rm(join(source, file.detailsPath));
    await mkdir(join(source, file.detailsPath));

    await expect(
      copyCodexRuleResources(
        { directory: source, files: [file] },
        view,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CODEX_READABLE_PATH_UNSUPPORTED" });
    await expect(
      copyCodexRuleResources(
        undefined as unknown as RuleResources,
        view,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CODEX_RULE_RESOURCES_INVALID" });
    expect(await readdir(view)).toEqual([]);
  });

  test("does not overwrite an existing project directory or follow a destination symlink", async () => {
    const source = await temporaryDirectory();
    const view = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const file = await ruleFile(source);
    const rootName = ".aquarius-rules-fixture";
    await mkdir(join(view, rootName));
    await writeFile(join(view, rootName, "owned.txt"), "project-owned");

    await expect(
      copyCodexRuleResources(
        { directory: source, files: [file] },
        view,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CODEX_RULE_RESOURCE_CONFLICT" });
    expect(await readFile(join(view, rootName, "owned.txt"), "utf8")).toBe("project-owned");
    await rm(join(view, rootName), { recursive: true });
    await symlink(outside, join(view, rootName), process.platform === "win32" ? "junction" : "dir");

    await expect(
      copyCodexRuleResources(
        { directory: source, files: [file] },
        view,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CODEX_RULE_RESOURCE_CONFLICT" });
    expect(await readdir(outside)).toEqual([]);
  });

  test("honors cancellation before copying any details", async () => {
    const source = await temporaryDirectory();
    const view = await temporaryDirectory();
    const file = await ruleFile(source);
    const controller = new AbortController();
    controller.abort();

    await expect(
      copyCodexRuleResources({ directory: source, files: [file] }, view, controller.signal),
    ).rejects.toMatchObject({ code: "CODEX_ABORTED" });
    expect(await readdir(view)).toEqual([]);
  });

  test("never copies the persistent cache as project evidence", async () => {
    const project = await temporaryDirectory();
    const view = await temporaryDirectory();
    const cachePath = "node_modules/.cache/aquarius/lint.json";
    await mkdir(dirname(join(project, cachePath)), { recursive: true });
    await writeFile(join(project, cachePath), "cached rule");

    await expect(
      createCodexSnapshot(project, [cachePath], [], view, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CODEX_IGNORE_VIOLATION" });
    expect(await readdir(view)).toEqual([]);
  });

  test("cleans up the bridge snapshot when rule copying fails before process startup", async () => {
    const project = await temporaryDirectory();
    const source = await temporaryDirectory();
    const scratch = await temporaryDirectory();
    const file = await ruleFile(source);
    await writeFile(join(source, file.detailsPath), "changed");
    vi.stubEnv(process.platform === "win32" ? "TEMP" : "TMPDIR", scratch);

    await expect(
      codexBridge.run({
        projectRoot: project,
        readableFiles: [],
        ignore: [],
        prompt: "Read the supplied rule.",
        ruleResources: { directory: source, files: [file] },
        outputSchema: { type: "object" },
        options: { executable: process.execPath },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "CODEX_RULE_RESOURCE_CHANGED" });
    expect(await readdir(scratch)).toEqual([]);
  });
});
