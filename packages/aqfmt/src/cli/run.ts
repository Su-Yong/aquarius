import { parseArgs } from "node:util";
import { startProgress, statusText, type RulePlugin } from "@aquarius/core/internal";
import { executeFormat } from "../format/execute";
import type { FormatAnalysisSnapshot, FormatExecutionResult } from "../format/types";
import { analysisLines, printAnalysisSnapshot } from "./analysis-output";
import { printHuman, safeText } from "./output";

const help = `aqfmt — AI rule-based code transformation

Usage: aqfmt [options] [PATH...]

Options:
  -h, --help                         Show help
  -v, --version                      Show version
  -c, --config PATH                  Use an explicit JSON or JSONC configuration
  -f, --format text|json             Output format (default: text)
      --file-batch-size N             Files per AI request (default: config or 4)
      --max-concurrency N             Concurrent AI requests (default: config or 3)
      --ignore-path PATH             Read an additional ignore file (repeatable)
      --ignore-pattern PATTERN       Add an ignore pattern (repeatable)
      --no-ignore                    Disable compatibility/CLI ignore filters
      --no-error-on-unmatched-pattern
                                     Allow an empty target selection
      --check                        Report needed changes without writing
      --undo                         Undo the last actual formatting run
      --with-node-modules            Include node_modules targets

Loads .aqfmtrc.json or .aqfmtrc.jsonc from the nearest configuration directory.
When both exist in that directory, .aqfmtrc.json takes precedence.
Plugins register available rules. Select presets with preset, then override rules
by ID: true enables a formatter rule, false disables it, and an object sets options.
Runs without active rules skip their target files without invoking AI.
File-scoped rules run in batches and may only replace text in assigned files.
Module or project rules use one request and retain create/delete/move support.
The configured timeout applies to each AI request. Errors prevent all writes.
--no-ignore preserves configuration ignores, Git exclusions, and default exclusions.
AI execution requires an explicit ai.adapter, such as "codex" or "./bridge.mjs".
`;

export const runCli = async (
  version: string,
  builtinPlugins: Record<string, RulePlugin>,
  args = process.argv.slice(2),
): Promise<number> => {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        config: { type: "string", short: "c" },
        format: { type: "string", short: "f", default: "text" },
        "file-batch-size": { type: "string" },
        "max-concurrency": { type: "string" },
        "ignore-path": { type: "string", multiple: true },
        "ignore-pattern": { type: "string", multiple: true },
        "no-ignore": { type: "boolean" },
        "no-error-on-unmatched-pattern": { type: "boolean" },
        check: { type: "boolean" },
        undo: { type: "boolean" },
        "with-node-modules": { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    });

    if (values.help) {
      console.log(help);
      return 0;
    }
    if (values.version) {
      console.log(version);
      return 0;
    }
    if (values.format !== "text" && values.format !== "json") {
      throw new Error("--format must be text or json.");
    }

    const progress = startProgress(true);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    let execution: FormatExecutionResult;
    let latestAnalysis: FormatAnalysisSnapshot | undefined;
    try {
      execution = await executeFormat(
        {
          cwd: process.cwd(),
          configPath: values.config,
          paths: positionals,
          ignorePaths: values["ignore-path"],
          ignorePatterns: values["ignore-pattern"],
          noIgnore: values["no-ignore"],
          withNodeModules: values["with-node-modules"],
          noErrorOnUnmatchedPattern: values["no-error-on-unmatched-pattern"],
          check: values.check,
          undo: values.undo,
          fileBatchSize:
            values["file-batch-size"] === undefined ? undefined : Number(values["file-batch-size"]),
          maxConcurrency:
            values["max-concurrency"] === undefined ? undefined : Number(values["max-concurrency"]),
          signal: controller.signal,
          onProgress: progress.update,
          onAnalysisUpdate: (snapshot) => {
            latestAnalysis = snapshot;
            progress.updateDetails(analysisLines(snapshot));
          },
          onWarning: (message) => {
            progress.clear();
            console.error(statusText(safeText(`aqfmt: ${message}`), "warning", process.stderr));
          },
        },
        builtinPlugins,
      );
    } finally {
      progress.stop();
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }

    if (values.format === "json") console.log(JSON.stringify(execution.result, null, 2));
    else printHuman(execution, values.check === true);
    if (latestAnalysis?.phase === "incomplete") {
      printAnalysisSnapshot(latestAnalysis);
    }
    return execution.exitCode;
  } catch (cause) {
    console.error(
      statusText(
        safeText(`aqfmt: ${cause instanceof Error ? cause.message : String(cause)}`),
        "error",
        process.stderr,
      ),
    );
    console.error("Run aqfmt --help for usage.");
    return 2;
  }
};
