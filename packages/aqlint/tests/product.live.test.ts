import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { liveTest, repositoryRoot, runCli, createProject, removeProject, parseJson } from "../../../tests/product-live";

const aqlint = join(repositoryRoot, "packages", "aqlint", "dist", "cli.mjs");

liveTest("aqlint finds an input mutation without changing source or ignored files", async () => {
  const root = await createProject();
  const source = `def sorted_copy(items):\n    \"\"\"Return a sorted copy without changing the input list.\"\"\"\n    items.sort()\n    return items\n`;
  const ignored = "AQUARIUS_PRODUCT_LIVE_IGNORED_42d1\n";
  try {
    await writeFile(join(root, "lint", "sorted_copy.py"), source);
    await writeFile(join(root, ".aqlintrc.jsonc"), JSON.stringify({
      files: ["lint/**"],
      ignore: ["ignored/**"],
      plugins: ["@aquarius/rules"],
      rules: [{ rule: "aquarius/contracts/no-input-mutation" }],
    }));
    const beforeEntries = await readdir(root, { recursive: true });

    const execution = await runCli(aqlint, ["--format", "json", "lint/sorted_copy.py"], root);
    const output = parseJson(execution.stdout);
    console.log(JSON.stringify({ productLive: { tool: "aqlint", ...execution, stdout: output } }));

    expect(execution.status, execution.stderr).toBe(1);
    expect(output.errors).toEqual([]);
    expect(output.unknowns).toEqual([]);
    const diagnostics = output.diagnostics as Array<{
      rules: Array<{ rule: string; severity: string }>;
      locations: Array<{ path: string }>;
      evidence: unknown[];
    }>;
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((diagnostic) => diagnostic.rules.some((rule) =>
      rule.rule === "aquarius/contracts/no-input-mutation" && rule.severity === "error"))).toBe(true);
    expect(diagnostics.every((diagnostic) => diagnostic.locations.every((location) =>
      location.path === "lint/sorted_copy.py"))).toBe(true);
    expect(diagnostics.every((diagnostic) => diagnostic.evidence.length > 0)).toBe(true);
    expect(await readFile(join(root, "lint", "sorted_copy.py"), "utf8")).toBe(source);
    expect(await readFile(join(root, "ignored", "private.txt"), "utf8")).toBe(ignored);
    expect(await readdir(root, { recursive: true })).toEqual(beforeEntries);
  } finally {
    await removeProject(root);
  }
}, 140_000);

