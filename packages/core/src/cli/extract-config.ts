import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

import { extractConfig } from "../extract/index";
import { serializeExtractedConfig } from "../extract/write";
import { AquariusError, errorMessage } from "../shared/errors";
import { jsonObjectSchema } from "../shared/zod";
import type { JsonObject, ToolKind } from "../shared/types";

import { formatAdapterRunInfo, safeText } from "./output";
import { startProgress, statusText, terminalColors } from "./progress";

const commandName = "extract-config";
const options = {
  help: { type: "boolean", short: "h" },
  config: { type: "string", short: "c" },
  format: { type: "string", short: "f", default: "text" },
  plugin: { type: "string", multiple: true },
  adapter: { type: "string" },
  "ai-options": { type: "string" },
  "timeout-ms": { type: "string" },
  write: { type: "boolean" },
  output: { type: "string" },
  force: { type: "boolean" },
  merge: { type: "boolean" },
  "max-files": { type: "string" },
  "max-concurrency": { type: "string" },
  "ignore-path": { type: "string", multiple: true },
  "ignore-pattern": { type: "string", multiple: true },
  "with-node-modules": { type: "boolean" },
} as const satisfies ParseArgsOptionsConfig;

const help = `Infer rule settings from local source files (default: the current directory).
By default, print configuration JSON to stdout and the report to stderr.

Options:
  -h, --help                         Show help
  -c, --config PATH                  Load an explicit JSON or JSONC configuration
  -f, --format text|json             Output format (default: text)
      --plugin SPECIFIER             Load a plugin from the current directory (repeatable)
      --adapter SPECIFIER            Load an AI adapter from the current directory
      --ai-options JSON              Override the adapter options with a JSON object
      --timeout-ms MS                Override the AI timeout per request
      --write                        Save to the default rc in the current directory
      --output PATH                  Save to PATH, overriding the default --write path
      --force                        Overwrite an existing output file
      --merge                        Merge with an existing JSON output file
      --max-files N                  Cap the source sample (default: 300)
      --max-concurrency N            Limit concurrent AI requests
      --ignore-path PATH             Read an additional ignore file (repeatable)
      --ignore-pattern PATTERN       Add an ignore pattern (repeatable)
      --with-node-modules            Include node_modules sources`;

export const findExtractConfigCommand = (
  args: string[],
  toolOptions: ParseArgsOptionsConfig,
): number | undefined => {
  if (!args.includes(commandName)) return undefined;

  const { tokens } = parseArgs({
    args,
    options: { ...options, ...toolOptions },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "option-terminator") return undefined;
    if (
      token.kind === "option" &&
      Object.hasOwn(toolOptions, token.name) &&
      !Object.hasOwn(options, token.name)
    ) {
      return undefined;
    }
    if (token.kind === "positional") {
      return token.value === commandName ? token.index : undefined;
    }
  }
};

