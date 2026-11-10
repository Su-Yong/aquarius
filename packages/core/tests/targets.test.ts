import { afterEach, describe, expect, test } from "vitest";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config/load";
import { selectTargets } from "../src/files/targets";
import { createCodexSnapshot } from "../src/ai/codex";
import type { LoadedConfig } from "../src/internal";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test.each(["lint", "format"] as const)(
  "uses the config root inside an ignored outer directory for %s",
  async (tool) => {
    const outer = await baseProject("aquarius-nested-root-");
    const root = join(outer, "demo", "before");
    await mkdir(root, { recursive: true });
    await writeFile(join(outer, ".gitignore"), "demo/\n");
    await writeFile(
      join(root, tool === "lint" ? ".aqlintrc.jsonc" : ".aqfmtrc.jsonc"),
      '{ "files": ["src/**"] }',
    );
    await file(root, "src/example.txt");
    await file(outer, "outside.txt");
    const config = await loadConfig(tool, { cwd: root });
    const policy = await selectTargets(config, { paths: ["."] });
    expect(policy.projectRoot).toBe(root);
    expect(policy.targets).toEqual(["src/example.txt"]);
    expect(policy.readableFiles).not.toContain("outside.txt");
  },
);

test.each(["lint", "format"] as const)(
  "defaults to the explicit config root when cwd is outside for %s",
  async (tool) => {
    const outer = await baseProject("aquarius-explicit-root-");
    const root = join(outer, "config");
    await file(root, "src/example.txt");
    await writeFile(join(root, "custom.jsonc"), '{ "files": ["src/**"] }');
    const config = await loadConfig(tool, { cwd: outer, configPath: "config/custom.jsonc" });
    const policy = await selectTargets(config);
    expect(policy.targets).toEqual(["src/example.txt"]);
    await expect(selectTargets(config, { paths: ["."] })).rejects.toMatchObject({
      code: "TARGET_PATH_OUTSIDE_ROOT",
    });
  },
);

