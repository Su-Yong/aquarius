import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import {
  assembleExtractedConfig,
  preflightExtractedConfigOutput,
  saveExtractedConfig,
  serializeExtractedConfig,
} from "../src/extract/write";
import type { ProjectConfig } from "../src/config/types";

vi.mock(import("node:fs/promises"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});

const directories: string[] = [];
const extracted: ProjectConfig = {
  files: ["src/**"],
  ignore: ["generated/**"],
  plugins: ["shared", "new"],
  preset: ["demo/shared", "demo/new"],
  rules: { "demo/changed": false, "demo/new": true },
  ai: { adapter: "./new-adapter.mjs" },
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("preserves existing scope while using the resolved AI settings without reviving old options", () => {
  const config = assembleExtractedConfig({
    tool: "format",
    existing: {
      files: ["old/**"],
      ignore: [],
      plugins: ["old"],
      preset: ["old/all"],
      rules: { "old/removed": true },
      ai: { adapter: "./old-adapter.mjs", options: { model: "old" }, fileBatchSize: 2 },
    },
    ai: { adapter: "./new-adapter.mjs", fileBatchSize: 2, timeoutMs: 5000 },
    plugins: ["new"],
    preset: [],
    rules: { "new/selected": true },
  });

  expect(config).toStrictEqual({
    files: ["old/**"],
    ignore: [],
    plugins: ["new"],
    preset: [],
    rules: { "new/selected": true },
    ai: {
      adapter: "./new-adapter.mjs",
      fileBatchSize: 2,
      timeoutMs: 5000,
    },
  });
});

test("assembles minimal preview configuration and leaves the working directory untouched", async () => {
  const cwd = await project();
  const config = assembleExtractedConfig({
    tool: "lint",
    ai: { adapter: "./adapter.mjs" },
    plugins: ["demo"],
    preset: [],
    rules: { "demo/check": "warn" },
  });

  expect(config).toStrictEqual({
    ai: { adapter: "./adapter.mjs" },
    plugins: ["demo"],
    preset: [],
    rules: { "demo/check": "warn" },
  });
  expect(await saveExtractedConfig("lint", config, { cwd })).toStrictEqual({ config });
  expect(await readdir(cwd)).toEqual([]);
});

test.each([
  ["format", ".aqfmtrc.json"],
  ["lint", ".aqlintrc.json"],
] as const)("writes the default %s path in the working directory", async (tool, name) => {
  const root = await project();
  const cwd = join(root, "nested");
  const config = { ai: { adapter: "./adapter.mjs" }, plugins: ["demo"], preset: [], rules: {} };
  await mkdir(cwd);
  await writeFile(join(root, name), "{}");

  const result = await saveExtractedConfig(tool, config, { cwd, write: true });

  expect(result).toEqual({ config, outputPath: join(cwd, name) });
  expect(await readFile(join(root, name), "utf8")).toBe("{}");
  const written = await readFile(join(cwd, name), "utf8");
  expect(JSON.parse(written)).toEqual(config);
  expect(written).toBe(`${JSON.stringify(JSON.parse(written), null, 2)}\n`);
});

test("uses --output over --write and requires --force for a plain overwrite", async () => {
  const cwd = await project();
  const options = { cwd, output: "custom.json", write: true };
  const path = join(cwd, "custom.json");
  await writeFile(path, "existing text");

  await expect(saveExtractedConfig("format", extracted, options)).rejects.toMatchObject({
    code: "EXTRACT_CONFIG_OUTPUT_EXISTS",
  });
  expect(await readFile(path, "utf8")).toBe("existing text");

  const result = await saveExtractedConfig("format", extracted, { ...options, force: true });
  expect(result.outputPath).toBe(path);
  expect(await readFile(path, "utf8")).toBe(serializeExtractedConfig(result.config));
  expect(await readdir(cwd)).toEqual(["custom.json"]);
});

test("creates missing output directories only during the save", async () => {
  const cwd = await project();
  const output = join("nested", "dir", "config.json");
  const options = { cwd, output };

  await preflightExtractedConfigOutput("format", options);
  expect(await readdir(cwd)).toEqual([]);

  const result = await saveExtractedConfig("format", extracted, options);
  expect(result.outputPath).toBe(join(cwd, output));
  expect(await readFile(join(cwd, output), "utf8")).toBe(serializeExtractedConfig(result.config));
});

test("reports a file in the output parent chain without exposing the staging path", async () => {
  const cwd = await project();
  const output = join("existing-file", "dir", "config.json");
  const options = { cwd, output };
  await writeFile(join(cwd, "existing-file"), "original text");

  const invalidOutput = {
    code: "EXTRACT_CONFIG_OUTPUT_INVALID",
    message: expect.stringContaining(join(cwd, output)),
  };
  await expect(preflightExtractedConfigOutput("format", options)).rejects.toMatchObject(
    invalidOutput,
  );
  const save = saveExtractedConfig("format", extracted, options);
  await expect(save).rejects.toMatchObject(invalidOutput);
  await expect(save).rejects.not.toThrow(".tmp");
  expect(await readFile(join(cwd, "existing-file"), "utf8")).toBe("original text");
});

test("rechecks the destination and merge compatibility after preflight", async () => {
  const cwd = await project();
  const output = "config.json";
  const path = join(cwd, output);
  const options = { cwd, output };
  await preflightExtractedConfigOutput("format", options);
  await writeFile(path, "{}");
  await expect(saveExtractedConfig("format", extracted, options)).rejects.toMatchObject({
    code: "EXTRACT_CONFIG_OUTPUT_EXISTS",
  });

  const mergeOptions = { ...options, merge: true };
  await preflightExtractedConfigOutput("format", mergeOptions);
  await writeFile(path, "{");
  await expect(saveExtractedConfig("format", extracted, mergeOptions)).rejects.toMatchObject({
    code: "CONFIG_PARSE_FAILED",
  });
  expect(await readFile(path, "utf8")).toBe("{");
});

test.skipIf(process.platform === "win32")(
  "uses the umask on creation and preserves mode on replacement",
  async () => {
    const cwd = await project();
    const path = join(cwd, ".aqfmtrc.json");
    const options = { cwd, write: true };
    const expectedMode = 0o666 & ~process.umask();

    await saveExtractedConfig("format", extracted, options);
    expect((await stat(path)).mode & 0o777).toBe(expectedMode);

    await chmod(path, 0o640);
    await saveExtractedConfig("format", extracted, { ...options, force: true });
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  },
);

test("merges ordered unions and extracted rule overrides while keeping destination scope and AI", async () => {
  const cwd = await project();
  const output = "custom.json";
  const path = join(cwd, output);
  await writeFile(
    path,
    JSON.stringify({
      files: [],
      plugins: ["old", "shared"],
      preset: ["demo/old", "demo/shared", "demo/old"],
      rules: { "demo/unchanged": true, "demo/changed": { style: "compact" } },
      ai: { adapter: "./old-adapter.mjs", timeoutMs: 15 },
    }),
  );

  const result = await saveExtractedConfig("format", extracted, { cwd, output, merge: true });
  expect(result).toEqual({
    outputPath: path,
    config: {
      files: [],
      plugins: ["old", "shared", "new"],
      preset: ["demo/old", "demo/shared", "demo/new"],
      rules: { "demo/unchanged": true, "demo/changed": false, "demo/new": true },
      ai: { adapter: "./old-adapter.mjs", timeoutMs: 15 },
    },
  });
  expect(await readFile(path, "utf8")).toBe(serializeExtractedConfig(result.config));
});

test("merges observed rules even when a preset supplies them in the extracted configuration", async () => {
  const cwd = await project();
  const output = "custom.json";
  await writeFile(
    join(cwd, output),
    JSON.stringify({
      rules: { "demo/observed": false, "demo/unobserved": true },
    }),
  );

  const result = await saveExtractedConfig(
    "format",
    {
      preset: ["demo/recommended"],
      rules: { "demo/unobserved": false, "demo/other": false },
    },
    {
      cwd,
      output,
      merge: true,
      observedRules: { "demo/observed": true },
    },
  );

  expect(result.config.rules).toEqual({
    "demo/observed": true,
    "demo/unobserved": true,
    "demo/other": false,
  });
});

test("protects JSONC comments, while force allows an explicit overwrite", async () => {
  const cwd = await project();
  const output = "custom.jsonc";
  const path = join(cwd, output);
  const original = "{ // preserve the rationale\n}\n";
  await writeFile(path, original);

  await expect(
    saveExtractedConfig("format", extracted, { cwd, output, merge: true }),
  ).rejects.toMatchObject({
    code: "EXTRACT_CONFIG_JSONC_MERGE",
    message: expect.stringMatching(/--force.*\.json path/),
  });
  expect(await readFile(path, "utf8")).toBe(original);

  const result = await saveExtractedConfig("format", extracted, { cwd, output, force: true });
  expect(await readFile(path, "utf8")).toBe(serializeExtractedConfig(result.config));
});

test("rejects contradictory write modes and invalid merge input without changing the file", async () => {
  const cwd = await project();
  const output = "custom.json";
  const path = join(cwd, output);
  const invalid = '{"rules":{"demo/invalid":"warn"}}';
  await writeFile(path, invalid);

  await expect(
    saveExtractedConfig("format", extracted, { cwd, output, merge: true, force: true }),
  ).rejects.toMatchObject({ code: "EXTRACT_CONFIG_WRITE_MODE" });
  await expect(
    saveExtractedConfig("format", extracted, { cwd, output, merge: true }),
  ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  expect(await readFile(path, "utf8")).toBe(invalid);
  expect(await readdir(cwd)).toEqual([output]);
});

test("publishes just one complete file when default writers race", async () => {
  const cwd = await project();
  const output = "custom.json";
  const results = await Promise.allSettled([
    saveExtractedConfig("format", extracted, { cwd, output }),
    saveExtractedConfig("format", { ...extracted, rules: {} }, { cwd, output }),
  ]);

  const winner = results.find((result) => result.status === "fulfilled");
  expect(winner).toBeDefined();
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "EXTRACT_CONFIG_OUTPUT_EXISTS" },
  });
  expect(await readFile(join(cwd, output), "utf8")).toBe(
    serializeExtractedConfig(winner!.value.config),
  );
  expect(await readdir(cwd)).toEqual([output]);
});

