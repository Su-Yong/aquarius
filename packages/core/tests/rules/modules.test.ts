import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importProjectModule } from "../../src/rules/modules";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("imports a relative module from the project and returns its default export", async () => {
  const directory = await project();
  await writeFile(join(directory, "plugin.mjs"), `export default { id: "relative" };`);

  await expect(importProjectModule("./plugin.mjs", directory)).resolves.toEqual({ id: "relative" });
});

test("returns the namespace when a module has no default export", async () => {
  const directory = await project();
  await writeFile(join(directory, "named.mjs"), `export const id = "named"; export const enabled = true;`);

  const imported = await importProjectModule("./named.mjs", directory) as Record<string, unknown>;
  expect(imported).toMatchObject({ id: "named", enabled: true });
});

test("uses ESM import conditions for an import-only package export", async () => {
  const directory = await project();
  const packageDirectory = join(directory, "node_modules", "import-only-rules");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
    name: "import-only-rules",
    type: "module",
    exports: { ".": { import: "./import.mjs" } },
  }));
  await writeFile(join(packageDirectory, "import.mjs"), `export default { id: "import-condition" };`);

  await expect(importProjectModule("import-only-rules", directory)).resolves.toEqual({ id: "import-condition" });
  await expect(importProjectModule("import-only-rules", directory, { id: "bundled-old-version" }))
    .resolves.toEqual({ id: "import-condition" });
});

test("uses a bundled fallback only when the package is absent, not when its entry is broken", async () => {
  const directory = await project();
  const fallback = { id: "bundled" };
  await expect(importProjectModule("missing-bundled-plugin", directory, fallback)).resolves.toBe(fallback);
  const broken = join(directory, "node_modules", "broken-plugin");
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, "package.json"), JSON.stringify({
    name: "broken-plugin", type: "module", exports: "./absent.mjs",
  }));
  await expect(importProjectModule("broken-plugin", directory, fallback)).rejects.toThrow();
});

const project = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "aquarius-modules-"));
  directories.push(directory);
  return directory;
};