describe("selectTargets lint policy", () => {
  test("distinguishes explicit files from directory discovery and hard config ignores", async () => {
    const root = await lintProject();
    const config = loaded(root, "lint", { ignore: ["generated/**"] });

    const policy = await selectTargets(config, { paths: ["."] });

    expect(policy.targets).toEqual(
      expect.arrayContaining([
        "src/good.any",
        "nested/keep.tmp",
        "node_modules/dependency.any",
        ".svn/source.any",
        ".hidden.any",
      ]),
    );
    expect(policy.targets).not.toEqual(
      expect.arrayContaining([
        "ignored.any",
        "nested/drop.tmp",
        "generated/hidden.any",
        "eslint.any",
        "bundle.min.js",
      ]),
    );
    expect(policy.readableFiles).toEqual(
      expect.arrayContaining([
        "ignored.any",
        "eslint.any",
        "bundle.min.js",
        "node_modules/dependency.any",
      ]),
    );
    expect(policy.readableFiles).toContain("generated/hidden.any");
    expect(policy.readableFiles).not.toContain(".svn/source.any");
    expect(policy.isIgnored("generated/future.any")).toBe(false);
    expect(policy.canWrite("src/future.any")).toBe(true);
    expect(policy.canWrite("ignored.any")).toBe(false);
    expect(policy.canWrite("generated/future.any")).toBe(false);
    expect(policy.canWrite("bundle-min.js")).toBe(false);

    const explicit = await selectTargets(config, { paths: ["ignored.any"] });
    expect(explicit.targets).toEqual(["ignored.any"]);
    expect(explicit.canWrite("ignored.any")).toBe(true);
    expect(explicit.canWrite("other.any")).toBe(false);
  });

  test("supports eslint ignore controls without disabling config or git ignores", async () => {
    const root = await lintProject();
    const config = loaded(root, "lint", { ignore: ["generated/**"] });
    await writeFile(join(root, "custom.ignore"), "custom.any\n");
    await file(root, "custom.any");

    await expect(selectTargets(config, { paths: ["eslint.any"] })).rejects.toMatchObject({
      code: "TARGET_UNMATCHED",
    });
    await expect(
      selectTargets(config, { paths: ["custom.any"], ignorePaths: ["custom.ignore"] }),
    ).rejects.toMatchObject({ code: "TARGET_UNMATCHED" });
    const noIgnore = await selectTargets(config, { paths: ["."], noIgnore: true });
    expect(noIgnore.targets).toContain("eslint.any");
    expect(noIgnore.targets).not.toContain("ignored.any");
    expect(noIgnore.targets).not.toContain("generated/hidden.any");

    const pattern = await selectTargets(config, { paths: ["."], ignorePatterns: ["src/**"] });
    expect(pattern.targets).not.toContain("src/good.any");
  });

  test("anchors config ignore patterns at the config directory", async () => {
    const root = await lintProject();
    await file(root, "ignored/root.any");
    await file(root, "config/ignored/config.any");
    const config = loaded(root, "lint", {
      configDirectory: join(root, "config"),
      ignore: ["/ignored/**"],
    });

    const policy = await selectTargets(config, { paths: ["."] });
    expect(policy.targets).toContain("ignored/root.any");
    expect(policy.targets).not.toContain("config/ignored/config.any");
    expect(policy.isIgnored("ignored/root.any")).toBe(false);
    expect(policy.isIgnored("config/ignored/config.any")).toBe(false);
    expect(policy.readableFiles).toContain("config/ignored/config.any");
    expect(policy.canWrite("config/ignored/config.any")).toBe(false);
    expect(policy.ignoreRules).toEqual([]);
  });

  test("rejects paths outside the root and symbolic links", async () => {
    const root = await lintProject();
    const config = loaded(root, "lint");
    await expect(selectTargets(config, { paths: ["../outside.any"] })).rejects.toMatchObject({
      code: "TARGET_PATH_OUTSIDE_ROOT",
    });

    const outside = await mkdtemp(join(tmpdir(), "aquarius-outside-"));
    directories.push(outside);
    await writeFile(join(outside, "secret.any"), "secret");
    await symlink(join(outside, "secret.any"), join(root, "linked.any"), "file");
    await expect(selectTargets(config, { paths: ["linked.any"] })).rejects.toMatchObject({
      code: "TARGET_SYMLINK_UNSUPPORTED",
    });
    const policy = await selectTargets(config, { paths: ["."], noErrorOnUnmatchedPattern: true });
    expect(policy.readableFiles).not.toContain("linked.any");
    expect(policy.canWrite("linked.any")).toBe(false);
  });
});

describe("selectTargets format policy", () => {
  test("applies formatter ignores and defaults, including to explicit files", async () => {
    const root = await formatProject();
    const config = loaded(root, "format");
    const policy = await selectTargets(config, { paths: ["."] });

    expect(policy.targets).toContain("src/good.txt");
    expect(policy.targets).not.toEqual(
      expect.arrayContaining([
        "ignored.txt",
        "prettier.txt",
        "info.txt",
        "node_modules/package/file.txt",
        "package-lock.json",
        ".svn/internal.txt",
      ]),
    );
    expect(policy.readableFiles).toEqual(
      expect.arrayContaining([
        "ignored.txt",
        "prettier.txt",
        "info.txt",
        "node_modules/package/file.txt",
        "package-lock.json",
      ]),
    );
    expect(policy.readableFiles).not.toContain(".svn/internal.txt");
    await expect(selectTargets(config, { paths: ["prettier.txt"] })).rejects.toMatchObject({
      code: "TARGET_UNMATCHED",
    });
    await expect(selectTargets(config, { paths: ["package-lock.json"] })).rejects.toMatchObject({
      code: "TARGET_UNMATCHED",
    });

    const explicitGitignored = await selectTargets(config, { paths: ["ignored.txt"] });
    expect(explicitGitignored.targets).toEqual(["ignored.txt"]);
  });

  test("supports node_modules, globs, exclusions, and unmatched policy", async () => {
    const root = await formatProject();
    const config = loaded(root, "format");

    const withModules = await selectTargets(config, { paths: ["."], withNodeModules: true });
    expect(withModules.targets).toContain("node_modules/package/file.txt");

    const globbed = await selectTargets(config, { paths: ["**/*.txt", "!src/excluded.txt"] });
    expect(globbed.targets).toContain("src/good.txt");
    expect(globbed.targets).not.toContain("src/excluded.txt");

    const empty = await selectTargets(config, {
      paths: ["missing/**/*.txt"],
      noErrorOnUnmatchedPattern: true,
    });
    expect(empty.targets).toEqual([]);
  });

  test("evaluates future write paths against the complete selected scope", async () => {
    const root = await formatProject();
    const config = loaded(root, "format", {
      files: ["src/**", "future-ignored/**"],
      ignore: ["generated/**"],
    });
    const policy = await selectTargets(config, { paths: ["."] });

    expect(policy.canWrite("src/new.txt")).toBe(true);
    expect(policy.canWrite("other/new.txt")).toBe(false);
    expect(policy.canWrite("future-ignored/new.txt")).toBe(false);
    expect(policy.canWrite("src/generated/new.txt")).toBe(true);
    expect(policy.canWrite("generated/new.txt")).toBe(false);
    expect(policy.canWrite("src/ignored-future.txt")).toBe(true);
  });
});

