import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, test } from "vitest";

const cliPath = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const extractionArgs = ["extract-config", "--plugin", "./plugin.mjs", "--adapter", "./adapter.mjs"];
const rcName = ".aqlintrc.json";
let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(realpathSync(tmpdir()), "aqlint-extract-"));
  await mkdir(join(cwd, "extract-config"));
  await Promise.all([
    writeFile(join(cwd, "extract-config", "example.js"), "export const value = 1;\n"),
    writeFile(join(cwd, "other.js"), "export const other = 2;\n"),
    writeFile(join(cwd, rcName), JSON.stringify({ files: ["**/*.js"] })),
    writeFile(
      join(cwd, "plugin.mjs"),
      `
const instructions = { applicability: "All code", criteria: "Follow the rule", evidenceRequirements: [] };
export default {
  namespace: "fixture",
  lintRules: [
    { id: "standard", description: "Keep a common pattern", scope: "file", buildPrompt: () => instructions },
    { id: "contract", description: "Keep a contract", scope: "file", buildPrompt: () => instructions },
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
      { ruleId: "fixture/standard", status: "observed", settingJson: JSON.stringify("warn"), reason: "Common convention", mixed: false, observations: null },
      { ruleId: "fixture/contract", status: "observed", settingJson: JSON.stringify("error"), reason: "Required invariant", mixed: false, observations: null },
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

test("writes structured extraction JSON with settings, report and saved path", async () => {
  const result = run(
    ...extractionArgs,
    "-f",
    "json",
    "--output",
    "result.json",
    "./extract-config",
  );

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const stdout = JSON.parse(result.stdout);
  const path = join(cwd, "result.json");
  expect(stdout).toMatchObject({
    config: {
      files: ["**/*.js"],
      plugins: ["./plugin.mjs"],
      ai: { adapter: "./adapter.mjs" },
      rules: { "fixture/standard": "warn", "fixture/contract": "error" },
    },
    report: {
      sourceRoot: join(cwd, "extract-config"),
      totalDiscovered: 1,
      sampledCount: 1,
      ai: { adapter: "fixture" },
      outputPath: path,
      findings: expect.arrayContaining([
        expect.objectContaining({
          ruleId: "fixture/contract",
          setting: "error",
          reason: "Required invariant",
        }),
      ]),
      warnings: [],
    },
  });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(stdout.config);
});

test.each([["./extract-config"], ["--", "extract-config"]])(
  "treats escaped extract-config invocation as a lint target (%j)",
  (...targetArgs) => {
    const result = run("--format=json", ...targetArgs);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      diagnostics: [],
      fileResults: [{ path: "extract-config/example.js", status: "skipped" }],
    });
  },
);

test("uses only the first positional argument for routing and recognizes option values", () => {
  const normal = run("--format=json", "other.js", "extract-config");
  expect(normal.status, normal.stderr).toBe(0);
  expect(JSON.parse(normal.stdout)).toMatchObject({
    summary: { totalFiles: 2 },
  });

  const top = run("-c", "extract-config", "--help");
  expect(top.status).toBe(0);
  expect(top.stdout).toContain("Usage: aqlint [options] [PATH...]");
  expect(top.stdout).toContain("aqlint extract-config [options] [PATH...]");

  const extract = run("-c", rcName, "extract-config", "--help");
  expect(extract.status).toBe(0);
  expect(extract.stdout).toContain("Usage: aqlint extract-config");
  expect(extract.stdout).toContain("--ai-options");
  expect(extract.stdout).toContain("--merge");
});

test.each(["--version", "-v"])("keeps %s at the top level before extract-config", (option) => {
  const version = run(option);
  const result = run(option, "extract-config");

  expect(version.status, version.stderr).toBe(0);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(version.stdout);
  expect(result.stderr).toBe("");
});

test("returns exit 130 after SIGINT interrupts an adapter request", async () => {
  const adapter = join(cwd, "adapter.mjs");
  await writeFile(
    adapter,
    `export default { id: "fixture", run(request) {
      request.onProgress?.("Waiting for interrupt");
      return new Promise(() => {});
    } };`,
  );

  const child = spawn(process.execPath, [cliPath, ...extractionArgs, "./extract-config"], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let interrupted = false;
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    if (!interrupted && stderr.includes("Waiting for interrupt")) {
      interrupted = true;
      child.kill("SIGINT");
    }
  });
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    expect(status, stderr).toBe(130);
  } finally {
    clearTimeout(timeout);
  }
});
