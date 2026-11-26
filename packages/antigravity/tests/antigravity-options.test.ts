import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { resolveAntigravityExecutable } from "../src/executable";
import { antigravityOptionsSchema } from "../src/options";

const executableName = process.platform === "win32" ? "agy.exe" : "agy";
const roots: string[] = [];

const createDirectory = async (): Promise<string> => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "antigravity-lookup-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("trims the supported options and enables the sandbox by default", () => {
  expect(antigravityOptionsSchema.parse({})).toEqual({ sandbox: true });
  expect(
    antigravityOptionsSchema.parse({
      executable: " /usr/local/bin/agy ",
      model: " future-model ",
      effort: " future-effort ",
      agent: " local-agent ",
      mode: "plan",
      sandbox: false,
    }),
  ).toEqual({
    executable: "/usr/local/bin/agy",
    model: "future-model",
    effort: "future-effort",
    agent: "local-agent",
    mode: "plan",
    sandbox: false,
  });
  expect(antigravityOptionsSchema.parse({ mode: "auto" })).toEqual({ mode: "auto", sandbox: true });
});

test.each([
  { executable: "" },
  { model: " " },
  { effort: " " },
  { agent: "\t" },
  { mode: "accept-edits" },
  { sandbox: "true" },
  { outputFormat: "json" },
  { "dangerously-skip-permissions": true },
])("rejects invalid or unknown options %o", (options) => {
  expect(antigravityOptionsSchema.safeParse(options).success).toBe(false);
});

test("resolves a regular executable by absolute path or through PATH", async () => {
  const empty = await createDirectory();
  const directory = await createDirectory();
  const executable = join(directory, executableName);
  await writeFile(executable, "fixture", { mode: 0o700 });
  vi.stubEnv("PATH", [empty, `"${directory}"`].join(delimiter));

  await expect(resolveAntigravityExecutable(executable)).resolves.toBe(executable);
  await expect(resolveAntigravityExecutable()).resolves.toBe(executable);
});

test("rejects relative paths, missing files, directories and an empty PATH", async () => {
  const directory = await createDirectory();
  vi.stubEnv("PATH", "");

  await expect(resolveAntigravityExecutable(executableName)).rejects.toMatchObject({
    code: "ANTIGRAVITY_EXECUTABLE_INVALID",
  });
  for (const executable of [join(directory, executableName), directory, undefined]) {
    await expect(resolveAntigravityExecutable(executable)).rejects.toMatchObject({
      code: "ANTIGRAVITY_EXECUTABLE_NOT_FOUND",
    });
  }
});

test.skipIf(process.platform === "win32")("returns the canonical executable path", async () => {
  const directory = await createDirectory();
  const executable = join(directory, "antigravity-bin");
  const link = join(directory, executableName);
  await writeFile(executable, "fixture", { mode: 0o700 });
  await symlink(executable, link);
  vi.stubEnv("PATH", directory);

  await expect(resolveAntigravityExecutable(link)).resolves.toBe(executable);
  await expect(resolveAntigravityExecutable()).resolves.toBe(executable);
});

test.skipIf(process.platform === "win32")("rejects a file without execute permission", async () => {
  const executable = join(await createDirectory(), executableName);
  await writeFile(executable, "fixture", { mode: 0o600 });

  await expect(resolveAntigravityExecutable(executable)).rejects.toMatchObject({
    code: "ANTIGRAVITY_EXECUTABLE_NOT_FOUND",
  });
});

test.skipIf(process.platform !== "win32")("prefers agy.exe and falls back to agy.cmd", async () => {
  const directory = await createDirectory();
  const shim = join(directory, "agy.cmd");
  const executable = join(directory, "agy.exe");
  vi.stubEnv("PATH", directory);

  await writeFile(shim, "fixture");
  await expect(resolveAntigravityExecutable()).resolves.toBe(shim);
  await writeFile(executable, "fixture");
  await expect(resolveAntigravityExecutable()).resolves.toBe(executable);
});
