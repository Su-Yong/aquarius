import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test, vi } from "vitest";

import { isPlainObject } from "@aqtools/core/adapter";
import { antigravityAdapter, antigravityOptionsSchema } from "../src/index";
import * as antigravityProcess from "../src/process";

const liveTest = process.env.AQUARIUS_ANTIGRAVITY_LIVE === "1" ? test : test.skip;
const liveTimeout = 130_000;
const allowedFile = "allowed.txt";
const provisionalFrame = {
  type: "aquarius.analysis_update",
  revision: 1,
  fileResults: [{ path: allowedFile, status: "completed" }],
};

const observeToolMetadata = () => {
  const initTools = new Set<string>();
  const parameterKeys = new Map<string, string[]>();
  const isLabel = (value: unknown): value is string =>
    typeof value === "string" && /^[a-z][\w./:-]{0,79}$/iu.test(value);
  const record = (line: string) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!isPlainObject(event)) return;

    if (event.event === "init" && isPlainObject(event.init) && Array.isArray(event.init.tools)) {
      for (const name of event.init.tools.filter(isLabel)) initTools.add(name);
    } else if (event.event === "step_update" && isPlainObject(event.step_update)) {
      const tool = event.step_update.tool_info;
      if (isPlainObject(tool) && isLabel(tool.name) && isPlainObject(tool.parameters)) {
        parameterKeys.set(tool.name, Object.keys(tool.parameters).filter(isLabel).sort());
      }
    }
  };
  const spawn = antigravityProcess.spawnAntigravity;
  const readers = new Set<ReturnType<typeof createInterface>>();
  const observer = vi
    .spyOn(antigravityProcess, "spawnAntigravity")
    .mockImplementation((...args) => {
      const running = spawn(...args);
      const reader = createInterface({ input: running.child.stdout, crlfDelay: Infinity });
      readers.add(reader);
      reader.on("line", record);
      running.child.once("close", () => {
        reader.close();
        readers.delete(reader);
      });
      return running;
    });

  return {
    initTools,
    parameterKeys,
    restore: () => {
      for (const reader of readers) reader.close();
      readers.clear();
      observer.mockRestore();
    },
  };
};

const runLive = async (withUpdates: boolean) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "aquarius-agy-live-test-"));
  const files = {
    [allowedFile]: `AQUARIUS_LIVE_ALLOWED_${randomUUID()}\n`,
    "ignored/secret.txt": `AQUARIUS_LIVE_IGNORED_${randomUUID()}\n`,
  };

  try {
    await mkdir(join(projectRoot, "ignored"));
    await Promise.all(
      Object.entries(files).map(([path, content]) => writeFile(join(projectRoot, path), content)),
    );
    const beforeEntries = (await readdir(projectRoot, { recursive: true })).sort();
    const context = {
      projectRoot,
      readableFiles: [allowedFile],
      ruleResources: [],
      options: antigravityOptionsSchema.parse({}),
      signal: AbortSignal.timeout(120_000),
    };
    const session = await antigravityAdapter.createSession(context);

    try {
      const progress: string[] = [];
      const updates: unknown[] = [];
      const prompt = [
        `Use a local read tool on ${allowedFile}. Read only that file.`,
        ...(withUpdates
          ? [
              `If the adapter supports provisional reporting, send this provisional frame before the final response: ${JSON.stringify(provisionalFrame)}.`,
            ]
          : []),
        "Return the trimmed file content as token and its relative path as path.",
      ].join("\n");
      const result = await session.execute({
        ...context,
        prompt,
        outputSchema: {
          type: "object",
          properties: { token: { type: "string" }, path: { type: "string" } },
          required: ["token", "path"],
          additionalProperties: false,
        },
        onProgress: (message) => progress.push(message),
        ...(withUpdates && { onAnalysisUpdate: (update: unknown) => updates.push(update) }),
      });

      expect(result).toEqual({ token: files[allowedFile].trim(), path: allowedFile });
      for (const [path, content] of Object.entries(files)) {
        expect(await readFile(join(projectRoot, path), "utf8")).toBe(content);
      }
      expect((await readdir(projectRoot, { recursive: true })).sort()).toEqual(beforeEntries);
      expect(progress).toContain("Reading Antigravity response");
      return { progress, updates };
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
};

liveTest(
  "reads an approved fixture with streaming input and structured output",
  async () => {
    const trace = observeToolMetadata();
    try {
      const { progress } = await runLive(false);
      console.info("Antigravity tool metadata", {
        initTools: [...trace.initTools].sort(),
        parameterKeys: Object.fromEntries(trace.parameterKeys),
      });
      expect(progress).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/(?:Inspecting|last referenced:) .*allowed\.txt/u),
        ]),
      );
      expect(trace.initTools.size).toBeGreaterThan(0);
      expect([...trace.parameterKeys.values()].some((keys) => keys.length > 0)).toBe(true);
    } finally {
      trace.restore();
    }
  },
  liveTimeout,
);

liveTest(
  "completes structured output cleanly when a prompt offers optional provisional reporting",
  async () => {
    const { updates } = await runLive(true);
    expect(updates).toEqual([]);
  },
  liveTimeout,
);
