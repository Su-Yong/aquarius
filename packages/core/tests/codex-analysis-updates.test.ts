import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runExec } from "../src/ai/codex";
import type { BridgeInput } from "../src/ai/types";

const update = (revision: number, diagnostic: unknown = null) => ({
  type: "aquarius.analysis_update",
  revision,
  diagnostics: [{ id: "finding-1", diagnostic }],
  fileResults: [],
  ruleResults: [],
});

const message = (text: string, type = "item.completed") => ({
  type,
  item: { id: "message", type: "agent_message", text },
});

const runWithEvents = async (
  events: object[],
  onAnalysisUpdate?: (value: unknown) => void,
  onProgress?: (value: string) => void,
): Promise<unknown> => {
  const root = await mkdtemp(join(tmpdir(), "aquarius-analysis-transport-"));
  const executable = join(root, "codex");
  const resultPath = join(root, "result.json");
  const finalResult = { diagnostics: [], completedRuleIds: ["fixture/check"] };
  try {
    await writeFile(
      executable,
      `#!${process.execPath}\n` +
        'const fs = require("node:fs");\n' +
        'process.stdin.on("data", () => {});\n' +
        'process.stdin.on("end", () => {\n' +
        `  for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n` +
        `  fs.writeFileSync(${JSON.stringify(resultPath)}, ${JSON.stringify(JSON.stringify(finalResult))});\n` +
        '  console.log(JSON.stringify({ type: "turn.completed" }));\n' +
        "});\n",
      { mode: 0o755 },
    );
    const input: BridgeInput = {
      projectRoot: root,
      readableFiles: ["first.ts", "second.ts"],
      ignore: [],
      prompt: "Inspect the selected files and emit commentary updates before the final response.",
      ruleResources: { directory: root, files: [] },
      outputSchema: { type: "object" },
      options: {},
      signal: new AbortController().signal,
      onAnalysisUpdate,
      onProgress,
    };
    return await runExec(
      executable,
      input,
      {},
      root,
      root,
      join(root, "schema.json"),
      resultPath,
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test.skipIf(process.platform === "win32")(
  "forwards repeated analysis updates between commands before resolving the final result",
  async () => {
    const first = update(1, { message: "Initial finding" });
    const revised = update(2, { message: "Revised finding" });
    const withdrawn = update(3);
    const events = [
      message(JSON.stringify(first)),
      {
        type: "item.started",
        item: { id: "first", type: "command_execution", command: "cat first.ts" },
      },
      message(JSON.stringify(revised)),
      {
        type: "item.started",
        item: { id: "second", type: "command_execution", command: "cat second.ts" },
      },
      message(JSON.stringify(withdrawn)),
      message('{"diagnostics":[],"completedRuleIds":["fixture/check"]}'),
    ];
    const received: unknown[] = [];
    const order: string[] = [];
    let resolved = false;
    const result = await runWithEvents(
      events,
      (value) => {
        expect(resolved).toBe(false);
        received.push(value);
        order.push(`update-${received.length}`);
      },
      (value) => {
        if (value.startsWith("Inspecting")) order.push(value);
      },
    );
    resolved = true;

    expect(received).toEqual([first, revised, withdrawn]);
    expect(order).toEqual([
      "update-1",
      "Inspecting first.ts",
      "update-2",
      "Inspecting second.ts",
      "update-3",
    ]);
    expect(result).toEqual({ diagnostics: [], completedRuleIds: ["fixture/check"] });
  },
);

test.skipIf(process.platform === "win32")(
  "ignores incomplete, malformed, unrelated, and non-message update lookalikes",
  async () => {
    const encoded = JSON.stringify(update(1));
    const events = [
      message(encoded, "item.started"),
      message(encoded, "item.updated"),
      message("Inspecting files now."),
      message("{invalid-json"),
      message(`\`\`\`json\n${encoded}\n\`\`\``),
      message(`Update: ${encoded}`),
      message(JSON.stringify([update(1)])),
      message("null"),
      message('{"type":"some_other_update","revision":1}'),
      message('{"diagnostics":[],"completedRuleIds":["fixture/check"]}'),
      {
        type: "item.completed",
        item: { type: "reasoning", text: encoded },
      },
      {
        type: "item.completed",
        item: { type: "command_execution", command: "cat first.ts", aggregated_output: encoded },
      },
    ];
    const received: unknown[] = [];
    await runWithEvents(events, (value) => received.push(value));

    expect(received).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "leaves update field validation and revision handling to the analysis receiver",
  async () => {
    const invalidFields = { type: "aquarius.analysis_update", revision: "not-an-integer" };
    const stale = update(1);
    const received: unknown[] = [];
    await runWithEvents(
      [
        message(JSON.stringify(invalidFields)),
        message(JSON.stringify(stale)),
        message(JSON.stringify(stale)),
      ],
      (value) => received.push(value),
    );

    expect(received).toEqual([invalidFields, stale, stale]);
  },
);
