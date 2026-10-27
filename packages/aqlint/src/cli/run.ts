import { parseArgs } from "node:util";
import { startProgress, statusText, type RulePlugin } from "@aquarius/core/internal";
import { executeLint } from "../lint/execute";
import type { LintExecutionResult } from "../lint/types";
import { printHuman, safeText } from "./output";

const help = `aqlint — AI rule-based diagnostics

Usage: aqlint [options] [PATH...]

Options:
  -h, --help                         Show help
  -v, --version                      Show version
  -c, --config PATH                  Use an explicit JSONC configuration
  -f, --format text|json             Output format (default: text)
      --ignore-path PATH             Read an additional ignore file (repeatable)
      --ignore-pattern PATTERN       Add an ignore pattern (repeatable)
      --no-ignore                    Disable compatibility/CLI ignore filters
      --no-error-on-unmatched-pattern
                                     Allow an empty target selection

Only explicitly configured rules run. Empty rule lists do not invoke AI.
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

    const progress = startProgress(values.format === "text");
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    let execution: LintExecutionResult;
    try {
      execution = await executeLint({
        cwd: process.cwd(),
        configPath: values.config,
        paths: positionals,
        ignorePaths: values["ignore-path"],
        ignorePatterns: values["ignore-pattern"],
        noIgnore: values["no-ignore"],
        noErrorOnUnmatchedPattern: values["no-error-on-unmatched-pattern"],
        signal: controller.signal,
        onProgress: progress.update,
      }, builtinPlugins);
    } finally {
      progress.stop();
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
    if (values.format === "json") console.log(JSON.stringify(execution.result, null, 2));
    else printHuman(execution);
    return execution.exitCode;
  } catch (cause) {
    console.error(statusText(safeText(`aqlint: ${cause instanceof Error ? cause.message : String(cause)}`), "error", process.stderr));
    console.error("Run aqlint --help for usage.");
    return 2;
  }
};
