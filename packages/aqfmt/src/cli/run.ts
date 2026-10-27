import { parseArgs } from "node:util";
import { startProgress, statusText, type RulePlugin } from "@aquarius/core/internal";
import { executeFormat } from "../format/execute";
import type { FormatExecutionResult } from "../format/types";
import { printHuman, safeText } from "./output";

const help = `aqfmt — AI rule-based code transformation

Usage: aqfmt [options] [PATH...]

Options:
  -h, --help                         Show help
  -v, --version                      Show version
  -c, --config PATH                  Use an explicit JSONC configuration
  -f, --format text|json             Output format (default: text)
      --ignore-path PATH             Read an additional ignore file (repeatable)
      --no-error-on-unmatched-pattern
                                     Allow an empty target selection
      --check                        Report needed changes without writing
      --undo                         Undo the last actual formatting run
      --with-node-modules            Include node_modules targets

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

    const progress = startProgress(values.format === "text");
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    let execution: FormatExecutionResult;
    try {
      execution = await executeFormat({
        cwd: process.cwd(),
        configPath: values.config,
        paths: positionals,
        ignorePaths: values["ignore-path"],
        withNodeModules: values["with-node-modules"],
        noErrorOnUnmatchedPattern: values["no-error-on-unmatched-pattern"],
        check: values.check,
        undo: values.undo,
        signal: controller.signal,
        onProgress: progress.update,
      }, builtinPlugins);
    } finally {
      progress.stop();
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }

    if (values.format === "json") console.log(JSON.stringify(execution.result, null, 2));
    else printHuman(execution, values.check === true);
    return execution.exitCode;
  } catch (cause) {
    console.error(statusText(safeText(`aqfmt: ${cause instanceof Error ? cause.message : String(cause)}`), "error", process.stderr));
    console.error("Run aqfmt --help for usage.");
    return 2;
  }
};
