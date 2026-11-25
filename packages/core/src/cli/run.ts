import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { AdapterRunInfo } from "../adapter/types";
import type { AnalysisSnapshot, ToolExecutionOptions } from "../execution/types";
import { errorMessage } from "../shared/errors";
import { printAnalysisSnapshot } from "./analysis-output";
import { formatAdapterRunInfo, safeText } from "./output";
import { startProgress, statusText, type ProgressLine } from "./progress";

const commonOptions = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  config: { type: "string", short: "c" },
  format: { type: "string", short: "f", default: "text" },
  "file-batch-size": { type: "string" },
  "max-concurrency": { type: "string" },
  "ignore-path": { type: "string", multiple: true },
  "ignore-pattern": { type: "string", multiple: true },
  "with-node-modules": { type: "boolean" },
  "no-error-on-unmatched-pattern": { type: "boolean" },
} as const satisfies ParseArgsOptionsConfig;

const commonHelp = `Options:
  -h, --help                         Show help
  -v, --version                      Show version
  -c, --config PATH                  Use an explicit JSON or JSONC configuration
  -f, --format text|json             Output format (default: text)
      --file-batch-size N             Files per AI request (default: config or 4)
      --max-concurrency N             Concurrent AI requests (default: config or 3)
      --ignore-path PATH             Read an additional ignore file (repeatable)
      --ignore-pattern PATTERN       Add an ignore pattern (repeatable)
      --with-node-modules            Include node_modules targets
      --no-error-on-unmatched-pattern
                                     Allow an empty target selection`;

type OptionValues = Record<string, string | boolean | string[] | boolean[] | undefined>;

interface CliTool<Details extends object, Execution> {
  name: string;
  description: string;
  help: string;
  extraOptions?: ParseArgsOptionsConfig;
  extraHelp?: string;
  execute: (options: ToolExecutionOptions<Details>, values: OptionValues) => Promise<Execution>;
  printHuman: (execution: Execution, values: OptionValues) => void;
  analysisLines: (snapshot: AnalysisSnapshot & Details, ai?: AdapterRunInfo) => ProgressLine[];
}

const parseCliArgs = (args: string[], extraOptions: ParseArgsOptionsConfig | undefined) => {
  const parsed = parseArgs({
    args,
    options: { ...extraOptions, ...commonOptions },
    strict: true,
    allowPositionals: true,
  });
  const { format, help, version } = parsed.values;
  if (!help && !version && format !== "text" && format !== "json") {
    throw new Error("--format must be text or json.");
  }
  return parsed;
};

export const runToolCli = async <
  Details extends object,
  Execution extends { result: unknown; exitCode: number },
>(
  tool: CliTool<Details, Execution>,
  version: string,
  args: string[],
): Promise<number> => {
  const reportError = (cause: unknown): void => {
    const message = safeText(`${tool.name}: ${errorMessage(cause)}`);
    console.error(statusText(message, "error", process.stderr));
  };

  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(args, tool.extraOptions);
  } catch (cause) {
    reportError(cause);
    console.error(`Run ${tool.name} --help for usage.`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    const options = tool.extraHelp ? `${commonHelp}\n${tool.extraHelp}` : commonHelp;
    console.log(
      `${tool.name} — ${tool.description}\n\nUsage: ${tool.name} [options] [PATH...]\n\n${options}\n\n${tool.help}`,
    );
    return 0;
  }
  if (values.version) {
    console.log(version);
    return 0;
  }

  try {
    const showProgress = values.format !== "json";
    const progress = startProgress(showProgress);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    let execution: Execution;
    let ai: AdapterRunInfo | undefined;
    let latestAnalysis: (AnalysisSnapshot & Details) | undefined;
    try {
      execution = await tool.execute(
        {
          cwd: process.cwd(),
          configPath: values.config,
          paths: positionals,
          ignorePaths: values["ignore-path"],
          ignorePatterns: values["ignore-pattern"],
          withNodeModules: values["with-node-modules"],
          noErrorOnUnmatchedPattern: values["no-error-on-unmatched-pattern"],
          fileBatchSize:
            values["file-batch-size"] === undefined ? undefined : Number(values["file-batch-size"]),
          maxConcurrency:
            values["max-concurrency"] === undefined ? undefined : Number(values["max-concurrency"]),
          signal: controller.signal,
          ...(showProgress && {
            onProgress: progress.update,
            onAdapterInfo: (info: AdapterRunInfo) => {
              ai = info;
              progress.updateDetails(
                latestAnalysis
                  ? tool.analysisLines(latestAnalysis, info)
                  : [`AI: ${formatAdapterRunInfo(info)}`],
              );
            },
            onAnalysisUpdate: (snapshot: AnalysisSnapshot & Details) => {
              latestAnalysis = snapshot;
              progress.updateDetails(tool.analysisLines(snapshot, ai));
            },
            onWarning: (message: string) => {
              progress.clear();
              console.error(
                statusText(safeText(`${tool.name}: ${message}`), "warning", process.stderr),
              );
            },
          }),
        },
        values,
      );
    } finally {
      progress.stop();
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }

    if (!showProgress) {
      console.log(JSON.stringify(execution.result, null, 2));
      return execution.exitCode;
    }

    tool.printHuman(execution, values);
    if (latestAnalysis?.phase === "incomplete") {
      printAnalysisSnapshot(tool.analysisLines(latestAnalysis, ai));
    }
    return execution.exitCode;
  } catch (cause) {
    reportError(cause);
    return 2;
  }
};