test("retains every successful merge when existing-file writers race", async () => {
  const cwd = await project();
  const output = "custom.json";
  const path = join(cwd, output);
  await writeFile(path, '{"rules":{"demo/existing":true}}');

  const ruleIds = ["demo/first", "demo/second"];
  const results = await Promise.allSettled(
    ruleIds.map((ruleId) =>
      saveExtractedConfig("format", { rules: { [ruleId]: true } }, { cwd, output, merge: true }),
    ),
  );

  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.rules["demo/existing"]).toBe(true);
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") expect(saved.rules[ruleIds[index]]).toBe(true);
    else {
      expect(result.reason).toMatchObject({
        code: expect.stringMatching(/^EXTRACT_CONFIG_OUTPUT_(BUSY|CHANGED)$/),
      });
    }
  }
  expect(await readdir(cwd)).toEqual([output]);
});

test("preserves the write error when pending file cleanup also fails", async () => {
  const cwd = await project();
  const output = "config.json";
  const path = join(cwd, output);
  await writeFile(path, "{}");
  const writeError = new Error("rename failed");
  vi.mocked(rename).mockRejectedValueOnce(writeError);
  vi.mocked(unlink).mockRejectedValueOnce(new Error("pending cleanup failed"));

  await expect(saveExtractedConfig("format", extracted, { cwd, output, force: true })).rejects.toBe(
    writeError,
  );
  expect(await readFile(path, "utf8")).toBe("{}");
});

test("leaves the destination untouched when the save is already cancelled", async () => {
  const cwd = await project();
  await expect(
    saveExtractedConfig("format", extracted, {
      cwd,
      write: true,
      signal: AbortSignal.abort(),
    }),
  ).rejects.toMatchObject({ code: "AI_ABORTED" });
  expect(await readdir(cwd)).toEqual([]);
});

test.skipIf(process.platform === "win32")("rejects a symbolic link destination", async () => {
  const cwd = await project();
  const original = join(cwd, "original.json");
  const output = "custom.json";
  await writeFile(original, "{}");
  await symlink(original, join(cwd, output));

  await expect(
    saveExtractedConfig("format", extracted, { cwd, output, force: true }),
  ).rejects.toMatchObject({ code: "EXTRACT_CONFIG_OUTPUT_INVALID" });
  expect(await readFile(original, "utf8")).toBe("{}");
});

const project = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "aquarius-extract-write-"));
  directories.push(directory);
  return directory;
};
