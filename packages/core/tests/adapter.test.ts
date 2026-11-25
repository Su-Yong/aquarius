import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { defineAdapter, type AdapterRunInfo } from "../src/adapter";
import { resolveAdapter } from "../src/adapter/resolve";
import { executeWithTimeout } from "../src/adapter/run";
import type { AdapterExecuteRequest, AdapterSession } from "../src/adapter/types";
import type { LoadedConfig } from "../src/config/types";

const directories: string[] = [];
const input: Omit<AdapterExecuteRequest, "signal"> = {
  projectRoot: "/project",
  readableFiles: [],
  prompt: "Inspect the project.",
  ruleResources: [],
  outputSchema: { type: "object" },
  options: {},
};

const config = (directory: string, specifier?: string): LoadedConfig => ({
  tool: "lint",
  cwd: directory,
  projectRoot: directory,
  configDirectory: directory,
  files: [],
  ignore: [],
  plugins: [],
  preset: [],
  ai: { adapter: specifier, timeoutMs: 1_000, options: {} },
  rules: {},
});

const project = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "aquarius-adapter-test-"));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test.each([
  'export default { id: "mock", run: (request) => request.prompt };',
  'export default { id: "mock", createSession: () => ({ execute: (request) => request.prompt, dispose() {} }) };',
])("loads a plain adapter relative to the configuration directory", async (source) => {
  const directory = await project();
  await writeFile(join(directory, "mock.mjs"), source);

  const resolved = await resolveAdapter(config(directory, "./mock.mjs"));
  const session = await resolved.adapter.createSession({
    ...input,
    options: resolved.options,
    signal: new AbortController().signal,
  });
  expect(session.info).toEqual({ adapter: "mock" });
  await expect(executeWithTimeout(session, input, 1_000)).resolves.toBe(input.prompt);
  await session.dispose();
});

test("passes parsed options with defaults and transformations to a defined session adapter", async () => {
  const adapter = defineAdapter({
    id: "schema",
    optionsSchema: z.object({
      count: z.number().default(2),
      text: z.string().trim(),
    }),
    createSession({ options }) {
      return {
        execute: () => options.text.repeat(options.count),
        dispose: () => {},
      };
    },
  });

  const loaded = config("/project");
  loaded.ai.options = { text: " hi " };
  const resolved = await resolveAdapter(loaded, adapter);
  expect(resolved.options).toEqual({ text: "hi", count: 2 });

  const signal = new AbortController().signal;
  const session = await resolved.adapter.createSession({
    ...input,
    options: resolved.options,
    signal,
  });
  await expect(
    executeWithTimeout(session, { ...input, options: resolved.options }, 1_000),
  ).resolves.toBe("hihi");

  loaded.ai.options = { text: false };
  await expect(resolveAdapter(loaded, adapter)).rejects.toMatchObject({
    code: "AI_ADAPTER_OPTIONS_INVALID",
    message: expect.stringContaining("text"),
  });
});

test("passes configuration options as-is without a schema", async () => {
  const loaded = config("/project");
  loaded.ai.options = { text: " hi " };
  const adapter = defineAdapter({ id: "options", run: ({ options }) => options });

  const resolved = await resolveAdapter(loaded, adapter);
  expect(resolved.options).toBe(loaded.ai.options);
  const session = await resolved.adapter.createSession({
    ...input,
    options: resolved.options,
    signal: new AbortController().signal,
  });
  const request = { ...input, options: resolved.options };
  await expect(executeWithTimeout(session, request, 1_000)).resolves.toBe(loaded.ai.options);
});

test("distinguishes a missing adapter, a module load failure, and a malformed adapter export", async () => {
  const directory = await project();
  await writeFile(join(directory, "invalid.mjs"), 'export default { id: "invalid" };');

  await expect(resolveAdapter(config(directory))).rejects.toMatchObject({
    code: "AI_ADAPTER_REQUIRED",
  });
  for (const specifier of ["codex", "./missing.mjs"]) {
    await expect(resolveAdapter(config(directory, specifier))).rejects.toMatchObject({
      code: "AI_ADAPTER_LOAD_FAILED",
    });
  }
  await expect(resolveAdapter(config(directory, "./invalid.mjs"))).rejects.toMatchObject({
    code: "INVALID_AI_ADAPTER",
  });
});

