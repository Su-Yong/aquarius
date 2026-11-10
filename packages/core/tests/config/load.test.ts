import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config/load";
import { resolveBridge } from "../../src/ai/bridge";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
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
      preset: [],
      rules: {},
      ai: { adapter: undefined, options: {}, timeoutMs: 600_000 },
    });
    expect(format).toMatchObject({ tool: "format", configPath: undefined, preset: [], rules: {} });
  });

  test.each(["lint", "format"] as const)(
    "loads mixed rule settings and ordered repeated presets for %s",
    async (tool) => {
      const root = await project();
      const input = {
        plugins: ["rules-package", "team-package"],
        preset: ["demo/all", "team/strict", "demo/all"],
        rules: {
          "demo/check": ["warn", { nested: { limit: 3 }, list: [1, 2], nullable: null }],
          "demo/disabled-check": "off",
          "demo/error-check": "error",
          "demo/format": true,
          "demo/disabled-format": false,
          "demo/configured-format": { style: "compact" },
        },
      };
      await writeFile(join(root, "settings.jsonc"), JSON.stringify(input));

      const config = await loadConfig(tool, { cwd: root, configPath: "settings.jsonc" });

      expect(config.plugins).toEqual(input.plugins);
      expect(config.preset).toEqual(input.preset);
      expect(config.rules).toEqual(input.rules);
    },
  );

  test.each(["lint", "format"] as const)(
    "requires an explicit AI adapter before resolving a %s bridge",
    async (tool) => {
      const root = await project();
      const config = await loadConfig(tool, { cwd: root });
      await expect(resolveBridge(config)).rejects.toMatchObject({
        code: "AI_ADAPTER_REQUIRED",
        message: expect.stringContaining("ai.adapter"),
      });
    },
  );

  test.each([{}, { options: { model: "example" } }, { adapter: " " }])(
    "rejects an AI configuration without a usable adapter: %j",
    async (ai) => {
      const root = await project();
      await writeFile(join(root, ".aqlintrc.json"), JSON.stringify({ ai }));
      await expect(loadConfig("lint", { cwd: root })).rejects.toMatchObject({
        code: "CONFIG_INVALID",
        message: expect.stringContaining("ai.adapter"),
      });
    },
  );

  test("retains defaults for an explicitly selected adapter", async () => {
    const root = await project();
    await writeFile(join(root, ".aqlintrc.json"), '{ "ai": { "adapter": "codex" } }');
    const config = await loadConfig("lint", { cwd: root });
    expect(config.ai).toEqual({ adapter: "codex", options: {}, timeoutMs: 600_000 });
    expect((await resolveBridge(config)).id).toBe("codex");
  });

  test.each([1, 8, Number.MAX_SAFE_INTEGER])(
    "loads positive integer file batching settings: %s",
    async (value) => {
      const root = await project();
      await writeFile(
        join(root, ".aqlintrc.json"),
        JSON.stringify({
          ai: { adapter: "codex", fileBatchSize: value, maxConcurrency: value },
        }),
      );

      const config = await loadConfig("lint", { cwd: root });

      expect(config.ai).toEqual({
        adapter: "codex",
        options: {},
        timeoutMs: 600_000,
        fileBatchSize: value,
        maxConcurrency: value,
      });
    },
  );

  test.each(["fileBatchSize", "maxConcurrency"])(
    "rejects invalid ai.%s before execution",
    async (field) => {
      const root = await project();
      const invalidValues = ["0", "-1", "1.5", '"2"', "null", "9007199254740992", "1e309"];

      for (const value of invalidValues) {
        await writeFile(
          join(root, ".aqlintrc.json"),
          `{ "ai": { "adapter": "codex", "${field}": ${value} } }`,
        );

        await expect(loadConfig("lint", { cwd: root })).rejects.toMatchObject({
          code: "CONFIG_INVALID",
          message: expect.stringContaining(`ai.${field}`),
        });
      }
    },
  );

  test.each([".aqlintrc.json", ".aqlintrc.jsonc"])(
    "discovers %s with the existing JSONC parser",
    async (name) => {
      const root = await project();
      await writeFile(join(root, name), '{ /* project config */ "files": ["src/**",], }');

      const config = await loadConfig("lint", { cwd: root });

      expect(config.configPath).toBe(join(root, name));
      expect(config.files).toEqual(["src/**"]);
      expect(config.rules).toEqual({});
    },
  );

  test("prefers JSON in the same directory unless JSONC is explicitly selected", async () => {
    const root = await project();
    await writeFile(join(root, ".aqlintrc.json"), '{ "files": ["json/**"] }');
    await writeFile(join(root, ".aqlintrc.jsonc"), '{ "files": ["jsonc/**"] }');

    const automatic = await loadConfig("lint", { cwd: root });
    const explicit = await loadConfig("lint", { cwd: root, configPath: ".aqlintrc.jsonc" });

    expect(automatic.configPath).toBe(join(root, ".aqlintrc.json"));
    expect(automatic.files).toEqual(["json/**"]);
    expect(explicit.configPath).toBe(join(root, ".aqlintrc.jsonc"));
    expect(explicit.files).toEqual(["jsonc/**"]);
  });

  test("prefers nearby JSONC over JSON in a parent directory", async () => {
    const root = await project();
    const nested = join(root, "nested");
    await mkdir(nested);
    await writeFile(join(root, ".aqlintrc.json"), '{ "files": ["parent/**"] }');
    await writeFile(join(nested, ".aqlintrc.jsonc"), '{ "files": ["child/**"] }');

    const config = await loadConfig("lint", { cwd: nested });

    expect(config.configPath).toBe(join(nested, ".aqlintrc.jsonc"));
    expect(config.projectRoot).toBe(nested);
    expect(config.files).toEqual(["child/**"]);
  });

  test.each([
    ['{ "files": [ }', "CONFIG_PARSE_FAILED"],
    ['{ "unknown": true }', "CONFIG_INVALID"],
  ])("does not fall back from invalid preferred JSON: %s", async (contents, code) => {
    const root = await project();
    await writeFile(join(root, ".aqlintrc.json"), contents);
    await writeFile(join(root, ".aqlintrc.jsonc"), "{}");

    await expect(loadConfig("lint", { cwd: root })).rejects.toMatchObject({ code });
  });

  test("preserves JSONC-only formatter discovery", async () => {
    const root = await project();
    await writeFile(join(root, ".aqfmtrc.json"), '{ "files": ["json/**"] }');
    await writeFile(join(root, ".aqfmtrc.jsonc"), '{ "files": ["jsonc/**"] }');

    const config = await loadConfig("format", { cwd: root });

    expect(config.configPath).toBe(join(root, ".aqfmtrc.jsonc"));
    expect(config.files).toEqual(["jsonc/**"]);
  });

  test("finds the nearest tool-specific JSONC configuration", async () => {
    const root = await project();
    const nested = join(root, "packages", "app", "src");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, ".aqlintrc.jsonc"), `{ "rules": { "root/rule": "error" } }`);
    await writeFile(join(root, ".aqfmtrc.jsonc"), `{ "rules": { "fmt/root": true } }`);
    await writeFile(
      join(root, "packages", "app", ".aqlintrc.jsonc"),
      `{
      // JSONC comments and trailing commas are supported.
      "files": ["packages/app/**",],
      "plugins": ["rules-package"],
      "rules": { "nested/check": "warn" },
    }`,
    );

    const lint = await loadConfig("lint", { cwd: nested });
    const format = await loadConfig("format", { cwd: nested });

    expect(lint.configPath).toBe(join(root, "packages", "app", ".aqlintrc.jsonc"));
    expect(lint.projectRoot).toBe(join(root, "packages", "app"));
    expect(format.projectRoot).toBe(root);
    expect(lint.rules).toEqual({ "nested/check": "warn" });
    expect(format.configPath).toBe(join(root, ".aqfmtrc.jsonc"));
    expect(format.rules).toEqual({ "fmt/root": true });
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
    [`{ "plugins": ["rules-package", "rules-package"] }`, "duplicate"],
    [`{ "rules": { "missing-slash": "warn" } }`, "namespace/rule-id"],
    [`{ "preset": ["missing-slash"] }`, "namespace/preset-name"],
    [`{ "preset": ["demo/"] }`, "namespace/preset-name"],
    [`{ "preset": ["/all"] }`, "namespace/preset-name"],
    [`{ "files": ["../outside/**"] }`, "base directory"],
  ])("rejects invalid configuration: %s", async (contents, message) => {
    const root = await project();
    await writeFile(join(root, ".aqlintrc.jsonc"), contents);
    await expect(loadConfig("lint", { cwd: root })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining(message),
    });
  });

  test.each(["lint", "format"] as const)("rejects legacy rules arrays for %s", async (tool) => {
    const root = await project();
    for (const rules of [[], [{ rule: "demo/check", severity: "warn" }]]) {
      await writeFile(join(root, "settings.jsonc"), JSON.stringify({ rules }));

      await expect(
        loadConfig(tool, { cwd: root, configPath: "settings.jsonc" }),
      ).rejects.toMatchObject({
        code: "CONFIG_INVALID",
        message: expect.stringContaining("rules"),
      });
    }
  });

  test.each(
    [
      null,
      1,
      "on",
      "allow",
      "deny",
      [],
      ["warn"],
      ["warn", null],
      ["warn", []],
      ["warn", true],
      ["warn", {}, {}],
    ].map((setting) => ({ setting })),
  )("rejects invalid rule settings: %j", async ({ setting }) => {
    const root = await project();
    await writeFile(
      join(root, ".aqlintrc.json"),
      JSON.stringify({ rules: { "demo/check": setting } }),
    );

    await expect(loadConfig("lint", { cwd: root })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("rules"),
    });
  });

  test.each(["demo/all", null, [" "], [1]].map((preset) => ({ preset })))(
    "rejects invalid preset inputs: %j",
    async ({ preset }) => {
      const root = await project();
      await writeFile(join(root, ".aqlintrc.json"), JSON.stringify({ preset }));

      await expect(loadConfig("lint", { cwd: root })).rejects.toMatchObject({
        code: "CONFIG_INVALID",
        message: expect.stringContaining("preset"),
      });
    },
  );

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
  const directory = await mkdtemp(join(tmpdir(), "aquarius-config-"));
  const root = await realpath(directory);
  directories.push(root);
  await mkdir(join(root, ".git"));
  return root;
};
