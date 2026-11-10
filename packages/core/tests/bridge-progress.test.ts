import { afterEach, expect, test, vi } from "vitest";
import { callBridge } from "../src/ai/bridge";
import type { AiBridge, BridgeInput } from "../src/ai/types";

const input: Omit<BridgeInput, "signal"> = {
  projectRoot: "/project",
  readableFiles: [],
  ignore: [],
  prompt: "Inspect the project.",
  ruleResources: { directory: "/resources", files: [] },
  outputSchema: { type: "object" },
  options: {},
};

afterEach(() => {
  vi.useRealTimers();
});

test("forwards safe activity and includes its age and the configured limit on timeout", async () => {
  vi.useFakeTimers();
  const onProgress = vi.fn();
  let bridgeInput: BridgeInput | undefined;
  const bridge: AiBridge = {
    id: "slow",
    run: (received) => {
      bridgeInput = received;
      received.onProgress?.("Inspecting src/main.ts\n");
      return new Promise(() => {});
    },
  };
  const execution = callBridge(bridge, { ...input, onProgress }, 600_000);
  const rejected = expect(execution).rejects.toMatchObject({
    code: "AI_TIMEOUT",
    message: expect.stringContaining(
      "AI execution timed out after 10:00 (ai.timeoutMs=600000). Last activity: Inspecting src/main.ts (10:00 ago).",
    ),
  });
  expect(onProgress).toHaveBeenCalledWith("Inspecting src/main.ts");
  await vi.advanceTimersByTimeAsync(600_000);
  await rejected;
  expect(bridgeInput!.signal.aborted).toBe(true);
  bridgeInput!.onProgress?.("Late activity");
  expect(onProgress).toHaveBeenCalledTimes(1);
});

test("distinguishes a silent adapter timeout from cancellation", async () => {
  vi.useFakeTimers();
  const bridge: AiBridge = { id: "silent", run: () => new Promise(() => {}) };
  const execution = callBridge(bridge, input, 1_000);
  const rejected = expect(execution).rejects.toMatchObject({
    code: "AI_TIMEOUT",
    message: expect.stringContaining("No adapter activity was reported."),
  });
  await vi.advanceTimersByTimeAsync(1_000);
  await rejected;

  const controller = new AbortController();
  const cancelled = callBridge(bridge, input, 1_000, controller.signal);
  const cancelledResult = expect(cancelled).rejects.toMatchObject({
    code: "AI_ABORTED",
    message: "AI execution was cancelled.",
  });
  controller.abort();
  await cancelledResult;
});

test("clears the timeout after a successful result", async () => {
  vi.useFakeTimers();
  const bridge: AiBridge = {
    id: "success",
    run: async (received) => {
      received.onProgress?.("Inspecting src/main.ts");
      return { ok: true };
    },
  };
  await expect(callBridge(bridge, input, 1_000)).resolves.toEqual({ ok: true });
  expect(vi.getTimerCount()).toBe(0);
});

test("relays analysis updates before completion and ignores late updates", async () => {
  const onAnalysisUpdate = vi.fn();
  let received: BridgeInput | undefined;
  const bridge: AiBridge = {
    id: "updates",
    run: async (request) => {
      received = request;
      request.onAnalysisUpdate?.({ revision: 1 });
      request.onAnalysisUpdate?.({ revision: 2 });
      expect(onAnalysisUpdate).toHaveBeenCalledTimes(2);
      return { ok: true };
    },
  };
  await expect(callBridge(bridge, { ...input, onAnalysisUpdate }, 1_000)).resolves.toEqual({
    ok: true,
  });
  received!.onAnalysisUpdate?.({ revision: 3 });
  expect(onAnalysisUpdate).toHaveBeenCalledTimes(2);
});

test("analysis updates do not extend the timeout and stop after cancellation", async () => {
  vi.useFakeTimers();
  const onAnalysisUpdate = vi.fn();
  let received: BridgeInput | undefined;
  const bridge: AiBridge = {
    id: "updating",
    run: (request) => {
      received = request;
      return new Promise(() => {});
    },
  };
  const execution = callBridge(bridge, { ...input, onAnalysisUpdate }, 1_000);
  const rejected = expect(execution).rejects.toMatchObject({ code: "AI_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(900);
  received!.onAnalysisUpdate?.({ revision: 1 });
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  received!.onAnalysisUpdate?.({ revision: 2 });
  expect(onAnalysisUpdate).toHaveBeenCalledTimes(1);
});

test("an analysis observer cannot discard the final adapter result", async () => {
  const bridge: AiBridge = {
    id: "observer-failure",
    run: async (request) => {
      request.onAnalysisUpdate?.({ revision: 1 });
      return { ok: true };
    },
  };
  await expect(
    callBridge(
      bridge,
      {
        ...input,
        onAnalysisUpdate: () => {
          throw new Error("Observer failed.");
        },
      },
      1_000,
    ),
  ).resolves.toEqual({ ok: true });
});

test("an asynchronous analysis observer rejection is handled", async () => {
  const bridge: AiBridge = {
    id: "async-observer-failure",
    run: async (request) => {
      request.onAnalysisUpdate?.({ revision: 1 });
      return { ok: true };
    },
  };
  await expect(
    callBridge(
      bridge,
      {
        ...input,
        onAnalysisUpdate: async () => {
          throw new Error("Async observer failed.");
        },
      },
      1_000,
    ),
  ).resolves.toEqual({ ok: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
});
