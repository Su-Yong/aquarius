import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config/load";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("loadConfig", () => {
  test.each(["lint", "format"] as const)("requires a configuration for %s", async (tool) => {
    const root = await project();
    await expect(loadConfig(tool, { cwd: root })).rejects.toMatchObject({
      code: "CONFIG_NOT_FOUND",
    });
    await expect(loadConfig(tool, { cwd: root, configPath: "missing.json" })).rejects.toMatchObject(
      { code: "CONFIG_NOT_FOUND" },
    );
  });

  test.each(["lint", "format"] as const)(
    "sets defaults when a %s config omits AI",
    async (tool) => {
      const root = await project();
      await writeFile(join(root, "settings.jsonc"), "{}");
      const config = await loadConfig(tool, { cwd: root, configPath: "settings.jsonc" });

      expect(config).toMatchObject({
        tool,
        projectRoot: root,
        configPath: join(root, "settings.jsonc"),
        files: ["**/*"],
        ignore: [],
        plugins: [],
        preset: [],
        rules: {},
        ai: { adapter: undefined, options: {}, timeoutMs: 600_000 },
      });
    },
  );

  test.each(["lint", "format"] as const)(
    "loads tool-specific rule settings and ordered repeated presets for %s",
    async (tool) => {
      const root = await project();
      const lintRules = {
        "demo/check": ["warn", { nested: { limit: 3 }, list: [1, 2], nullable: null }],
        "demo/disabled-check": "off",
        "demo/error-check": "error",
      };
      const formatRules = {
        "demo/format": true,
        "demo/disabled-format": false,
        "demo/configured-format": { style: "compact" },
      };
      const input = {
        plugins: ["rules-package", "team-package"],
        preset: ["demo/all", "team/strict", "demo/all"],
        rules: tool === "lint" ? lintRules : formatRules,
      };
      await writeFile(join(root, "settings.jsonc"), JSON.stringify(input));

      const config = await loadConfig(tool, { cwd: root, configPath: "settings.jsonc" });

      expect(config.plugins).toEqual(input.plugins);
      expect(config.preset).toEqual(input.preset);
      expect(config.rules).toEqual(input.rules);

      await writeFile(
        join(root, "settings.jsonc"),
        JSON.stringify({ ...input, rules: { ...lintRules, ...formatRules } }),
      );
      await expect(
        loadConfig(tool, { cwd: root, configPath: "settings.jsonc" }),
      ).rejects.toMatchObject({
        code: "CONFIG_INVALID",
        message: expect.stringContaining("rules"),
      });
    },
  );

  test("loads AI settings without choosing an adapter during configuration", async () => {
    const root = await project();
    await writeFile(
      join(root, ".aqlintrc.json"),
      JSON.stringify({ ai: { options: { model: "example" }, fileBatchSize: 2 } }),
    );
    const config = await loadConfig("lint", { cwd: root });
    expect(config.ai).toEqual({
      adapter: undefined,
      options: { model: "example" },
      fileBatchSize: 2,
      timeoutMs: 600_000,
    });
  });

  test("rejects an invalid adapter specifier if supplied", async () => {
    const root = await project();
    await writeFile(join(root, ".aqlintrc.json"), JSON.stringify({ ai: { adapter: " " } }));
    await expect(loadConfig("lint", { cwd: root })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("ai.adapter"),
    });
  });

  test("retains defaults for an explicitly selected adapter", async () => {
    const root = await project();
    await writeFile(join(root, ".aqlintrc.json"), '{ "ai": { "adapter": "@aquarius/codex" } }');
    const config = await loadConfig("lint", { cwd: root });
    expect(config.ai).toEqual({ adapter: "@aquarius/codex", options: {}, timeoutMs: 600_000 });
  });

  test.each([1, 8, Number.MAX_SAFE_INTEGER])(
    "loads positive integer file batching settings: %s",
    async (value) => {
      const root = await project();
      await writeFile(
        join(root, ".aqlintrc.json"),
        JSON.stringify({
          ai: { adapter: "@aquarius/codex", fileBatchSize: value, maxConcurrency: value },
        }),
      );

      const config = await loadConfig("lint", { cwd: root });

      expect(config.ai).toEqual({
        adapter: "@aquarius/codex",
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
          `{ "ai": { "adapter": "@aquarius/codex", "${field}": ${value} } }`,
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

  test.each([".aqfmtrc.json", ".aqfmtrc.jsonc"])(
    "discovers formatter configuration %s with the existing JSONC parser",
    async (name) => {
      const root = await project();
      await writeFile(join(root, name), '{ /* formatter config */ "files": ["src/**",], }');

      const config = await loadConfig("format", { cwd: root });

      expect(config.configPath).toBe(join(root, name));
      expect(config.files).toEqual(["src/**"]);
    },
  );

  test("prefers formatter JSON unless JSONC is explicitly selected", async () => {
    const root = await project();
    await writeFile(join(root, ".aqfmtrc.json"), '{ "files": ["json/**"] }');
    await writeFile(join(root, ".aqfmtrc.jsonc"), '{ "files": ["jsonc/**"] }');

    const automatic = await loadConfig("format", { cwd: root });
    const explicit = await loadConfig("format", { cwd: root, configPath: ".aqfmtrc.jsonc" });

    expect(automatic.configPath).toBe(join(root, ".aqfmtrc.json"));
    expect(automatic.files).toEqual(["json/**"]);
    expect(explicit.configPath).toBe(join(root, ".aqfmtrc.jsonc"));
    expect(explicit.files).toEqual(["jsonc/**"]);
  });

  test("prefers nearby formatter JSONC over JSON in a parent directory", async () => {
    const root = await project();
    const nested = join(root, "nested");
    await mkdir(nested);
    await writeFile(join(root, ".aqfmtrc.json"), '{ "files": ["parent/**"] }');
    await writeFile(join(nested, ".aqfmtrc.jsonc"), '{ "files": ["child/**"] }');

    const config = await loadConfig("format", { cwd: nested });

    expect(config.configPath).toBe(join(nested, ".aqfmtrc.jsonc"));
    expect(config.projectRoot).toBe(nested);
    expect(config.files).toEqual(["child/**"]);
  });

  test.each([
    ['{ "files": [ }', "CONFIG_PARSE_FAILED"],
    ['{ "unknown": true }', "CONFIG_INVALID"],
  ])("does not fall back from invalid preferred formatter JSON: %s", async (contents, code) => {
    const root = await project();
    await writeFile(join(root, ".aqfmtrc.json"), contents);
    await writeFile(join(root, ".aqfmtrc.jsonc"), "{}");

    await expect(loadConfig("format", { cwd: root })).rejects.toMatchObject({ code });
  });

  test("does not fall back when preferred formatter JSON cannot be read", async () => {
    const root = await project();
    await mkdir(join(root, ".aqfmtrc.json"));
    await writeFile(join(root, ".aqfmtrc.jsonc"), "{}");

    await expect(loadConfig("format", { cwd: root })).rejects.toMatchObject({
      code: "CONFIG_READ_FAILED",
    });
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
