import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config/load";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  test("uses independent defaults when no configuration exists", async () => {
    const root = await project();
    const lint = await loadConfig("lint", { cwd: root });
    const format = await loadConfig("format", { cwd: root });

    expect(lint).toMatchObject({
      tool: "lint",
      projectRoot: root,
      configPath: undefined,
      files: ["**/*"],
      ignore: [],
      plugins: [],
      rules: [],
      ai: { adapter: "codex", options: {}, timeoutMs: 600_000 },
    });
    expect(format).toMatchObject({ tool: "format", configPath: undefined, rules: [] });
  });

  test("finds the nearest tool-specific JSONC configuration", async () => {
    const root = await project();
    const nested = join(root, "packages", "app", "src");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, ".aqlintrc.jsonc"), `{ "rules": [{ "rule": "root/rule" }] }`);
    await writeFile(join(root, ".aqfmtrc.jsonc"), `{ "rules": [{ "rule": "fmt/root" }] }`);
    await writeFile(join(root, "packages", "app", ".aqlintrc.jsonc"), `{
      // JSONC comments and trailing commas are supported.
      "files": ["packages/app/**",],
      "plugins": ["rules-package"],
      "rules": [{ "rule": "nested/check", "severity": "warn" }],
    }`);

    const lint = await loadConfig("lint", { cwd: nested });
    const format = await loadConfig("format", { cwd: nested });

    expect(lint.configPath).toBe(join(root, "packages", "app", ".aqlintrc.jsonc"));
    expect(lint.projectRoot).toBe(join(root, "packages", "app"));
    expect(format.projectRoot).toBe(root);
    expect(lint.rules).toEqual([{ rule: "nested/check", severity: "warn" }]);
    expect(format.configPath).toBe(join(root, ".aqfmtrc.jsonc"));
    expect(format.rules[0]?.rule).toBe("fmt/root");
  });

  test("searches past a nested Git root for the nearest config", async () => {
    const root = await project();
    const nested = join(root, "nested");
    await mkdir(join(nested, ".git"), { recursive: true });
    await writeFile(join(root, ".aqlintrc.jsonc"), "{}");
    const loaded = await loadConfig("lint", { cwd: nested });
    expect(loaded.projectRoot).toBe(root);
    expect(loaded.configPath).toBe(join(root, ".aqlintrc.jsonc"));
  });

  test("uses the working directory when no config exists in a Git repository", async () => {
    const root = await project();
    const nested = join(root, "nested");
    await mkdir(nested);
    expect((await loadConfig("lint", { cwd: nested })).projectRoot).toBe(nested);
  });

  test("an explicit config sets the project root and pattern base", async () => {
    const root = await project();
    const configDirectory = join(root, "config");
    await mkdir(configDirectory);
    const path = join(configDirectory, "custom.jsonc");
    await writeFile(path, `{ "ignore": ["/generated/**"] }`);

    const loaded = await loadConfig("lint", { cwd: root, configPath: "config/custom.jsonc" });

    expect(loaded.projectRoot).toBe(configDirectory);
    expect(loaded.configPath).toBe(path);
    expect(loaded.configDirectory).toBe(configDirectory);
    expect(loaded.ignore).toEqual(["/generated/**"]);
  });

  test.each([
    [`{ "unknown": true }`, "unknown field"],
    [`{ "ai": { "timeoutMs": 0 } }`, "positive integer"],
    [`{ "rules": [{ "rule": "a/r" }, { "rule": "a/r" }] }`, "duplicate"],
    [`{ "rules": [{ "rule": "missing-slash" }] }`, "namespace/rule-id"],
    [`{ "files": ["../outside/**"] }`, "base directory"],
  ])("rejects invalid configuration: %s", async (contents, message) => {
    const root = await project();
    await writeFile(join(root, ".aqlintrc.jsonc"), contents);
    await expect(loadConfig("lint", { cwd: root })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining(message),
    });
  });

  test("rejects lint-only severity in formatter configuration", async () => {
    const root = await project();
    await writeFile(join(root, ".aqfmtrc.jsonc"), `{ "rules": [{ "rule": "a/r", "severity": "off" }] }`);
    await expect(loadConfig("format", { cwd: root })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  test("reports JSONC syntax locations", async () => {
    const root = await project();
    await writeFile(join(root, ".aqlintrc.jsonc"), `{\n  "rules": [\n}`);
    await expect(loadConfig("lint", { cwd: root })).rejects.toMatchObject({
      code: "CONFIG_PARSE_FAILED",
      message: expect.stringMatching(/\.aqlintrc\.jsonc:\d+:\d+:/),
    });
  });
});

const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "aquarius-config-"));
  directories.push(root);
  await mkdir(join(root, ".git"));
  return root;
};
