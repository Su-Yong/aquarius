import { parseArgs } from "node:util";
import { startProgress, statusText, type RulePlugin } from "@aquarius/core/internal";
import { executeLint } from "../lint/execute";
import type { LintAnalysisSnapshot, LintExecutionResult } from "../lint/types";
import { analysisLines, printAnalysisSnapshot } from "./analysis-output";
import { printHuman, safeText } from "./output";

const help = `aqlint — AI rule-based diagnostics

Usage: aqlint [options] [PATH...]

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

Loads .aqlintrc.json or .aqlintrc.jsonc from the nearest configuration directory.
When both exist in that directory, .aqlintrc.json takes precedence.
Plugins register available rules without activating them. Select named presets
with the preset array, then override rule IDs in the rules object. Lint rule values
are "off", "warn", "error", or [level, options]. Presets apply in order, and direct
rules take precedence. Runs without active rules skip their target files without
invoking AI.
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
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    let execution: LintExecutionResult;
    let latestAnalysis: LintAnalysisSnapshot | undefined;
    try {
      execution = await executeLint(
        {
          cwd: process.cwd(),
          configPath: values.config,
          paths: positionals,
          ignorePaths: values["ignore-path"],
          ignorePatterns: values["ignore-pattern"],
          noIgnore: values["no-ignore"],
          noErrorOnUnmatchedPattern: values["no-error-on-unmatched-pattern"],
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
            console.error(statusText(safeText(`aqlint: ${message}`), "warning", process.stderr));
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
    else printHuman(execution);
    if (latestAnalysis?.phase === "incomplete") {
      printAnalysisSnapshot(latestAnalysis);
    }
    return execution.exitCode;
  } catch (cause) {
    console.error(
      statusText(
        safeText(`aqlint: ${cause instanceof Error ? cause.message : String(cause)}`),
        "error",
        process.stderr,
      ),
    );
    console.error("Run aqlint --help for usage.");
    return 2;
  }
};
