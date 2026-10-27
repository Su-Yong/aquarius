import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { liveTest, repositoryRoot, runCli, createProject, removeProject, parseJson } from "../../../tests/product-live";

const aqfmt = join(repositoryRoot, "packages", "aqfmt", "dist", "cli.mjs");

const labelResults = async (source: string): Promise<unknown[]> => {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Math.random()}`;
  const module = await import(moduleUrl) as { label(value: unknown): unknown };
  return [true, false, 0, 1, null, undefined, "", "value", [], {}].map((value) => module.label(value));
};

liveTest("aqfmt applies an equivalent early return and undo restores the source", async () => {
  const root = await createProject();
  const source = `export function label(ok) {\n  if (!ok) {\n    return \"no\";\n  } else {\n    return \"ok\";\n  }\n}\n`;
  const ignored = "AQUARIUS_PRODUCT_LIVE_IGNORED_42d1\n";
  try {
    await writeFile(join(root, "format", "label.js"), source);
    await writeFile(join(root, ".aqfmtrc.jsonc"), JSON.stringify({
      files: ["format/**"],
      ignore: ["ignored/**"],
      plugins: ["@aquarius/rules"],
      rules: [{ rule: "aquarius/style/prefer-early-return" }],
    }));
    const expectedReturns = await labelResults(source);

    const execution = await runCli(aqfmt, ["--format", "json", "format/label.js"], root);
    const output = parseJson(execution.stdout);
    const transformed = await readFile(join(root, "format", "label.js"), "utf8");
    console.log(JSON.stringify({
      productLive: { tool: "aqfmt", ...execution, stdout: output, transformed },
    }));

    expect(execution.status, execution.stderr).toBe(0);
    expect(output.errors).toEqual([]);
    expect(output.changedFiles).toEqual(["format/label.js"]);
    expect(transformed).not.toBe(source);
    expect(transformed).not.toMatch(/\}\s*else\s*\{/u);
    expect(await labelResults(transformed)).toEqual(expectedReturns);
    expect(await readFile(join(root, "ignored", "private.txt"), "utf8")).toBe(ignored);

    const undo = await runCli(aqfmt, ["--format", "json", "--undo"], root, 30_000);
    const undoOutput = parseJson(undo.stdout);
    console.log(JSON.stringify({ productLive: { tool: "aqfmt --undo", ...undo, stdout: undoOutput } }));
    expect(undo.status, undo.stderr).toBe(0);
    expect(undoOutput.errors).toEqual([]);
    expect(undoOutput.restoredFiles).toEqual(["format/label.js"]);
    expect(await readFile(join(root, "format", "label.js"), "utf8")).toBe(source);
    expect(await readFile(join(root, "ignored", "private.txt"), "utf8")).toBe(ignored);
  } finally {
    await removeProject(root);
  }
}, 170_000);