export const runExtractConfigCli = async (
  name: string,
  tool: ToolKind,
  args: string[],
): Promise<number> => {
  const controller = new AbortController();
  const abort = () =>
    controller.abort(new AquariusError("AI_ABORTED", "Extraction was cancelled."));

  try {
    const { values, positionals } = parseArgs({ args, options, allowPositionals: true });
    if (values.help) {
      console.log(`Usage: ${name} ${commandName} [options] [PATH...]\n\n${help}`);
      return 0;
    }
    if (values.format !== "text" && values.format !== "json") {
      throw new Error("--format must be text or json.");
    }

    const isText = values.format === "text";
    const extractionOptions = {
      cwd: process.cwd(),
      paths: positionals,
      configPath: values.config,
      plugins: values.plugin,
      adapter: values.adapter,
      aiOptions: parseAiOptions(values["ai-options"]),
      timeoutMs: parsePositiveInteger("timeout-ms", values["timeout-ms"]),
      write: values.write,
      output: values.output,
      force: values.force,
      merge: values.merge,
      maxFiles: parsePositiveInteger("max-files", values["max-files"]),
      maxConcurrency: parsePositiveInteger("max-concurrency", values["max-concurrency"]),
      ignorePaths: values["ignore-path"],
      ignorePatterns: values["ignore-pattern"],
      withNodeModules: values["with-node-modules"],
      stdoutFd:
        isText && !values.write && values.output === undefined ? process.stdout.fd : undefined,
      signal: controller.signal,
    };

    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    const progress = startProgress(isText);
    const result = await extractConfig(tool, {
      ...extractionOptions,
      onProgress: isText ? progress.update : undefined,
    }).finally(() => {
      progress.stop();
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    });

    controller.signal.throwIfAborted();
    const { config, report } = result;
    if (!isText) {
      console.log(JSON.stringify(result, null, 2));
    } else if (report.outputPath) {
      console.log(formatExtractConfigReport(report, process.stdout));
    } else {
      process.stdout.write(serializeExtractedConfig(config));
      console.error(formatExtractConfigReport(report, process.stderr));
    }
    return 0;
  } catch (cause) {
    const message = reportText(`${name} ${commandName}: ${errorMessage(cause)}`);
    console.error(statusText(message, "error", process.stderr));
    return controller.signal.aborted ? 130 : 2;
  }
};

const parseAiOptions = (value: string | undefined): JsonObject | undefined => {
  if (value === undefined) return undefined;
  try {
    const parsed = jsonObjectSchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
  } catch {
    // Use the same option error for malformed JSON and non-object values.
  }
  throw new Error("--ai-options must be a JSON object.");
};

const parsePositiveInteger = (name: string, value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return parsed;
};

type ExtractionReport = Awaited<ReturnType<typeof extractConfig>>["report"];

export const formatExtractConfigReport = (
  report: ExtractionReport,
  stream: NodeJS.WriteStream = process.stdout,
): string => {
  const color = terminalColors(stream);
  const lines: string[] = [];

  if (report.outputPath) {
    lines.push(
      statusText(
        `${color.bold("Saved")} ${color.cyan(reportText(report.outputPath))}`,
        "success",
        stream,
      ),
    );
  }

  lines.push(
    statusText(
      `Analyzed ${color.bold(String(report.sampledCount))} source files from ${color.cyan(reportText(report.sourceRoot))}`,
      "info",
      stream,
    ),
    statusText(
      `${color.dim("AI:")} ${color.bold(formatAdapterRunInfo(report.ai))}`,
      "info",
      stream,
    ),
  );

  if (report.findings.length > 0) lines.push("");
  for (const finding of report.findings) {
    const id = reportText(finding.ruleId);
    const reason = reportText(finding.reason);
    if (finding.status === "insufficient_evidence") {
      lines.push(
        statusText(
          `${color.yellow("Insufficient evidence")} — ${color.magenta(id)}: ${color.dim(reason)}`,
          "skipped",
          stream,
        ),
      );
      continue;
    }

    lines.push(
      statusText(`${color.magenta(id)}: ${reason}`, finding.mixed ? "warning" : "success", stream),
    );
    if (finding.mixed) {
      lines.push(
        `  ${color.yellow("Warning:")} ${color.yellow("mixed style for")} ${color.magenta(id)}`,
      );
    }
    if (finding.observations) {
      lines.push(`  ${color.dim("Observed:")} ${color.dim(reportText(finding.observations))}`);
    }
  }

  if (report.warnings.length > 0) lines.push("");
  for (const { code, message, ruleIds } of report.warnings) {
    const rules = ruleIds.length ? ` ${color.magenta(`[${reportText(ruleIds.join(", "))}]`)}` : "";
    lines.push(
      statusText(
        `${color.yellow("Warning")} ${color.yellow(reportText(code))}${rules}: ${color.bold(reportText(message))}`,
        "warning",
        stream,
      ),
    );
  }

  return lines.join("\n");
};

const reportText = (value: string): string =>
  safeText(value).replace(/[\r\n\t\u2028\u2029]/gu, " ");
