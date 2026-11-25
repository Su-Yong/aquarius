import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { codexAdapter, codexOptionsSchema } from "../src/index";

const liveTest = process.env.AQUARIUS_CODEX_LIVE === "1" ? test : test.skip;

liveTest(
  "reads only an approved fixture and returns final schema JSON without changing the source",
  async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "aquarius-codex-live-"));
    const allowedContent = "AQUARIUS_LIVE_ALLOWED_7f3c\n";
    const ignoredContent = "AQUARIUS_LIVE_IGNORED_91ab\n";
    await mkdir(join(projectRoot, "ignored"));
    await writeFile(join(projectRoot, "allowed.txt"), allowedContent);
    await writeFile(join(projectRoot, "ignored", "secret.txt"), ignoredContent);
    const beforeEntries = await readdir(projectRoot, { recursive: true });
    const startedAt = Date.now();

    try {
      const context = {
        projectRoot,
        readableFiles: ["allowed.txt"],
        ruleResources: [],
        options: codexOptionsSchema.parse({}),
        signal: AbortSignal.timeout(120_000),
      };
      const session = await codexAdapter.createSession(context);
      try {
        const result = await session.execute({
          ...context,
          prompt:
            "Read allowed.txt. Return its trimmed text as token and its relative path as path.",
          outputSchema: {
            type: "object",
            properties: {
              token: { type: "string" },
              path: { type: "string" },
            },
            required: ["token", "path"],
            additionalProperties: false,
          },
        });

        const elapsedMs = Date.now() - startedAt;
        console.log(JSON.stringify({ liveCodex: { status: "passed", elapsedMs, result } }));
        expect(result).toEqual({ token: allowedContent.trim(), path: "allowed.txt" });
        expect(await readFile(join(projectRoot, "allowed.txt"), "utf8")).toBe(allowedContent);
        expect(await readFile(join(projectRoot, "ignored", "secret.txt"), "utf8")).toBe(
          ignoredContent,
        );
        expect(await readdir(projectRoot, { recursive: true })).toEqual(beforeEntries);
      } finally {
        await session.dispose();
      }
    } finally {
      const tempRoot = resolve(tmpdir());
      const candidate = resolve(projectRoot);
      if (
        dirname(candidate) === tempRoot &&
        candidate.startsWith(join(tempRoot, "aquarius-codex-live-"))
      ) {
        await rm(candidate, { recursive: true, force: true });
      }
    }
  },
  130_000,
);
