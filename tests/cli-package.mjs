import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect } from "vitest";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} exited with status ${result.status}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result;
}

function pnpmInvocation() {
  const npmExecPath = process.env.npm_execpath;
  if (process.platform !== "win32") {
    return npmExecPath && /pnpm\.(?:c?js|mjs)$/i.test(npmExecPath)
      ? { command: process.execPath, prefix: [npmExecPath] }
      : { command: "pnpm", prefix: [] };
  }

  const home = process.env.PNPM_HOME;
  const shims = home ? [join(home, "bin", "pnpm.cmd"), join(home, "pnpm.cmd")] : [];
  for (const shim of shims) {
    if (!existsSync(shim)) continue;
    const match = /["']%~dp0\\([^"']*pnpm\.exe)["']/i.exec(readFileSync(shim, "utf8"));
    if (!match) continue;
    const executable = resolve(dirname(shim), ...match[1].split("\\"));
    if (existsSync(executable)) return { command: executable, prefix: [] };
  }
  if (npmExecPath && existsSync(npmExecPath) && /pnpm\.(?:c?js|mjs)$/i.test(npmExecPath)) {
    return { command: process.execPath, prefix: [npmExecPath] };
  }
  throw new Error("Cannot locate a native pnpm executable without invoking pnpm.cmd.");
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath && /npm-cli\.js$/i.test(process.env.npm_execpath)
      ? process.env.npm_execpath
      : undefined,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const found = candidates.find(existsSync);
  if (!found) throw new Error("Cannot locate npm-cli.js for direct Node execution.");
  return found;
}

function packagePath(root, name) {
  return join(root, "node_modules", ...name.split("/"));
}

