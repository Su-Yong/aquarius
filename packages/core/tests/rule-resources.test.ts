import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  buildSnapshotEnvironmentPrompt,
  createReadonlySnapshot,
  writeRuleResources,
} from "../src/adapter";
import { buildRuleResources } from "../src/adapter/rule-resources";
import type { PreparedRule } from "../src/rules/types";

const directories: string[] = [];
const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "aquarius-resources-test-"));
  directories.push(root);
  return root;
};

const lintRule = (criteria = "Report mutations."): PreparedRule => ({
  id: "test/no-mutation",
  scope: "file",
  instructions: {
    applicability: "Functions that accept borrowed input.",
    criteria,
    evidenceRequirements: ["Show the mutation."],
  },
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("builds runtime resources in memory with per-run paths and content hashes", () => {
  const [first] = buildRuleResources("lint", [lintRule()]);
  const [second] = buildRuleResources("lint", [lintRule("Follow the call chain.")]);

  expect(first).toBeDefined();
  expect(first!.detailsPath).toMatch(/^\.aquarius-rules-[a-f0-9-]+\/lint-[a-f0-9]{64}\.json$/u);
  expect(first!.detailsPath).not.toBe(second!.detailsPath);
  expect(first!.contentHash).toBe(createHash("sha256").update(first!.content).digest("hex"));
  expect(JSON.parse(first!.content)).toEqual({
    ruleId: lintRule().id,
    scope: lintRule().scope,
    instructions: lintRule().instructions,
  });
  expect(JSON.parse(second!.content).instructions.criteria).toBe("Follow the call chain.");
});

test("rejects invalid and duplicate rules before creating resources", () => {
  const bad = lintRule("");
  expect(() => buildRuleResources("lint", [bad])).toThrow(
    expect.objectContaining({ code: "INVALID_RULE_RESOURCE" }),
  );
  expect(() => buildRuleResources("lint", [lintRule(), lintRule()])).toThrow(
    expect.objectContaining({ code: "INVALID_RULE_RESOURCE" }),
  );
});

test("writes the selected resources once into the snapshot with file mode 0400", async () => {
  const viewRoot = await project();
  const resource = buildRuleResources("lint", [lintRule()])[0]!;
  const output = join(viewRoot, resource.detailsPath);

  await expect(writeRuleResources([resource], viewRoot)).resolves.toEqual([resource.detailsPath]);
  expect(await readFile(output, "utf8")).toBe(resource.content);
  if (process.platform !== "win32") {
    expect((await stat(output)).mode & 0o777).toBe(0o400);
  }
  await expect(writeRuleResources([resource], viewRoot)).rejects.toMatchObject({
    code: "RULE_RESOURCE_CONFLICT",
  });
  expect(await readFile(output, "utf8")).toBe(resource.content);
});

test("rejects traversal, duplicate names, and changed content before writing to the snapshot", async () => {
  const viewRoot = await project();
  const resource = buildRuleResources("lint", [lintRule()])[0]!;
  for (const invalid of [
    { ...resource, detailsPath: "../outside.json" },
    { ...resource, detailsPath: ".aquarius-rules-test/../outside.json" },
    { ...resource, ruleId: "test/other" },
  ]) {
    await expect(writeRuleResources([resource, invalid], viewRoot)).rejects.toMatchObject({
      code: "INVALID_RULE_RESOURCE",
    });
  }
  await expect(
    writeRuleResources([{ ...resource, content: "changed" }], viewRoot),
  ).rejects.toMatchObject({ code: "RULE_RESOURCE_CHANGED" });
  expect(await readdir(viewRoot)).toEqual([]);
});

test("rejects a rule-directory symlink without modifying its target", async () => {
  const viewRoot = await project();
  const outside = await project();
  const resource = buildRuleResources("lint", [lintRule()])[0]!;
  await symlink(outside, dirname(join(viewRoot, resource.detailsPath)), "junction");

  await expect(writeRuleResources([resource], viewRoot)).rejects.toMatchObject({
    code: "RULE_RESOURCE_CONFLICT",
  });
  expect(await readdir(outside)).toEqual([]);
});

test("copies only selected regular files into the read-only snapshot", async () => {
  const root = await project();
  const viewRoot = await project();
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/main.ts"), "export const value = 42;", { mode: 0o644 });
  await writeFile(join(root, "private"), "omit");
  await expect(createReadonlySnapshot(root, ["src/main.ts"], viewRoot)).resolves.toEqual([
    "src/main.ts",
  ]);
  expect(await readdir(viewRoot)).toEqual(["src"]);
  expect(await readFile(join(viewRoot, "src/main.ts"), "utf8")).toBe("export const value = 42;");
  if (process.platform !== "win32") {
    expect((await stat(join(viewRoot, "src/main.ts"))).mode & 0o777).toBe(0o444);
  }
});

test("rejects source symlinks, destination symlinks, and cancellation", async () => {
  const root = await project();
  const viewRoot = await project();
  const outside = await project();
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/main.ts"), "project");
  await writeFile(join(outside, "private"), "omit");
  await symlink(join(outside, "private"), join(root, "link"), "file");
  await symlink(outside, join(viewRoot, "src"), "junction");

  await expect(createReadonlySnapshot(root, ["link"], viewRoot)).rejects.toMatchObject({
    code: "FILE_PATH_UNSUPPORTED",
  });
  await expect(createReadonlySnapshot(root, ["src/main.ts"], viewRoot)).rejects.toMatchObject({
    code: "SNAPSHOT_CONFLICT",
  });
  await expect(
    createReadonlySnapshot(root, ["src/main.ts"], viewRoot, AbortSignal.abort()),
  ).rejects.toMatchObject({ code: "AI_ABORTED" });
  await expect(writeRuleResources([], viewRoot, AbortSignal.abort())).rejects.toMatchObject({
    code: "AI_ABORTED",
  });
  expect(await readdir(outside)).toEqual(["private"]);
});

test("adds local read-only instructions around the tool's task", () => {
  const prompt = buildSnapshotEnvironmentPrompt("Review src/main.ts.");
  expect(prompt).toContain("read-only snapshot");
  expect(prompt).toContain("nl -ba");
  expect(prompt.endsWith("Review src/main.ts.")).toBe(true);
});
