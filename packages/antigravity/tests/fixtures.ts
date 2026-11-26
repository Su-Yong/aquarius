import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";

import type {
  AdapterExecuteRequest,
  AdapterSession,
  AdapterSessionContext,
} from "@aqtools/core/adapter";
import {
  antigravityAdapter,
  antigravityOptionsSchema,
  type AntigravityOptions,
} from "../src/index";

export const mockTest = test;

interface Invocation {
  args: string[];
  schema: unknown;
  schemaPath: string;
  schemaMode: number;
  stdin: string;
  viewRoot: string;
}

interface FixtureOptions {
  action?: string;
  beforeReadingStdin?: string;
  options?: Partial<Omit<AntigravityOptions, "executable">>;
}

type Context = AdapterSessionContext<ReturnType<typeof antigravityOptionsSchema.parse>>;

export const prepareFixture = async ({
  action = `result({ status: "SUCCESS", structured_output: { ok: true } });`,
  beforeReadingStdin = "",
  options = {},
}: FixtureOptions = {}) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "aquarius-mock-agy-"));
  const sessions: AdapterSession[] = [];
  onTestFinished(async () => {
    try {
      await Promise.all(sessions.map(async (session) => session.dispose()));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const projectRoot = join(root, "source");
  const windows = process.platform === "win32";
  const executable = join(root, windows ? "agy.cmd" : "agy");
  const invocationsPath = join(root, "invocations.jsonl");
  const ruleId = "fixture/check";
  const applicability = "Files declaring a value.";
  const content = JSON.stringify({ ruleId, scope: "file", instructions: { applicability } });
  const contentHash = createHash("sha256").update(content).digest("hex");
  const detailsPath = `.aquarius-rules-fixture/lint-${contentHash}.json`;
  const rule = { ruleId, scope: "file" as const, applicability, content, contentHash, detailsPath };
  await mkdir(join(projectRoot, "ignored"), { recursive: true });
  await Promise.all([
    writeFile(join(projectRoot, "allowed.txt"), "snapshot input"),
    writeFile(join(projectRoot, "ignored", "secret.txt"), "outside the snapshot"),
    writeFile(invocationsPath, ""),
  ]);

  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const viewRoot = process.cwd();
const runRoot = path.dirname(viewRoot);
const projectRoot = ${JSON.stringify(projectRoot)};
const executable = ${JSON.stringify(executable)};
const rulePath = ${JSON.stringify(rule.detailsPath)};
const fixtureRoot = ${JSON.stringify(root)};
const stdout = (text) => fs.writeSync(1, text);
const stderr = (text) => fs.writeSync(2, text);
const emit = (event) => stdout(JSON.stringify(event) + "\\n");
const step = (step_update) => emit({ event: "step_update", step_update });
const result = (result) => emit({ event: "result", result });
const hold = () => setInterval(() => {}, 1000);
${beforeReadingStdin}
async function run() {
  process.stdin.setEncoding("utf8");
  let stdin = "";
  for await (const chunk of process.stdin) stdin += chunk;

  const schemaPath = args[args.indexOf("--json-schema") + 1];
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const schemaMode = fs.statSync(schemaPath).mode & 0o777;
  fs.appendFileSync(${JSON.stringify(invocationsPath)}, JSON.stringify({
    args, schema, schemaPath, schemaMode, stdin, viewRoot,
  }) + "\\n");
  ${action}
}
run().catch((error) => { stderr(String(error)); process.exitCode = 1; });
`;
  if (windows) {
    const scriptPath = join(root, "mock agy.cjs");
    await writeFile(scriptPath, script);
    await writeFile(executable, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    await writeFile(executable, script, { mode: 0o755 });
  }

  const context: Context = {
    projectRoot,
    readableFiles: ["allowed.txt"],
    ruleResources: [rule],
    options: antigravityOptionsSchema.parse({ ...options, executable }),
    signal: new AbortController().signal,
  };
  const createSession = async (overrides?: Partial<Context>) => {
    const session = await antigravityAdapter.createSession({ ...context, ...overrides });
    sessions.push(session);
    return session;
  };
  const request = (overrides?: Partial<AdapterExecuteRequest>): AdapterExecuteRequest => ({
    ...context,
    prompt: "Inspect the approved file.\nReturn a JSON response.",
    outputSchema: { type: "object" },
    signal: AbortSignal.timeout(10_000),
    ...overrides,
  });
  const invocations = async (): Promise<Invocation[]> =>
    (await readFile(invocationsPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Invocation);

  return { context, createSession, executable, invocations, projectRoot, request, root, rule };
};
