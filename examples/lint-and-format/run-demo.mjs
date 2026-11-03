import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(exampleRoot, "../..");
const live = process.argv.includes("--live");
const root = await mkdtemp(join(tmpdir(), "aquarius-demo-"));
const original = await readFile(join(exampleRoot, "before.js"), "utf8");
const expected = await readFile(join(exampleRoot, "after.js"), "utf8");

const run = (tool, args = []) => {
  const executable = join(repositoryRoot, "packages", tool, "dist", "cli.mjs");
  const result = spawnSync(process.execPath, [executable, ...args, "example.js"], {
    cwd: root,
    encoding: "utf8",
    timeout: 150_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  console.log(`$ ${tool} ${[...args, "example.js"].join(" ")}`);
  process.stdout.write(result.stdout);
  process.stdout.write(result.stderr);
  console.log(`exit: ${result.status}\n`);
  return result;
};

const observations = async (source) => {
  const { sortedLabels } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const values = [];
  for (const enabled of [true, false, 0, 1, null, undefined]) {
    for (const input of [[], [" pear ", "apple", " banana "]]) {
      const items = [...input];
      values.push({ result: sortedLabels(items, enabled), inputAfter: items });
    }
  }
  return values;
};

try {
  console.log(live
    ? "LIVE CODEX: real model execution requested."
    : "MOCK AI: prepared responses, real Aquarius CLI pipeline. No model is called.");
  await writeFile(join(root, "example.js"), original);
  await copyFile(join(exampleRoot, "mock-ai-bridge.mjs"), join(root, "mock-ai-bridge.mjs"));
  for (const [tool, mode, rule] of [
    ["aqlint", "lint", "aquarius/contracts/no-input-mutation"],
    ["aqfmt", "format", "aquarius/style/prefer-early-return"],
  ]) {
    await writeFile(join(root, `.${tool}rc.jsonc`), JSON.stringify({
      files: ["example.js"],
      plugins: ["@aquarius/rules"],
      ai: live
        ? { options: { model: "gpt-6.1-sol" }, timeoutMs: 120_000 }
        : { adapter: "./mock-ai-bridge.mjs", options: { mode } },
      rules: [{ rule }],
    }, null, 2));
  }
  const lint = run("aqlint");
  assert.equal(await readFile(join(root, "example.js"), "utf8"), original, "lint must not change source");
  console.log("BEFORE FMT\n" + original);
  const format = run("aqfmt");
  const after = await readFile(join(root, "example.js"), "utf8");
  console.log("AFTER FMT\n" + after);
  if (live) {
    process.exitCode = Math.max(lint.status ?? 2, format.status ?? 2);
  } else {
    assert.equal(lint.status, 1);
    assert.equal(format.status, 0);
    assert.equal(after, expected);
    assert.deepEqual(await observations(after), await observations(original));
    console.log("Verified: lint left the source unchanged; fmt matched after.js; 12 input/return observations matched.");
    console.log("The existing input-mutation bug is intentionally preserved by the formatter.");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
