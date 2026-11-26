import { runToolCli } from "@aqtools/core/cli";

import { executeLint } from "../lint/execute";
import type { LintExecutionResult, LintFindings } from "../lint/types";

import { analysisLines } from "./analysis-output";
import { printHuman } from "./output";

const help = `Loads .aqlintrc.json or .aqlintrc.jsonc from the nearest configuration directory.
When both exist in that directory, .aqlintrc.json takes precedence.
Plugins register available rules without activating them. Select named presets
with the preset array, then override rule IDs in the rules object. Lint rule values
are "off", "warn", "error", or [level, options]. Presets apply in order, and direct
rules take precedence. Runs without active rules skip their target files without
invoking AI.
AI execution requires an explicit ai.adapter, such as "@aqtools/codex",
"@aqtools/antigravity", or "./adapter.mjs".`;

export const runCli = (version: string, args = process.argv.slice(2)): Promise<number> =>
  runToolCli<LintFindings, LintExecutionResult>(
    {
      name: "aqlint",
      kind: "lint",
      description: "AI rule-based diagnostics",
      help,
      execute: (options) => executeLint(options),
      printHuman,
      analysisLines,
    },
    version,
    args,
  );
