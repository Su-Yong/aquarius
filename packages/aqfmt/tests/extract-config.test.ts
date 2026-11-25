import { spawnSync } from "node:child_process";
import { closeSync, openSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, test } from "vitest";

const cliPath = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const sourceFiles = ["extract-config/example.js", "extract-config/second.js"];
const extractionArgs = ["--plugin", "./plugin.mjs", "--adapter", "./adapter.mjs", "extract-config"];
const rcName = ".aqfmtrc.json";
let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(realpathSync(tmpdir()), "aqfmt-extract-"));
  await mkdir(join(cwd, "extract-config"));
  await Promise.all([
    ...sourceFiles.map((path) => writeFile(join(cwd, path), 'export const value = "example";\n')),
    writeFile(
      join(cwd, "plugin.mjs"),
      `
const instructions = { applicability: "All files", transformation: "Retain style", constraints: [] };
export default {
  namespace: "fixture",
  formatRules: [
    { id: "quotes", description: "Keep quotes", scope: "file", buildPrompt: () => instructions },
    { id: "generators", description: "Format generators", scope: "file", buildPrompt: () => instructions },
  ],
};`,
    ),
    writeFile(
      join(cwd, "adapter.mjs"),
      `
export default {
  id: "fixture",
  run(request) {
    request.onProgress?.("Fixture adapter progress");
    return { verdicts: [
      { ruleId: "fixture/quotes", status: "observed", settingJson: "true", reason: "Most strings use double quotes", mixed: true, observations: "Double quotes occur most often" },
      { ruleId: "fixture/generators", status: "insufficient_evidence", settingJson: null, reason: "No generator declarations", mixed: false, observations: null },
    ] };
  },
};`,
    ),
  ]);
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const run = (...args: string[]) =>
  spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: "utf8" });

test("prints bare config JSON on preview and reports evidence, sampling and progress on stderr", async () => {
  const result = run(...extractionArgs, "--max-files", "1", "./extract-config");

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    plugins: ["./plugin.mjs"],
    ai: { adapter: "./adapter.mjs" },
    preset: [],
    rules: { "fixture/quotes": true },
  });
  expect(result.stderr).toContain("Fixture adapter progress");
  expect(result.stderr).toContain("EXTRACT_FILES_SAMPLED");
  expect(result.stderr).toContain("Most strings use double quotes");
  expect(result.stderr).toContain("mixed style for fixture/quotes");
  expect(result.stderr).toContain("Double quotes occur most often");
  expect(result.stderr).toContain(
    "Insufficient evidence — fixture/generators: No generator declarations",
  );
  await expect(readFile(join(cwd, rcName))).rejects.toMatchObject({ code: "ENOENT" });
});

test("redirects a default text preview to a new rc file", async () => {
  const path = join(cwd, rcName);
  const fd = openSync(path, "w");
  try {
    const result = spawnSync(process.execPath, [cliPath, ...extractionArgs, "./extract-config"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", fd, "pipe"],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Most strings use double quotes");
  } finally {
    closeSync(fd);
  }
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    rules: { "fixture/quotes": true },
  });
});

test("prints the saved path and report to stdout, keeping progress on stderr", async () => {
  const result = run(...extractionArgs, "--write", "--output", "output.json", "./extract-config");

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(`Saved ${join(cwd, "output.json")}`);
  expect(result.stdout).toContain("Most strings use double quotes");
  expect(result.stdout).toContain("Insufficient evidence");
  expect(result.stdout).not.toContain("Fixture adapter progress");
  expect(result.stderr).toContain("Fixture adapter progress");
  expect(result.stderr).not.toContain("Most strings use double quotes");

  const saved = await readFile(join(cwd, "output.json"), "utf8");
  expect(saved).toBe(`${JSON.stringify(JSON.parse(saved), null, 2)}\n`);
  expect(JSON.parse(saved)).toMatchObject({ rules: { "fixture/quotes": true } });
  await expect(readFile(join(cwd, rcName))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([
  ["--ai-options", "[]", "--ai-options must be a JSON object"],
  ["--timeout-ms", "1.5", "--timeout-ms must be a positive integer"],
  ["--max-files", "9007199254740992", "--max-files must be a positive integer"],
  ["--max-concurrency", "0", "--max-concurrency must be a positive integer"],
  ["--format", "html", "--format must be text or json"],
])("returns exit 2 for an invalid %s value", (flag, value, message) => {
  const result = run(...extractionArgs, flag, value);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(message);
});

test("shows the command in top-level help and lists command-specific options", () => {
  const top = run("--help");
  expect(top.status).toBe(0);
  expect(top.stdout).toContain("aqfmt extract-config [options] [PATH...]");
  expect(top.stdout).toContain("--check");

  const extraction = run("extract-config", "--help");
  expect(extraction.status).toBe(0);
  expect(extraction.stdout).toContain("Usage: aqfmt extract-config");
  expect(extraction.stdout).toContain("--plugin");
  expect(extraction.stdout).toContain("--max-concurrency");
  expect(extraction.stdout).not.toContain("--check");
});

test.each([["./extract-config"], ["--", "extract-config"]])(
  "treats escaped extract-config invocation as a format target (%j)",
  async (...targetArgs) => {
    await writeFile(join(cwd, rcName), JSON.stringify({ files: ["**/*.js"] }));
    const result = run("--format=json", "--check", ...targetArgs);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      fileResults: sourceFiles.map((path) => ({ path, status: "skipped" })),
    });
  },
);

test.each([["--check"], ["--file-batch-size", "1"]])(
  "keeps extract-config as a format target after a top-level option (%j)",
  async (...options) => {
    await writeFile(join(cwd, rcName), JSON.stringify({ files: ["**/*.js"] }));
    const result = run("--format=json", ...options, "extract-config");

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      fileResults: sourceFiles.map((path) => ({ path, status: "skipped" })),
    });
  },
);

test("rejects a top-level option after entering the extract-config command", () => {
  const result = run("extract-config", "--check");

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("aqfmt extract-config: Unknown option '--check'");
});
