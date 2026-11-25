import { runToolCli } from "@aquarius/core/cli";
import { executeFormat } from "../format/execute";
import type { FormatExecutionResult, FormatSnapshotDetails } from "../format/types";
import { analysisLines } from "./analysis-output";
import { printHuman } from "./output";

const help = `Loads .aqfmtrc.json or .aqfmtrc.jsonc from the nearest configuration directory.
When both exist in that directory, .aqfmtrc.json takes precedence.
Plugins register available rules. Select presets with preset, then override rules
by ID: true enables a formatter rule, false disables it, and an object sets options.
Runs without active rules skip their target files without invoking AI.
File-scoped rules run in batches and may only replace text in assigned files.
Module or project rules use one request and retain create/delete/move support.
The configured timeout applies to each AI request. Errors prevent all writes.
AI execution requires an explicit ai.adapter, such as "@aquarius/codex" or "./adapter.mjs".`;

export const runCli = (version: string, args = process.argv.slice(2)): Promise<number> =>
  runToolCli<FormatSnapshotDetails, FormatExecutionResult>(
    {
      name: "aqfmt",
      description: "AI rule-based code transformation",
      help,
      extraOptions: { check: { type: "boolean" }, undo: { type: "boolean" } },
      extraHelp: `      --check                        Report needed changes without writing
      --undo                         Undo the last actual formatting run`,
      execute: (options, values) =>
        executeFormat({ ...options, check: values.check === true, undo: values.undo === true }),
      printHuman: (execution, values) => printHuman(execution, values.check === true),
      analysisLines,
    },
    version,
    args,
  );
