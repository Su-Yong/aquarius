import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, relative } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { createReadonlySnapshot } from "../src/adapter/snapshot";
import { collectExtractionTargets } from "../src/extract/targets";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("collects cwd, external directories and a single explicit file", async () => {
  const cwd = await temporaryDirectory();
  const external = await temporaryDirectory();
  await writeFixture(cwd, "src/current.ts");
  await writeFixture(external, "src/reference.ts");
  await writeFixture(external, "src/sibling.ts");

  expect(await collectExtractionTargets({ cwd })).toEqual({
    sourceRoot: cwd,
    readableFiles: ["src/current.ts"],
    totalDiscovered: 1,
    sampledCount: 1,
  });
  expect(await collectExtractionTargets({ cwd, paths: [external] })).toMatchObject({
    sourceRoot: external,
    readableFiles: ["src/reference.ts", "src/sibling.ts"],
  });
  const sourceFile = join(external, "src", "reference.ts");
  expect(await collectExtractionTargets({ cwd, paths: [relative(cwd, sourceFile)] })).toMatchObject(
    {
      sourceRoot: dirname(sourceFile),
      readableFiles: ["reference.ts"],
    },
  );
});

test("uses a common root, deduplicates overlapping scopes, and only snapshots selected files", async () => {
  const cwd = await temporaryDirectory();
  const external = await temporaryDirectory();
  const snapshot = await temporaryDirectory();
  await writeFixture(external, "lib/source.ts");
  await writeFixture(external, "test/source.test.ts");
  await writeFixture(external, "outside/source.ts");
  await writeFixture(external, ".gitignore", "/test/ignored.ts\n");
  await writeFixture(external, "test/ignored.ts");

  const { sourceRoot, readableFiles } = await collectExtractionTargets({
    cwd,
    paths: [join(external, "lib"), join(external, "lib/source.ts"), join(external, "test")],
  });

  expect(sourceRoot).toBe(external);
  expect(readableFiles).toEqual(["lib/source.ts", "test/source.test.ts"]);
  expect(await createReadonlySnapshot(sourceRoot, readableFiles, snapshot)).toEqual(readableFiles);
  expect(await readFile(join(snapshot, "test/source.test.ts"), "utf8")).toBe("example\n");
  await expect(stat(join(snapshot, "outside"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("applies source ignores and manual ignores to external paths, including explicit files", async () => {
  const cwd = await temporaryDirectory();
  const external = await temporaryDirectory();
  await writeFixture(cwd, "fixtures/manual.ignore", "/src/manual.ts\n");
  await writeFixture(external, ".gitignore", "*.tmp\n!/src/keep.tmp\n!src/unexclude.ts\n");
  await writeFixture(external, ".git/info/exclude", "src/info.ts\nsrc/unexclude.ts\n");
  await writeFixture(external, "src/nested/.gitignore", "local.ts\n");
  for (const path of [
    "src/info.ts",
    "src/unexclude.ts",
    "src/manual.ts",
    "src/pattern.ts",
    "src/nested/local.ts",
    "src/keep.tmp",
    "src/drop.tmp",
    "src/ok.ts",
    "node_modules/dependency/index.ts",
    ".git/config",
    ".hg/source.ts",
  ]) {
    await writeFixture(external, path);
  }
  const options = {
    cwd,
    paths: [external, join(external, "src/drop.tmp")],
    ignorePaths: ["fixtures/manual.ignore"],
    ignorePatterns: ["/src/pattern.ts"],
  };
  const filtered = await collectExtractionTargets(options);
  expect(filtered.readableFiles).toEqual([
    ".gitignore",
    "src/keep.tmp",
    "src/nested/.gitignore",
    "src/ok.ts",
    "src/unexclude.ts",
  ]);
  expect(
    (await collectExtractionTargets({ ...options, withNodeModules: true })).readableFiles,
  ).toContain("node_modules/dependency/index.ts");

  const gitignoredFile = await collectExtractionTargets({
    cwd,
    paths: [join(external, "src/drop.tmp"), join(external, ".gitignore")],
  });
  expect(gitignoredFile.readableFiles).toEqual([".gitignore"]);
  expect(await collectExtractionTargets({ cwd, paths: [join(external, ".git")] })).toMatchObject({
    readableFiles: [],
  });
  expect(
    await collectExtractionTargets({ cwd, paths: [join(external, "node_modules")] }),
  ).toMatchObject({
    readableFiles: [],
  });
});

test("applies ancestor Git ignores and repository excludes to an external subdirectory", async () => {
  const cwd = await temporaryDirectory();
  const repo = await temporaryDirectory();
  await writeFixture(
    repo,
    ".gitignore",
    "generated/\n/packages/src/anchored/**\nonly-at-root/**\n/packages/src/restored.ts\n",
  );
  await writeFixture(repo, ".git/info/exclude", "secret.ts\n");
  await writeFixture(repo, "packages/.gitignore", "/src/middle.ts\n!/src/restored.ts\n");
  for (const path of [
    "anchored/out.ts",
    "app.ts",
    "generated/out.ts",
    "middle.ts",
    "only-at-root/keep.ts",
    "restored.ts",
    "secret.ts",
  ]) {
    await writeFixture(repo, `packages/src/${path}`);
  }

  const sourceRoot = join(repo, "packages", "src");
  const result = await collectExtractionTargets({ cwd, paths: [sourceRoot] });
  expect(result).toMatchObject({
    sourceRoot,
    readableFiles: ["app.ts", "only-at-root/keep.ts", "restored.ts"],
  });
  expect(
    await collectExtractionTargets({ cwd, paths: [join(sourceRoot, "secret.ts")] }),
  ).toMatchObject({ sourceRoot, readableFiles: [] });
});

test("stops at the nearest Git worktree and uses its shared exclude file", async () => {
  const cwd = await temporaryDirectory();
  await writeFixture(cwd, ".git/info/exclude", "outside.ts\n");
  await writeFixture(cwd, ".gitignore", "hidden-in-outer.ts\n");
  await writeFixture(cwd, "inner/.git", "gitdir: ../metadata/worktrees/inner\n");
  await writeFixture(cwd, "metadata/worktrees/inner/commondir", "../..\n");
  await writeFixture(cwd, "metadata/info/exclude", "shared.ts\n");
  await writeFixture(cwd, "inner/.gitignore", "/src/hidden-in-inner.ts\n");
  for (const path of ["outside.ts", "hidden-in-outer.ts", "hidden-in-inner.ts", "shared.ts"]) {
    await writeFixture(cwd, `inner/src/${path}`);
  }

  const result = await collectExtractionTargets({ cwd, paths: ["inner/src"] });
  expect(result.readableFiles).toEqual(["hidden-in-outer.ts", "outside.ts"]);
});

test("does not inherit ignores from a repository above the home boundary", async () => {
  const cwd = await temporaryDirectory();
  const home = join(cwd, "home");
  await writeFixture(cwd, ".git/info/exclude", "source.ts\n");
  await writeFixture(cwd, "home/project/src/source.ts");
  vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", home);

  const result = await collectExtractionTargets({ cwd, paths: ["home/project/src"] });
  expect(result.readableFiles).toEqual(["source.ts"]);
});

test("rejects missing paths, non-directory components, and explicit symlink components", async () => {
  const cwd = await temporaryDirectory();
  await writeFixture(cwd, "src/regular.ts");
  await symlink(join(cwd, "src"), join(cwd, "linked"), "dir");
  expect((await collectExtractionTargets({ cwd })).readableFiles).toEqual(["src/regular.ts"]);
  await expect(collectExtractionTargets({ cwd, paths: ["missing"] })).rejects.toMatchObject({
    code: "TARGET_PATH_NOT_FOUND",
  });
  await expect(
    collectExtractionTargets({ cwd, paths: ["src/regular.ts/child"] }),
  ).rejects.toMatchObject({
    code: "TARGET_PATH_INVALID",
  });
  for (const path of ["linked", "linked/regular.ts", "linked/../src/regular.ts"]) {
    await expect(collectExtractionTargets({ cwd, paths: [path] })).rejects.toMatchObject({
      code: "TARGET_SYMLINK_UNSUPPORTED",
    });
  }
});

test("rejects single, implicit and multi-path roots at the filesystem root, home or a home ancestor", async () => {
  const cwd = await temporaryDirectory();
  const home = join(cwd, "home");
  await writeFixture(home, "file.ts");
  await writeFixture(home, "repo1/a.ts");
  await mkdir(join(home, "repo2"), { recursive: true });
  await mkdir(join(cwd, "outside"));
  vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", home);

  for (const paths of [
    [parse(cwd).root],
    ["home"],
    ["home/file.ts"],
    [cwd],
    [parse(cwd).root, cwd],
    ["home/repo1", "home/repo2"],
    ["home/repo1", "outside"],
  ]) {
    await expect(collectExtractionTargets({ cwd, paths })).rejects.toMatchObject({
      code: "TARGET_ROOT_UNSAFE",
    });
  }
  await expect(collectExtractionTargets({ cwd: home })).rejects.toMatchObject({
    code: "TARGET_ROOT_UNSAFE",
  });
  for (const path of ["home/repo1", "home/repo1/a.ts"]) {
    expect(await collectExtractionTargets({ cwd, paths: [path] })).toMatchObject({
      sourceRoot: join(home, "repo1"),
      readableFiles: ["a.ts"],
    });
  }
});

test("limits a large tree to 300 files and balances directories and extensions", async () => {
  const cwd = await temporaryDirectory();
  await Promise.all([mkdir(join(cwd, "app")), mkdir(join(cwd, "test"))]);
  const files = Array.from({ length: 90 }, (_, index) => [
    `app/file-${index}.ts`,
    `app/file-${index}.md`,
    `test/file-${index}-first.ts`,
    `test/file-${index}-second.ts`,
  ]).flat();
  for (let index = 0; index < files.length; index += 30) {
    await Promise.all(
      files.slice(index, index + 30).map((path) => writeFile(join(cwd, path), "\n")),
    );
  }

  const result = await collectExtractionTargets({ cwd });
  expect(result).toMatchObject({ totalDiscovered: 360, sampledCount: 300 });
  expect(result.readableFiles).toHaveLength(300);
  expect(result.readableFiles.filter((path) => path.startsWith("test/"))).toHaveLength(150);
  expect(result.readableFiles.filter((path) => path.endsWith(".md"))).toHaveLength(75);

  const limited = await collectExtractionTargets({ cwd, maxFiles: 4 });
  expect(limited.readableFiles).toEqual([
    "app/file-0.md",
    "app/file-0.ts",
    "test/file-0-first.ts",
    "test/file-0-second.ts",
  ]);
  for (const maxFiles of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(collectExtractionTargets({ cwd, maxFiles })).rejects.toMatchObject({
      code: "TARGET_LIMIT_INVALID",
    });
  }
});

const temporaryDirectory = async (): Promise<string> => {
  const cwd = await mkdtemp(join(await realpath(tmpdir()), "aquarius-extraction-"));
  directories.push(cwd);
  return cwd;
};

const writeFixture = async (cwd: string, path: string, content = "example\n"): Promise<void> => {
  const absolute = join(cwd, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
};
