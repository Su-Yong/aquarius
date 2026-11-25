import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";

import { createReadonlySnapshot, writeRuleResources } from "../src/adapter";
import type { AdapterExecuteRequest, SessionAdapter } from "../src/adapter/types";
import { normalizeConfig, validateConfig } from "../src/config/load";
import { extractConfig } from "../src/extract";
import { prepareRules } from "../src/rules/prepare";

const builtInRules = fileURLToPath(import.meta.resolve("@aqtools/rules"));
const directories: string[] = [];
const mocks: symbol[] = [];

const project = async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "aquarius-extract-runner-"));
  directories.push(root);
  return root;
};

afterEach(async () => {
  for (const key of mocks.splice(0)) Reflect.deleteProperty(globalThis, key);
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const adapterFixture = async (cwd: string, adapter: SessionAdapter, filename = "adapter.mjs") => {
  const file = join(cwd, filename);
  const key = Symbol.for(file);
  Reflect.set(globalThis, key, adapter);
  mocks.push(key);
  await writeFile(
    file,
    `export default Reflect.get(globalThis, Symbol.for(${JSON.stringify(file)}));\n`,
  );
};

const formatPluginFixture = (cwd: string, count = 1) =>
  writeFile(
    join(cwd, "plugin.mjs"),
    `
export default {
  namespace: "local",
  formatRules: Array.from({ length: ${count} }, (_, index) => ({
    id: \`rule-\${index + 1}\`,
    description: "Format a fixture",
    scope: "file",
    buildPrompt: () => ({ applicability: "Fixture source", transformation: "Format the fixture", constraints: [] }),
  })),
};
`,
  );

const verdict = (ruleId: string, setting: unknown, observations: string | null = null) => ({
  ruleId,
  settingJson: setting === null ? null : JSON.stringify(setting),
  status: setting === null ? "insufficient_evidence" : "observed",
  reason: "Inspected the matching source paths.",
  mixed: observations !== null,
  observations,
});

test("analyzes the full format catalog once and copies only sampled sources to a real snapshot", async () => {
  const cwd = await project();
  const source = await project();
  const snapshot = await project();
  await mkdir(join(source, "examples"));
  await writeFile(join(source, "examples", "sample.ts"), "items.map(transform);\n");
  await writeFile(join(source, "examples", "other.ts"), "items.map(update);\n");
  await writeFile(join(source, "main.ts"), "export const n = 1;\n");
  const setting = {
    prefer: "imperative",
    overrides: [{ files: ["examples/**"], prefer: "pipeline" }],
  };
  const iterationId = "aquarius/expressions/iteration-style";
  const observations =
    "Imperative loops were more frequent, with functional iterations in examples.";
  const execute = vi.fn((request: AdapterExecuteRequest) => {
    expect(request.prompt).toContain("most frequently observed variant");
    expect(request.outputSchema).toMatchObject({
      required: ["verdicts"],
      additionalProperties: false,
    });
    expect(request.ruleResources).toHaveLength(47);
    return { verdicts: [verdict(iterationId, setting, observations)] };
  });
  const dispose = vi.fn();
  await adapterFixture(cwd, {
    id: "fixture",
    async createSession({ projectRoot, readableFiles, ruleResources, signal }) {
      expect(projectRoot).toBe(source);
      expect(readableFiles).toEqual(["examples/other.ts", "main.ts"]);
      expect(ruleResources.some(({ ruleId }) => ruleId === "aquarius/custom/semantic-policy")).toBe(
        false,
      );
      await createReadonlySnapshot(projectRoot, readableFiles, snapshot, signal);
      await expect(writeRuleResources(ruleResources, snapshot, signal)).resolves.toHaveLength(47);
      const resource = ruleResources.find(
        ({ ruleId }) => ruleId === "aquarius/naming/enforce-convention",
      )!;
      const detail = JSON.parse(await readFile(join(snapshot, resource.detailsPath), "utf8"));
      expect(detail).toMatchObject({
        id: resource.ruleId,
        optionsSchema: { properties: { glossary: {} } },
      });
      return { execute, dispose, info: { adapter: "fixture", model: "test-model" } };
    },
  });

  const result = await extractConfig("format", {
    cwd,
    paths: [source],
    plugins: [builtInRules],
    adapter: "./adapter.mjs",
    maxFiles: 2,
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(result.config).toEqual({
    plugins: [builtInRules],
    preset: [],
    ai: { adapter: "./adapter.mjs" },
    rules: { [iterationId]: setting },
  });
  expect(result.report).toMatchObject({
    sourceRoot: source,
    totalDiscovered: 3,
    sampledCount: 2,
    ai: { model: "test-model" },
    findings: [{ ruleId: iterationId, mixed: true, observations }],
    warnings: [{ code: "EXTRACT_FILES_SAMPLED" }],
  });
  await expect(readFile(join(cwd, ".aqfmtrc.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("selects lint categories, limits parallel analysis, and repairs only invalid verdicts once", async () => {
  const cwd = await project();
  await mkdir(join(cwd, "domain"));
  await mkdir(join(cwd, "application"));
  await writeFile(join(cwd, "domain", "order.ts"), "export const order = {};\n");
  await writeFile(
    join(cwd, "application", "checkout.ts"),
    "import { order } from '../domain/order';\n",
  );

  const layerId = "aquarius/architecture/enforce-layer-direction";
  const badId = "aquarius/architecture/use-public-entry";
  const coreId = "aquarius/domain/model-valid-states";
  const insufficientId = "aquarius/resource/release-on-exit";
  const unselectedId = "aquarius/state/single-owner-for-shared-state";
  const layers = { application: ["application/**"], domain: ["domain/**"] };
  const setting = [
    "error",
    { layers, allowedDependencies: { application: ["domain"], domain: [] } },
  ];
  let active = 0;
  let peakConcurrency = 0;
  const execute = vi.fn(async (request: AdapterExecuteRequest) => {
    if (request.prompt.startsWith("Select rule categories")) {
      expect(request.outputSchema).toMatchObject({ required: ["categories"] });
      expect(request.prompt).toContain("application");
      expect(request.prompt).toContain("aquarius/architecture");
      expect(request.ruleResources).toEqual([]);
      return { categories: ["aquarius/resource", "aquarius/domain", "aquarius/architecture"] };
    }
    if (request.prompt.startsWith("Repair invalid")) {
      expect(request.ruleResources.map(({ ruleId }) => ruleId)).toEqual([badId, layerId]);
      expect(request.prompt).toContain("allowedDependencies.domain");
      expect(request.prompt).not.toContain(coreId);
      expect(request.prompt).not.toContain(unselectedId);
      return { verdicts: [verdict(layerId, setting), verdict(badId, "invalid")] };
    }

    active += 1;
    peakConcurrency = Math.max(peakConcurrency, active);
    await delay(10, undefined, { signal: request.signal });
    active -= 1;

    expect(request.prompt).toContain('Prefer the lint setting "warn"');
    const group = request.ruleResources[0]!.ruleId.split("/")[1];
    expect(
      request.ruleResources.every(({ ruleId }) => ruleId.startsWith(`aquarius/${group}/`)),
    ).toBe(true);
    if (group === "architecture") {
      return {
        verdicts: [
          verdict(layerId, ["error", { layers, allowedDependencies: { application: ["domain"] } }]),
          verdict(badId, "invalid"),
          verdict(unselectedId, "warn"),
        ],
      };
    }
    return {
      verdicts: [group === "domain" ? verdict(coreId, "warn") : verdict(insufficientId, null)],
    };
  });
  const dispose = vi.fn();
  await adapterFixture(cwd, {
    id: "fixture",
    async createSession({ ruleResources }) {
      expect(ruleResources.length).toBeGreaterThan(350);
      const resource = ruleResources.find(({ ruleId }) => ruleId === layerId)!;
      expect(JSON.parse(resource.content)).toMatchObject({
        optionsSchema: { required: ["layers", "allowedDependencies"] },
      });
      const snapshot = await project();
      await expect(writeRuleResources(ruleResources, snapshot)).resolves.toHaveLength(
        ruleResources.length,
      );
      return { execute, dispose };
    },
  });

  const result = await extractConfig("lint", {
    cwd,
    plugins: [builtInRules],
    adapter: "./adapter.mjs",
    maxConcurrency: 2,
  });
  expect(execute).toHaveBeenCalledTimes(5);
  expect(peakConcurrency).toBe(2);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(result.config).toMatchObject({
    preset: [],
    rules: { [layerId]: setting, [coreId]: "warn" },
  });
  expect(Object.keys(result.config.rules!)).toHaveLength(2);
  expect(result.report.findings).toContainEqual(
    expect.objectContaining({ ruleId: insufficientId, status: "insufficient_evidence" }),
  );
  expect(result.report.warnings).toEqual([
    expect.objectContaining({ code: "EXTRACTION_VERDICT_INVALID", ruleIds: [unselectedId] }),
    expect.objectContaining({ ruleIds: [badId] }),
  ]);
  const config = normalizeConfig("lint", cwd, validateConfig("lint", result.config));
  await expect(prepareRules(config)).resolves.toMatchObject({
    errors: [],
    rules: [
      { id: layerId, severity: "error" },
      { id: coreId, severity: "warn" },
    ],
  });
});

test("chunks 75 flat rules into two requests without a category selection call", async () => {
  const cwd = await project();
  await formatPluginFixture(cwd, 75);
  const execute = vi.fn(({ prompt, ruleResources }: AdapterExecuteRequest) => {
    expect(prompt).toMatch(/^Extract Aquarius rule settings/u);
    return { verdicts: ruleResources.map(({ ruleId }) => verdict(ruleId, true)) };
  });
  await adapterFixture(cwd, {
    id: "fixture",
    createSession: () => ({ execute, dispose() {} }),
  });

  const { config, report } = await extractConfig("format", {
    cwd,
    plugins: ["./plugin.mjs"],
    adapter: "./adapter.mjs",
    maxConcurrency: 2,
  });
  expect(execute.mock.calls.map(([request]) => request.ruleResources.length)).toEqual([50, 25]);
  const expectedIds = Array.from({ length: 75 }, (_, index) => `local/rule-${index + 1}`);
  expect(config.rules).toEqual(Object.fromEntries(expectedIds.map((id) => [id, true])));
  expect(report.findings.map(({ ruleId }) => ruleId)).toEqual(expectedIds);
  expect(report.warnings).toEqual([]);
});

test("uses inherited configuration fields and resolves fallback and explicit modules from cwd", async () => {
  const parent = await project();
  const cwd = join(parent, "child");
  await mkdir(cwd);
  const original = {
    files: ["src/*.ts"],
    ignore: ["generated/**"],
    plugins: ["./plugin.mjs"],
    ai: { adapter: "./adapter.mjs", options: { account: "rc" }, timeoutMs: 50, fileBatchSize: 1 },
  };
  await writeFile(join(parent, ".aqfmtrc.json"), JSON.stringify(original));
  await formatPluginFixture(cwd);
  const createSession = vi.fn(() => ({ execute: () => ({ verdicts: [] }), dispose: () => {} }));
  await adapterFixture(cwd, {
    id: "fixture",
    optionsSchema: z.strictObject({ account: z.string() }),
    createSession,
  });

  const fallback = await extractConfig("format", { cwd });
  expect(fallback.config).toMatchObject(original);
  expect(createSession).toHaveBeenLastCalledWith(
    expect.objectContaining({ options: { account: "rc" } }),
  );

  const sameAdapter = await extractConfig("format", { cwd, adapter: "./adapter.mjs" });
  expect(sameAdapter.config.ai).toEqual(original.ai);
  expect(createSession).toHaveBeenLastCalledWith(
    expect.objectContaining({ options: { account: "rc" } }),
  );

  const createReplacementSession = vi.fn(() => ({
    execute: () => ({ verdicts: [] }),
    dispose() {},
  }));
  await adapterFixture(
    cwd,
    {
      id: "replacement",
      optionsSchema: z.strictObject({}),
      createSession: createReplacementSession,
    },
    "replacement.mjs",
  );
  const replaced = await extractConfig("format", { cwd, adapter: "./replacement.mjs" });
  expect(replaced.config.ai).toEqual({
    adapter: "./replacement.mjs",
    timeoutMs: 50,
    fileBatchSize: 1,
  });
  expect(createReplacementSession).toHaveBeenCalledWith(expect.objectContaining({ options: {} }));

  const overridden = await extractConfig("format", {
    cwd,
    plugins: [builtInRules],
    adapter: "./adapter.mjs",
    aiOptions: { account: "override" },
    timeoutMs: 100,
  });
  expect(overridden.config).toMatchObject({
    ...original,
    plugins: [builtInRules],
    ai: {
      ...original.ai,
      options: { account: "override" },
      timeoutMs: 100,
    },
  });
  expect(createSession).toHaveBeenLastCalledWith(
    expect.objectContaining({ options: { account: "override" } }),
  );
  await expect(
    extractConfig("format", { cwd, aiOptions: { account: false } }),
  ).rejects.toMatchObject({ code: "AI_ADAPTER_OPTIONS_INVALID" });
  await expect(
    extractConfig("format", { cwd, plugins: [builtInRules, builtInRules] }),
  ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  await expect(extractConfig("format", { cwd, configPath: "missing.json" })).rejects.toMatchObject({
    code: "CONFIG_NOT_FOUND",
  });
  await writeFile(join(cwd, "invalid.json"), "invalid JSON");
  await expect(extractConfig("format", { cwd, configPath: "invalid.json" })).rejects.toMatchObject({
    code: "CONFIG_PARSE_FAILED",
  });
  const empty = await project();
  await expect(extractConfig("format", { cwd: empty })).rejects.toMatchObject({
    code: "EXTRACT_PLUGIN_REQUIRED",
  });
  await expect(
    extractConfig("format", { cwd: empty, plugins: [builtInRules] }),
  ).rejects.toMatchObject({ code: "AI_ADAPTER_REQUIRED" });
});

test.each([
  {
    name: "an existing default output",
    options: { write: true },
    file: [".aqfmtrc.json", "{}"],
    code: "EXTRACT_CONFIG_OUTPUT_EXISTS",
  },
  {
    name: "conflicting save options",
    options: { write: true, force: true, merge: true },
    code: "EXTRACT_CONFIG_WRITE_MODE",
  },
  {
    name: "a JSONC merge",
    options: { output: "output.jsonc", merge: true },
    code: "EXTRACT_CONFIG_JSONC_MERGE",
  },
  {
    name: "a malformed merge file",
    options: { output: "output.json", merge: true },
    file: ["output.json", "{broken"],
    code: "CONFIG_PARSE_FAILED",
  },
])("rejects $name before creating an adapter session", async ({ options, file, code }) => {
  const cwd = await project();
  if (file) await writeFile(join(cwd, file[0]!), file[1]!);
  const execute = vi.fn(() => ({ verdicts: [] }));
  const createSession = vi.fn(() => ({ execute, dispose() {} }));
  await adapterFixture(cwd, { id: "fixture", createSession });

  await expect(
    extractConfig("format", {
      cwd,
      plugins: [builtInRules],
      adapter: "./adapter.mjs",
      ...options,
    }),
  ).rejects.toMatchObject({ code });
  expect(createSession).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

test("rejects empty sources before creating a session or output directories", async () => {
  const cwd = await project();
  const empty = await project();
  const createSession = vi.fn(() => ({ execute: () => ({ verdicts: [] }), dispose() {} }));
  await adapterFixture(cwd, { id: "fixture", createSession });

  await expect(
    extractConfig("format", {
      cwd,
      paths: [empty],
      plugins: [builtInRules],
      adapter: "./adapter.mjs",
      output: "nested/config.json",
    }),
  ).rejects.toMatchObject({ code: "EXTRACT_NO_SOURCE_FILES" });
  expect(createSession).not.toHaveBeenCalled();
  await expect(stat(join(cwd, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("returns empty rules without a session when the plugin has no rules for the tool", async () => {
  const cwd = await project();
  await formatPluginFixture(cwd);
  const createSession = vi.fn(() => ({ execute: () => ({ verdicts: [] }), dispose() {} }));
  await adapterFixture(cwd, { id: "fixture", createSession });

  await expect(
    extractConfig("lint", {
      cwd,
      plugins: ["./plugin.mjs"],
      adapter: "./adapter.mjs",
    }),
  ).resolves.toMatchObject({
    config: { rules: {}, preset: [] },
    report: { ai: { adapter: "fixture" } },
  });
  expect(createSession).not.toHaveBeenCalled();
});

test.each(["AI_TIMEOUT", "AI_ABORTED"])(
  "preserves %s when adapter disposal also fails",
  async (code) => {
    const cwd = await project();
    const controller = new AbortController();
    const dispose = vi.fn(() => {
      throw new Error("dispose failed");
    });
    const aborted = vi.fn();
    await adapterFixture(cwd, {
      id: "fixture",
      createSession: () => ({
        execute: (request) => {
          request.signal.addEventListener("abort", aborted, { once: true });
          if (code === "AI_ABORTED") queueMicrotask(() => controller.abort());
          return new Promise(() => {});
        },
        dispose,
      }),
    });
    await expect(
      extractConfig("format", {
        cwd,
        plugins: [builtInRules],
        adapter: "./adapter.mjs",
        timeoutMs: code === "AI_TIMEOUT" ? 10 : 1_000,
        write: true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code });
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(readFile(join(cwd, ".aqfmtrc.json"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("reports disposal failure after a successful analysis", async () => {
  const cwd = await project();
  const disposeError = new Error("dispose failed");
  await adapterFixture(cwd, {
    id: "fixture",
    createSession: () => ({
      execute: () => ({ verdicts: [] }),
      dispose: () => {
        throw disposeError;
      },
    }),
  });

  await expect(
    extractConfig("format", {
      cwd,
      plugins: [builtInRules],
      adapter: "./adapter.mjs",
      write: true,
    }),
  ).rejects.toBe(disposeError);
  await expect(readFile(join(cwd, ".aqfmtrc.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("accepts explicit timeouts above the maximum single timer delay", async () => {
  const cwd = await project();
  await adapterFixture(cwd, {
    id: "fixture",
    createSession: () => ({
      async execute({ signal }) {
        await delay(10, undefined, { signal });
        return { verdicts: [] };
      },
      dispose() {},
    }),
  });

  const timeoutMs = 3_000_000_000;
  await expect(
    extractConfig("format", {
      cwd,
      plugins: [builtInRules],
      adapter: "./adapter.mjs",
      timeoutMs,
    }),
  ).resolves.toMatchObject({ config: { ai: { timeoutMs } } });
});