test("rejects a session missing execute or dispose", async () => {
  const directory = await project();
  await writeFile(
    join(directory, "invalid-session.mjs"),
    'export default { id: "invalid", createSession: () => ({ execute() {} }) };',
  );
  const { adapter } = await resolveAdapter(config(directory, "./invalid-session.mjs"));
  await expect(
    adapter.createSession({ ...input, signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: "INVALID_AI_ADAPTER" });
});

test("retains supplied session metadata and the original session method receiver", async () => {
  const info: AdapterRunInfo = {
    adapter: "provider",
    model: "fixture-model",
    details: { serviceTier: "fast" },
  };
  class FixtureSession {
    readonly info = info;
    #disposed = false;

    execute() {
      return this.#disposed;
    }

    dispose() {
      this.#disposed = true;
    }
  }
  const resolved = await resolveAdapter(
    config("/project"),
    defineAdapter({ id: "fixture", createSession: () => Object.freeze(new FixtureSession()) }),
  );
  const request = { ...input, signal: new AbortController().signal };
  const session = await resolved.adapter.createSession(request);

  expect(session.info).toEqual(info);
  expect(session.execute(request)).toBe(false);
  await session.dispose();
  expect(session.execute(request)).toBe(true);
});

test("fills the adapter ID when session metadata omits it", async () => {
  const directory = await project();
  await writeFile(
    join(directory, "mock.mjs"),
    'export default { id: "mock", createSession: () => ({ info: { model: "fixture-model" }, execute() {}, dispose() {} }) };',
  );
  const { adapter } = await resolveAdapter(config(directory, "./mock.mjs"));
  const session = await adapter.createSession({ ...input, signal: new AbortController().signal });

  expect(session.info).toEqual({ adapter: "mock", model: "fixture-model" });
  await session.dispose();
});

test.each([
  ["null metadata", null],
  ["non-object metadata", []],
  ["blank adapter ID", { adapter: " " }],
  ["non-string adapter ID", { adapter: 42 }],
  ["non-string model", { model: false }],
  ["non-record details", { details: ["fast"] }],
  ["non-string detail", { details: { serviceTier: 42 } }],
] as const)("rejects %s and disposes the invalid session", async (_label, info) => {
  const dispose = vi.fn();
  const { adapter } = await resolveAdapter(
    config("/project"),
    defineAdapter({
      id: "mock",
      createSession: () => ({ info: info as unknown as AdapterRunInfo, execute() {}, dispose }),
    }),
  );

  await expect(
    adapter.createSession({ ...input, signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: "INVALID_AI_ADAPTER" });
  expect(dispose).toHaveBeenCalledOnce();
});

const session = (execute: AdapterSession["execute"]): AdapterSession => ({
  execute,
  dispose: () => {},
});

test("forwards safe activity and includes its age and the configured limit on timeout", async () => {
  vi.useFakeTimers();
  const onProgress = vi.fn();
  let received: AdapterExecuteRequest | undefined;
  const slow = session((request) => {
    received = request;
    request.onProgress?.("Inspecting src/main.ts\n");
    return new Promise(() => {});
  });
  const execution = executeWithTimeout(slow, { ...input, onProgress }, 600_000);
  const rejected = expect(execution).rejects.toMatchObject({
    code: "AI_TIMEOUT",
    message: expect.stringContaining(
      "AI execution timed out after 10:00 (ai.timeoutMs=600000). Last activity: Inspecting src/main.ts (10:00 ago).",
    ),
  });
  expect(onProgress).toHaveBeenCalledWith("Inspecting src/main.ts");
  await vi.advanceTimersByTimeAsync(600_000);
  await rejected;
  expect(received!.signal.aborted).toBe(true);
  received!.onProgress?.("Late activity");
  expect(onProgress).toHaveBeenCalledTimes(1);
});

test("distinguishes a silent adapter timeout from cancellation", async () => {
  vi.useFakeTimers();
  const silent = session(() => new Promise(() => {}));
  const execution = executeWithTimeout(silent, input, 1_000);
  const rejected = expect(execution).rejects.toMatchObject({
    code: "AI_TIMEOUT",
    message: expect.stringContaining("No adapter activity was reported."),
  });
  await vi.advanceTimersByTimeAsync(1_000);
  await rejected;

  const controller = new AbortController();
  const cancelled = executeWithTimeout(silent, input, 1_000, controller.signal);
  const cancelledResult = expect(cancelled).rejects.toMatchObject({
    code: "AI_ABORTED",
    message: "AI execution was cancelled.",
  });
  controller.abort();
  await cancelledResult;
});

test("does not start a session request when its signal is already cancelled", async () => {
  const execute = vi.fn();
  await expect(
    executeWithTimeout(session(execute), input, 1_000, AbortSignal.abort()),
  ).rejects.toMatchObject({ code: "AI_ABORTED" });
  expect(execute).not.toHaveBeenCalled();
});

test("relays analysis updates before completion, ignores late updates, and clears the timer", async () => {
  vi.useFakeTimers();
  const onAnalysisUpdate = vi.fn();
  let received: AdapterExecuteRequest | undefined;
  const updating = session((request) => {
    received = request;
    request.onAnalysisUpdate?.({ revision: 1 });
    request.onAnalysisUpdate?.({ revision: 2 });
    expect(onAnalysisUpdate).toHaveBeenCalledTimes(2);
    return { ok: true };
  });
  await expect(
    executeWithTimeout(updating, { ...input, onAnalysisUpdate }, 1_000),
  ).resolves.toEqual({
    ok: true,
  });
  received!.onAnalysisUpdate?.({ revision: 3 });
  expect(onAnalysisUpdate).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("analysis updates do not extend the timeout and stop after cancellation", async () => {
  vi.useFakeTimers();
  const onAnalysisUpdate = vi.fn();
  let received: AdapterExecuteRequest | undefined;
  const updating = session((request) => {
    received = request;
    return new Promise(() => {});
  });
  const execution = executeWithTimeout(updating, { ...input, onAnalysisUpdate }, 1_000);
  const rejected = expect(execution).rejects.toMatchObject({ code: "AI_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(900);
  received!.onAnalysisUpdate?.({ revision: 1 });
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  received!.onAnalysisUpdate?.({ revision: 2 });
  expect(onAnalysisUpdate).toHaveBeenCalledTimes(1);
});

test("a synchronous or asynchronous observer error cannot discard the final result", async () => {
  const updating = session((request) => {
    request.onProgress?.("Reading");
    request.onAnalysisUpdate?.({ revision: 1 });
    return { ok: true };
  });
  await expect(
    executeWithTimeout(
      updating,
      {
        ...input,
        onProgress: () => {
          throw new Error("Progress observer failed.");
        },
        onAnalysisUpdate: async () => {
          throw new Error("Analysis observer failed.");
        },
      },
      1_000,
    ),
  ).resolves.toEqual({ ok: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
});