const checkLibraryTypes = (workspaceRoot, installRoot) => {
  const fixture = join(installRoot, "plugin.mts");
  writeFileSync(
    fixture,
    `
import { z } from 'zod';
import type { LintRule, RulePlugin } from '@aqtools/core';
import { defineAdapter, type AdapterExecuteRequest } from '@aqtools/core/adapter';
import suppliedRules from '@aqtools/rules';

const rule: LintRule = {
  id: 'consumer-rule',
  description: 'Check the installed rule-authoring contract.',
  scope: 'file',
  optionsSchema: z.strictObject({ enabled: z.boolean() }),
  buildPrompt: ({ options }) => ({
    applicability: String(options.enabled),
    criteria: 'A consumer-defined rule.',
    evidenceRequirements: ['Source evidence'],
  }),
};
const plugin: RulePlugin = suppliedRules;
const adapter = defineAdapter({
  id: 'consumer-adapter',
  run: async (request: AdapterExecuteRequest) => ({ cwd: request.projectRoot }),
});
export { rule, plugin, adapter };
`,
  );
  run(
    process.execPath,
    [
      join(workspaceRoot, "node_modules", "typescript", "bin", "tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2024",
      "--types",
      "node",
      "--typeRoots",
      join(workspaceRoot, "node_modules", "@types"),
      fixture,
    ],
    { cwd: installRoot },
  );
};

function removeOwnedTemporaryDirectory(directory, prefix) {
  const target = resolve(directory);
  const temporaryRoot = resolve(tmpdir());
  if (dirname(target) !== temporaryRoot || !basename(target).startsWith(prefix)) {
    throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}

function spawnCli(bin, args, cwd) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

export function checkCli(bin, name, version, cwd) {
  expect(readFileSync(bin, "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
  for (const args of [["--help"], ["-h"]]) {
    const result = spawnCli(bin, args, cwd);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`Usage: ${name}`));
    expect(result.stdout).toContain("@aqtools/codex");
    expect(result.stdout).toContain("--with-node-modules");
    expect(result.stdout).not.toContain("--no-ignore");
    expect(result.stderr).toBe("");
  }
  for (const flag of ["--version", "-v"]) {
    const result = spawnCli(bin, [flag], cwd);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(version);
  }

  const missingConfig = runJson(bin, cwd, [], 2);
  expect(missingConfig.errors).toEqual([expect.objectContaining({ code: "CONFIG_NOT_FOUND" })]);

  const config = join(cwd, `.${name}rc.json`);
  const files = ["fixture.js", "node_modules/fixture.js"];
  writeFileSync(config, JSON.stringify({ files }));
  mkdirSync(join(cwd, "node_modules"), { recursive: true });
  for (const file of files) writeFileSync(join(cwd, file), "export const fixture = true;\n");

  const selection = (args) => runJson(bin, cwd, args, 0).fileResults.map(({ path }) => path);
  const noRules = runJson(bin, cwd, [], 0);
  expect(noRules).not.toHaveProperty("ai");
  expect(noRules.fileResults.map(({ path }) => path)).toEqual(["fixture.js"]);
  expect(selection(["--with-node-modules", "**/*.js"])).toEqual(files);
  expect(selection(["--with-node-modules", "**/*.js", "!node_modules/**"])).toEqual(["fixture.js"]);
  expect(selection(["--no-error-on-unmatched-pattern", "definitely-missing-input"])).toEqual([]);

  const missingInput = runJson(bin, cwd, ["definitely-missing-input"], 2);
  expect(missingInput.errors).toEqual([expect.objectContaining({ code: "TARGET_UNMATCHED" })]);
  const skipped = spawnCli(bin, [], cwd);
  expect(skipped.status, skipped.stderr).toBe(0);
  expect(skipped.stdout + skipped.stderr).not.toContain("AI:");

  for (const args of [["--unknown"], ["--no-ignore"], ["--format", "yaml"]]) {
    const result = spawnCli(bin, args, cwd);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).not.toBe("");
    expect(result.stdout).toBe("");
  }

  const lint = name === "aqlint";
  const ruleId = "fixture/review";
  writeFileSync(
    join(cwd, "plugin.mjs"),
    `
export default {
  namespace: 'fixture',
  ${lint ? "lintRules" : "formatRules"}: [{
    id: 'review',
    description: 'Review the fixture.',
    scope: 'file',
    buildPrompt: () => ({
      applicability: 'Always applies.',
      ${
        lint
          ? 'criteria: "Review selected files.", evidenceRequirements: []'
          : 'transformation: "Review selected files.", constraints: []'
      }
    }),
  }],
};
`,
  );
  writeFileSync(
    join(cwd, "adapter.mjs"),
    `
export default {
  id: 'fixture',
  run: async ({ onProgress }) => {
    onProgress?.('Reviewing fixture');
    return {
      completedRuleIds: ['fixture/review'],
      fileResults: [],
      skippedRules: [],
      errors: [],
      ${lint ? "diagnostics: []" : "changes: [], warnings: []"}
    };
  },
};
`,
  );
  const fixtureConfig = {
    files: ["fixture.js"],
    plugins: ["./plugin.mjs"],
    rules: { [ruleId]: lint ? "error" : true },
  };
  writeFileSync(config, JSON.stringify({ ...fixtureConfig, ai: { adapter: "./adapter.mjs" } }));
  const incomplete = runJson(bin, cwd, [], 2);
  expect(incomplete.errors.some(({ code }) => code.startsWith("INCOMPLETE_FILE_"))).toBe(true);
  expect(incomplete.ai).toEqual({ adapter: "fixture" });

  const ai = {
    adapter: "fixture",
    model: "fixture-model",
    details: { serviceTier: "fast", "reasoning.effort": "medium" },
  };
  writeFileSync(
    join(cwd, "adapter.mjs"),
    `
export default {
  id: 'fixture',
  createSession() {
    return {
      info: ${JSON.stringify(ai)},
      async execute() {
        return {
          completedRuleIds: ['fixture/review'],
          fileResults: [{ path: 'fixture.js', status: 'completed', reason: '' }],
          skippedRules: [],
          errors: [],
          ${lint ? "diagnostics: []" : "changes: [], warnings: []"}
        };
      },
      dispose() {},
    };
  },
};
`,
  );
  const completed = runJson(bin, cwd, [], 0);
  expect(completed.ai).toEqual(ai);
  const finished = spawnCli(bin, [], cwd);
  expect(finished.status, finished.stderr).toBe(0);
  expect(finished.stdout).toMatch(/AI:\s+fixture · fixture-model \(fast, effort=medium\)/u);
  const progress = finished.stderr.split("\n");
  const aiLine = "AI: fixture · fixture-model (fast, effort=medium)";
  const analysisHeading = lint ? "Current diagnostics: 0" : "Formatting review complete";
  expect(progress.indexOf(aiLine)).toBeGreaterThanOrEqual(0);
  expect(progress.indexOf(aiLine)).toBeLessThan(
    progress.findIndex((line) => line.includes(lint ? "Analyzing files" : "Planning changes")),
  );
  expect(progress[progress.lastIndexOf(analysisHeading) - 1]).toBe(aiLine);

  writeFileSync(config, JSON.stringify({ ...fixtureConfig, ai: { adapter: "codex" } }));
  const missingAdapter = runJson(bin, cwd, [], 2);
  expect(missingAdapter.errors).toEqual([
    expect.objectContaining({ code: "AI_ADAPTER_LOAD_FAILED" }),
  ]);
}

function runJson(bin, cwd, args, exitCode) {
  const result = spawnCli(bin, ["--format", "json", ...args], cwd);
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

export function checkBuiltCli(packageDir) {
  const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const prefix = `${metadata.name}-cli-`;
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    checkCli(
      join(packageDir, metadata.bin[metadata.name]),
      metadata.name,
      metadata.version,
      directory,
    );
  } finally {
    removeOwnedTemporaryDirectory(directory, prefix);
  }
}

function packPackage(packageDir, destination) {
  const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const filename = `${metadata.name.replace(/^@/, "").replaceAll("/", "-")}-${metadata.version}.tgz`;
  const tarball = join(destination, filename);
  const pnpm = pnpmInvocation();
  const result = run(pnpm.command, [...pnpm.prefix, "pack", "--json", "--out", tarball], {
    cwd: packageDir,
  });
  const report = JSON.parse(result.stdout);
  const item = Array.isArray(report) ? report[0] : report;
  const files = (item.files ?? []).map((file) => (typeof file === "string" ? file : file.path));
  expect(existsSync(tarball)).toBe(true);
  expect(files).toContain(
    metadata.bin ? Object.values(metadata.bin)[0].replace(/^\.\//, "") : "dist/index.mjs",
  );
  expect(
    files.every(
      (file) =>
        !file.startsWith("src/") && !file.startsWith("tests/") && !file.includes("node_modules/"),
    ),
  ).toBe(true);
  return { metadata, tarball };
}

export function checkPackedCli(workspaceRoot, packageDir) {
  const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  expect(metadata.engines.node).toBe(">=24.11.0");
  expect(metadata.publishConfig.access).toBe("public");
  const prefix = `aquarius-${metadata.name}-package-`;
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    const packs = join(directory, "packs");
    const install = join(directory, "install");
    const project = join(directory, "project");
    mkdirSync(packs);
    mkdirSync(install);
    mkdirSync(project);

    const core = packPackage(join(workspaceRoot, "packages", "core"), packs);
    const rules = packPackage(join(workspaceRoot, "packages", "rules"), packs);
    const adapter = packPackage(join(workspaceRoot, "packages", "codex"), packs);
    const cli = packPackage(packageDir, packs);
    run(
      process.execPath,
      [
        npmCliPath(),
        "install",
        "--prefix",
        install,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        core.tarball,
        rules.tarball,
        adapter.tarball,
        cli.tarball,
      ],
      { cwd: install },
    );
    checkLibraryTypes(workspaceRoot, install);

    for (const packed of [core, rules, adapter, cli]) {
      const installed = JSON.parse(
        readFileSync(join(packagePath(install, packed.metadata.name), "package.json"), "utf8"),
      );
      expect(installed.version).toBe(packed.metadata.version);
    }
    const installedCliDir = packagePath(install, metadata.name);
    const installedCli = JSON.parse(readFileSync(join(installedCliDir, "package.json"), "utf8"));
    expect(Object.values(installedCli.dependencies)).not.toContain(
      expect.stringContaining("workspace:"),
    );
    expect(installedCli.dependencies).toMatchObject({
      "@aqtools/core": core.metadata.version,
    });
    expect(installedCli.dependencies).not.toHaveProperty("@aqtools/rules");
    expect(installedCli.dependencies).not.toHaveProperty("@aqtools/codex");
    const bin = join(installedCliDir, installedCli.bin[metadata.name]);
    expect(existsSync(join(install, "node_modules", ".bin", metadata.name))).toBe(true);
    checkCli(bin, metadata.name, metadata.version, project);

    const configFilename = `.${metadata.name}rc.json`;
    const config = JSON.stringify({ plugins: ["@aqtools/rules"], files: ["fixture.js"] });
    writeFileSync(join(project, configFilename), config);
    const missingPlugin = runJson(bin, project, [], 2);
    expect(missingPlugin.errors).toEqual([expect.objectContaining({ code: "PLUGIN_LOAD_FAILED" })]);

    const localProject = join(install, "project");
    mkdirSync(localProject);
    writeFileSync(join(localProject, configFilename), config);
    writeFileSync(join(localProject, "fixture.js"), "export const fixture = true;\n");
    expect(runJson(bin, localProject, [], 0).errors).toEqual([]);

    copyFileSync(join(project, "plugin.mjs"), join(localProject, "plugin.mjs"));
    const installedAdapterConfig = {
      files: ["fixture.js"],
      plugins: ["./plugin.mjs"],
      rules: { "fixture/review": metadata.name === "aqlint" ? "error" : true },
      ai: { adapter: "@aqtools/codex", options: { ephemeral: "invalid" } },
    };
    writeFileSync(join(localProject, configFilename), JSON.stringify(installedAdapterConfig));
    expect(runJson(bin, localProject, [], 2).errors).toEqual([
      expect.objectContaining({ code: "AI_ADAPTER_OPTIONS_INVALID" }),
    ]);
  } finally {
    removeOwnedTemporaryDirectory(directory, prefix);
  }
}
