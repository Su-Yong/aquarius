import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writeRuleResources } from "@aqtools/core/adapter";
import { codexAdapter, codexOptionsSchema } from "../src/index";
import { ruleResource } from "./fixtures";

const directories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "aquarius-rule-copy-test-"));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("writes only the selected detail files at their logical paths without modifying project files", async () => {
  const view = await temporaryDirectory();
  const file = ruleResource();
  await writeFile(join(view, "source.ts"), "export const answer = 42;\n");

  await expect(writeRuleResources([file], view)).resolves.toEqual([file.detailsPath]);

  expect(await readFile(join(view, file.detailsPath), "utf8")).toBe(file.content);
  expect(await readFile(join(view, "source.ts"), "utf8")).toBe("export const answer = 42;\n");
  if (process.platform !== "win32") {
    expect((await stat(join(view, file.detailsPath))).mode & 0o777).toBe(0o400);
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
  const view = await temporaryDirectory();

  await expect(
    writeRuleResources([{ ...ruleResource(), detailsPath }], view),
  ).rejects.toMatchObject({
    code: "INVALID_RULE_RESOURCE",
  });
  expect(await readdir(view)).toEqual([]);
});

test("rejects duplicate paths, duplicate rule IDs and modified detail content", async () => {
  const view = await temporaryDirectory();
  const file = ruleResource();
  for (const duplicate of [
    { ...file, ruleId: "fixture/other" },
    { ...file, detailsPath: `.aquarius-rules-other/lint-${file.contentHash}.json` },
  ]) {
    await expect(writeRuleResources([file, duplicate], view)).rejects.toMatchObject({
      code: "INVALID_RULE_RESOURCE",
    });
  }
  await expect(writeRuleResources([{ ...file, content: "changed" }], view)).rejects.toMatchObject({
    code: "RULE_RESOURCE_CHANGED",
  });
  expect(await readdir(view)).toEqual([]);
});

test("does not overwrite an existing project directory or follow a destination symlink", async () => {
  const view = await temporaryDirectory();
  const outside = await temporaryDirectory();
  const file = ruleResource();
  const prefix = join(view, file.detailsPath.split("/")[0]!);
  await mkdir(prefix);
  await writeFile(join(prefix, "owned.txt"), "project-owned");

  await expect(writeRuleResources([file], view)).rejects.toMatchObject({
    code: "RULE_RESOURCE_CONFLICT",
  });
  expect(await readFile(join(prefix, "owned.txt"), "utf8")).toBe("project-owned");
  await rm(prefix, { recursive: true });
  await symlink(outside, prefix, process.platform === "win32" ? "junction" : "dir");

  await expect(writeRuleResources([file], view)).rejects.toMatchObject({
    code: "RULE_RESOURCE_CONFLICT",
  });
  expect(await readdir(outside)).toEqual([]);
});

test("honors cancellation before writing any details", async () => {
  const view = await temporaryDirectory();
  const controller = new AbortController();
  controller.abort();

  await expect(writeRuleResources([ruleResource()], view, controller.signal)).rejects.toMatchObject(
    {
      code: "AI_ABORTED",
    },
  );
  expect(await readdir(view)).toEqual([]);
});

test("cleans up the session snapshot when rule writing fails before process startup", async () => {
  const project = await temporaryDirectory();
  const scratch = await temporaryDirectory();
  vi.stubEnv(process.platform === "win32" ? "TEMP" : "TMPDIR", scratch);

  await expect(
    codexAdapter.createSession({
      projectRoot: project,
      readableFiles: [],
      ruleResources: [{ ...ruleResource(), content: "changed" }],
      options: codexOptionsSchema.parse({ executable: process.execPath }),
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "CODEX_RULE_RESOURCE_CHANGED" });
  expect(await readdir(scratch)).toEqual([]);
});
