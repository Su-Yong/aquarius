import { access, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { expect, vi } from "vitest";

import antigravity, { antigravityAdapter } from "../src/index";
import { mockTest, prepareFixture } from "./fixtures";

vi.mock("node:fs/promises", { spy: true });

mockTest(
  "shares an isolated snapshot while concurrent requests use distinct schema files",
  async () => {
    const isWindows = process.platform === "win32";
    const writeBits = isWindows ? 0o200 : 0o222;
    const fixture = await prepareFixture({
      action: `
const release = path.join(fixtureRoot, "release");
while (!fs.existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 10));
const contents = fs.readFileSync("allowed.txt", "utf8");
const mode = fs.statSync("allowed.txt").mode & ${writeBits};
const excluded = fs.existsSync("ignored/secret.txt");
const rule = fs.readFileSync(rulePath, "utf8");
const ruleMode = fs.statSync(rulePath).mode & ${writeBits};
result({ status: "SUCCESS", structured_output: { title: schema.title, contents, mode, excluded, rule, ruleMode } });
`,
    });
    const progress: string[] = [];
    const session = await fixture.createSession({
      onProgress: (message) => progress.push(message),
    });
    expect(antigravity).toBe(antigravityAdapter);
    expect(antigravityAdapter.id).toBe("antigravity");
    expect(session.info).toEqual({ adapter: "antigravity" });
    expect(progress).toEqual([
      "Locating Antigravity",
      "Preparing snapshot (1 context files)",
      "Preparing snapshot 1/1: allowed.txt",
      "Preparing rule files (1 rules)",
    ]);
    await writeFile(join(fixture.projectRoot, "allowed.txt"), "changed after preparation");

    const titles = ["first", "second"];
    const pending = Promise.all(
      titles.map((title) =>
        session.execute(fixture.request({ outputSchema: { title, type: "object" } })),
      ),
    );
    const results = expect(pending).resolves.toEqual(
      titles.map((title) => ({
        title,
        contents: "snapshot input",
        mode: isWindows ? 0o200 : 0,
        excluded: false,
        rule: fixture.rule.content,
        ...(isWindows ? { ruleMode: expect.any(Number) } : { ruleMode: 0 }),
      })),
    );

    try {
      await expect.poll(async () => (await fixture.invocations()).length).toBe(2);
      const invocations = await fixture.invocations();
      const { viewRoot } = invocations[0]!;
      const runRoot = dirname(viewRoot);
      const schemaPaths = invocations.map(({ schemaPath }) => schemaPath);
      const schemaNames = schemaPaths.map((path) => basename(path));
      expect(viewRoot).not.toBe(fixture.projectRoot);
      expect(invocations.map(({ viewRoot }) => viewRoot)).toEqual([viewRoot, viewRoot]);
      expect(new Set(schemaPaths).size).toBe(2);
      for (const { schemaPath, schemaMode } of invocations) {
        expect(dirname(schemaPath)).toBe(runRoot);
        expect(basename(schemaPath)).toMatch(/^schema-[a-f0-9-]{36}\.json$/u);
        if (!isWindows) expect(schemaMode).toBe(0o600);
      }
      expect((await readdir(runRoot)).sort()).toEqual([basename(viewRoot), ...schemaNames].sort());

      await writeFile(join(fixture.root, "release"), "");
      await results;
      expect(await readdir(runRoot)).toEqual([basename(viewRoot)]);
      await session.dispose();
      await expect(access(runRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await session.dispose();
      await results.catch(() => {});
    }
  },
);

const busySchema = () => Object.assign(new Error("Output schema is busy."), { code: "EBUSY" });

mockTest(
  "retries a temporary schema deletion failure and removes the file before returning",
  async () => {
    const fixture = await prepareFixture();
    const session = await fixture.createSession();
    const removeSchema = vi.mocked(unlink);
    removeSchema.mockClear().mockRejectedValueOnce(busySchema());

    try {
      await expect(session.execute(fixture.request())).resolves.toEqual({ ok: true });
      const [{ schemaPath }] = await fixture.invocations();
      expect(removeSchema).toHaveBeenCalledTimes(2);
      await expect(access(schemaPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      removeSchema.mockReset();
    }
  },
);

mockTest.each([
  {
    action: undefined,
    message: "Antigravity could not remove its output schema.",
  },
  {
    action: `result({ status: "ERROR", error: "Original execution error" });`,
    message: "Original execution error",
  },
])(
  "reports the relevant error when all schema deletion attempts fail ($message)",
  async ({ action, message }) => {
    const fixture = await prepareFixture({ action });
    const session = await fixture.createSession();
    const removeSchema = vi.mocked(unlink);
    removeSchema.mockClear().mockRejectedValue(busySchema());

    try {
      await expect(session.execute(fixture.request())).rejects.toMatchObject({
        code: "ANTIGRAVITY_EXECUTION_FAILED",
        message: expect.stringContaining(message),
      });
      expect(removeSchema).toHaveBeenCalledTimes(4);
      const [{ schemaPath }] = await fixture.invocations();
      await session.dispose();
      await expect(access(schemaPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      removeSchema.mockReset();
    }
  },
);

mockTest("aborts active requests on dispose and returns the same cleanup promise", async () => {
  const fixture = await prepareFixture({ action: "hold();" });
  const session = await fixture.createSession();
  const rejected = [1, 2].map(() =>
    expect(session.execute(fixture.request())).rejects.toMatchObject({
      code: "ANTIGRAVITY_ABORTED",
    }),
  );

  try {
    await expect.poll(async () => (await fixture.invocations()).length).toBe(2);
    const [{ viewRoot }] = await fixture.invocations();
    const disposed = session.dispose();
    expect(session.dispose()).toBe(disposed);
    await Promise.all([disposed, ...rejected]);
    await expect(access(dirname(viewRoot))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(session.execute(fixture.request())).rejects.toMatchObject({
      code: "ANTIGRAVITY_ABORTED",
    });
    expect(await fixture.invocations()).toHaveLength(2);
  } finally {
    await session.dispose();
    await Promise.allSettled(rejected);
  }
});

mockTest.each(["request", "session"])(
  "cancels a running process from the %s signal",
  async (source) => {
    const fixture = await prepareFixture({ action: "hold();" });
    const controller = new AbortController();
    const session = await fixture.createSession(
      source === "session" ? { signal: controller.signal } : {},
    );
    const request = fixture.request(source === "request" ? { signal: controller.signal } : {});
    const rejected = expect(session.execute(request)).rejects.toMatchObject({
      code: "ANTIGRAVITY_ABORTED",
    });
    try {
      await expect.poll(async () => (await fixture.invocations()).length).toBe(1);
      controller.abort();
      await rejected;
      const [{ viewRoot }] = await fixture.invocations();
      expect(await readdir(dirname(viewRoot))).toEqual([basename(viewRoot)]);
    } finally {
      await session.dispose();
      await rejected.catch(() => {});
    }
  },
);

mockTest("maps preparation errors and removes partial snapshots", async () => {
  const fixture = await prepareFixture();
  const runDirectory = join(fixture.root, "temp");
  await mkdir(runDirectory);
  vi.stubEnv("TMPDIR", runDirectory);
  vi.stubEnv("TMP", runDirectory);
  vi.stubEnv("TEMP", runDirectory);
  try {
    const { context, rule } = fixture;
    const cases = [
      { context: { ...context, readableFiles: ["../outside.txt"] }, code: "READABLE_PATH_INVALID" },
      { context: { ...context, readableFiles: ["ignored"] }, code: "READABLE_PATH_UNSUPPORTED" },
      {
        context: { ...context, projectRoot: join(fixture.root, "missing") },
        code: "PROJECT_ROOT_INVALID",
      },
      {
        context: { ...context, ruleResources: [{ ...rule, detailsPath: "rule.json" }] },
        code: "RULE_RESOURCES_INVALID",
      },
      {
        context: { ...context, ruleResources: [{ ...rule, content: "tampered" }] },
        code: "RULE_RESOURCE_CHANGED",
      },
    ];

    const collision = join(fixture.projectRoot, rule.detailsPath);
    await mkdir(dirname(collision));
    await writeFile(collision, "project copy");
    cases.push({
      context: { ...context, readableFiles: [rule.detailsPath] },
      code: "RULE_RESOURCE_CONFLICT",
    });

    for (const { context, code } of cases) {
      await expect(fixture.createSession(context)).rejects.toMatchObject({
        code: `ANTIGRAVITY_${code}`,
      });
      expect(await readdir(runDirectory)).toEqual([]);
    }
    expect(await fixture.invocations()).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
  }
});