test.each(["lint", "format"] as const)(
  "keeps targets narrow while copying project context outside file and ignore patterns for %s",
  async (tool) => {
    const root = await realpath(await baseProject("aquarius-read-scope-"));
    const matchingFiles = [
      "packages/a/main.ts",
      "packages/b/context.ts",
      "packages/generated/keep.ts",
    ];
    const contextFiles = [
      "packages/a/package.json",
      "packages/generated/drop.ts",
      "packages/ignored.ts",
      "demo/example.ts",
      "docs/spec.md",
      "node_modules/dependency/index.d.ts",
      "package.json",
    ];
    const internalFiles = [
      ".git/config",
      ".svn/internal.txt",
      "node_modules/.cache/aquarius/lint-rule.json",
    ];
    const readableFiles = [...matchingFiles, ...contextFiles].sort();
    for (const path of [...readableFiles, ...internalFiles]) {
      await file(root, path);
    }
    const config = loaded(root, tool, {
      files: ["packages/**/*.ts", "!packages/generated/**", "packages/generated/keep.ts"],
      ignore: ["packages/ignored.ts"],
    });
    const policy = await selectTargets(config, {
      paths: ["packages/a"],
      noIgnore: true,
      withNodeModules: true,
    });

    expect(policy.targets).toEqual(["packages/a/main.ts"]);
    expect(policy.readableFiles).toEqual(readableFiles);
    expect(policy.ignoreRules).toEqual([]);
    expect(policy.canWrite("packages/a/main.ts")).toBe(true);
    for (const path of contextFiles) {
      expect(policy.isIgnored(path)).toBe(false);
      expect(policy.canWrite(path)).toBe(false);
    }
    expect(policy.isIgnored("packages/b/context.ts")).toBe(false);
    expect(policy.canWrite("packages/b/context.ts")).toBe(false);
    expect(policy.isIgnored("../outside.ts")).toBe(true);
    expect(policy.canWrite("../outside.ts")).toBe(false);
    for (const path of internalFiles) {
      expect(policy.readableFiles).not.toContain(path);
      expect(policy.isIgnored(path)).toBe(true);
      expect(policy.canWrite(path)).toBe(false);
    }

    const view = await baseProject("aquarius-read-scope-view-");
    await createCodexSnapshot(
      root,
      policy.readableFiles,
      policy.ignoreRules,
      view,
      new AbortController().signal,
    );
    for (const path of readableFiles) {
      expect(await readFile(join(view, path), "utf8")).toBe(path);
    }
    for (const path of internalFiles) {
      await expect(access(join(view, path))).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

test.each(["lint", "format"] as const)(
  "always excludes Aquarius caches while preserving dependency context for %s",
  async (tool) => {
    const root = await baseProject("aquarius-cache-targets-");
    const cache = "node_modules/.cache/aquarius/lint-rule.json";
    const nestedCache = "packages/child/node_modules/.cache/aquarius/format-rule.json";
    const dependency = "node_modules/example/index.js";
    const otherCache = "node_modules/.cache/another-tool/data.json";
    await file(root, cache);
    await file(root, nestedCache);
    await file(root, dependency);
    await file(root, otherCache);
    const config = loaded(root, tool);
    const options = { paths: ["."], noIgnore: true, withNodeModules: true };

    const policy = await selectTargets(config, options);

    for (const path of [cache, nestedCache]) {
      expect(policy.targets).not.toContain(path);
      expect(policy.readableFiles).not.toContain(path);
      expect(policy.canWrite(path)).toBe(false);
      expect(policy.isIgnored(path)).toBe(true);
      await expect(selectTargets(config, { ...options, paths: [path] })).rejects.toMatchObject({
        code: "TARGET_UNMATCHED",
      });
    }
    expect(policy.targets).toEqual(expect.arrayContaining([dependency, otherCache]));
    expect(policy.readableFiles).toEqual(expect.arrayContaining([dependency, otherCache]));
    expect(policy.canWrite("node_modules/.cache/aquarius/future.json")).toBe(false);
    expect(policy.canWrite(dependency)).toBe(true);
    expect(policy.isIgnored(dependency)).toBe(false);
  },
);

test.each(["lint", "format"] as const)(
  "excludes case aliases of Aquarius caches from every file policy for %s",
  async (tool) => {
    const root = await baseProject("aquarius-cache-alias-targets-");
    const caches = [
      "node_modules/.cache/AQUARIUS/upper-rule.json",
      "packages/child/NODE_MODULES/.CACHE/Aquarius/nested-rule.json",
    ];
    const dependency = "node_modules/example/index.js";
    for (const path of [...caches, dependency]) {
      await file(root, path);
    }
    const config = loaded(root, tool);
    const options = { paths: ["."], noIgnore: true, withNodeModules: true };

    const policy = await selectTargets(config, options);

    expect(policy.targets).toEqual([dependency]);
    expect(policy.readableFiles).toEqual([dependency]);
    for (const path of caches) {
      for (const alias of [path, path.toLowerCase(), path.toUpperCase()]) {
        expect(policy.canWrite(alias)).toBe(false);
        expect(policy.isIgnored(alias)).toBe(true);
      }
      await expect(selectTargets(config, { ...options, paths: [path] })).rejects.toMatchObject({
        code: "TARGET_UNMATCHED",
      });
    }
    expect(policy.canWrite(dependency)).toBe(true);
    expect(policy.isIgnored(dependency)).toBe(false);
  },
);

const lintProject = async (): Promise<string> => {
  const root = await baseProject("aquarius-lint-targets-");
  await writeFile(join(root, ".gitignore"), "ignored.any\n");
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "nested", ".gitignore"), "*.tmp\n!keep.tmp\n");
  await writeFile(join(root, ".eslintignore"), "eslint.any\n");
  for (const path of [
    "src/good.any",
    "ignored.any",
    "eslint.any",
    "nested/drop.tmp",
    "nested/keep.tmp",
    "generated/hidden.any",
    "bundle.min.js",
    "node_modules/dependency.any",
    ".svn/source.any",
    ".hidden.any",
  ])
    await file(root, path);
  return root;
};

const formatProject = async (): Promise<string> => {
  const root = await baseProject("aquarius-format-targets-");
  await writeFile(join(root, ".gitignore"), "ignored.txt\nfuture-ignored/**\n");
  await writeFile(join(root, ".prettierignore"), "prettier.txt\n");
  await mkdir(join(root, ".git", "info"), { recursive: true });
  await writeFile(join(root, ".git", "info", "exclude"), "info.txt\n");
  for (const path of [
    "src/good.txt",
    "src/excluded.txt",
    "ignored.txt",
    "prettier.txt",
    "info.txt",
    "node_modules/package/file.txt",
    "package-lock.json",
    ".svn/internal.txt",
  ])
    await file(root, path);
  return root;
};

const baseProject = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  directories.push(root);
  await mkdir(join(root, ".git"));
  return root;
};

const file = async (root: string, path: string): Promise<void> => {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, path);
};

const loaded = (
  root: string,
  tool: LoadedConfig["tool"],
  overrides: Partial<LoadedConfig> = {},
): LoadedConfig => {
  return {
    tool,
    cwd: root,
    projectRoot: root,
    configDirectory: root,
    files: ["**/*"],
    ignore: [],
    plugins: [],
    preset: [],
    ai: { adapter: "codex", options: {}, timeoutMs: 600_000 },
    rules: {},
    ...overrides,
  };
};
