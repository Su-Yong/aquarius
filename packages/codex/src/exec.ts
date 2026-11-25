import { spawn } from "node:child_process";
import { basename } from "node:path";
import { createInterface } from "node:readline";

import {
  AquariusError,
  attachAbort,
  buildSnapshotEnvironmentPrompt,
  readStableRegularFile,
  terminateChild,
  toPosix,
  waitForTermination,
  type AdapterExecuteRequest,
} from "@aqtools/core/adapter";

import { asRecord } from "./config-probe";
import { captureStderr, withDiagnostic } from "./diagnostic";
import { featureArguments, type CodexOptions, type CodexSettings } from "./options";
import { configArguments, tomlValue } from "./toml";

const FORBIDDEN_EVENT_ITEMS = new Set(["file_change", "mcp_tool_call", "web_search"]);
const MAX_VISIBLE_REFERENCES = 3;
const COMMAND_TOKEN_START = /[\s"'`=(:,;|&<>[]/u;
const COMMAND_TOKEN_END = /[\s"'`:),;|&<>\]]/u;
const INPUT_LENGTH_ERROR = /Input exceeds the maximum length of ([0-9]{1,12}) characters\b/u;
const STDERR_LINE_BREAK = /\r?\n/u;
const CONFIG_ERROR_PATTERN =
  /\b(?:config(?:uration)?|service_tier|toml|unknown field|unknown feature|unrecognized (?:key|field|option))\b/iu;
const ANALYSIS_TRANSPORT =
  "Send each provisional analysis frame as the sole JSON value in a public commentary message. Codex command output, private reasoning, Markdown fences, and surrounding prose cannot carry a frame.";

export const runExec = async (
  executable: string,
  input: AdapterExecuteRequest,
  options: CodexSettings & Pick<CodexOptions, "ephemeral" | "features">,
  viewRoot: string,
  runRoot: string,
  schemaPath: string,
  resultPath: string,
  overrides: readonly string[],
  diagnosticPaths: readonly string[] = [viewRoot, runRoot, input.projectRoot, executable],
): Promise<unknown> => {
  const args = [
    "exec",
    "--strict-config",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "--color",
    "never",
    "-C",
    viewRoot,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    resultPath,
    ...configArguments(overrides),
    ...featureArguments(options.features),
  ];
  if (options.ephemeral !== false) args.push("--ephemeral");
  if (options.model !== undefined) args.push("--model", options.model);

  const settings = {
    service_tier: options.serviceTier,
    model_verbosity: options.verbosity,
    model_reasoning_effort: options.reasoningEffort,
    model_reasoning_summary: options.reasoningSummary,
    model_context_window: options.contextWindow,
    model_auto_compact_token_limit: options.autoCompactTokenLimit,
    model_auto_compact_token_limit_scope: options.autoCompactTokenLimitScope,
  };
  for (const [key, value] of Object.entries(settings)) {
    if (value !== undefined) args.push("-c", `${key}=${tomlValue(value)}`);
  }
  args.push("-");

  if (input.signal.aborted)
    throw new AquariusError("CODEX_ABORTED", "Codex execution was aborted.");

  const child = spawn(executable, args, {
    cwd: viewRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const detachAbort = attachAbort(child, input.signal);
  const stderr = captureStderr(child.stderr);
  // An early child exit also closes stdin. Its exit status provides the execution error.
  const ignoreStdinError = () => {};
  child.stdin.on("error", ignoreStdinError);
  const reader = createInterface({ input: child.stdout });

  const internalPaths = [runRoot, viewRoot].map((path) => {
    const normalized = toPosix(path);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  });
  let eventFailure: AquariusError | undefined;
  let reportedError: string | true | undefined;
  let lastReferences = "";
  const activeCommands = new Map<string, string>();

  const reportAnalysis = () => {
    const activeCommand = [...activeCommands.values()].at(-1);
    input.onProgress?.(
      activeCommand ??
        (lastReferences ? `AI analyzing; last referenced: ${lastReferences}` : "AI analyzing"),
    );
  };

  const handleProgressLine = (line: string) => {
    if (eventFailure || input.signal.aborted) return;

    const event = parseProgressRecord(() => line);
    if (!event) {
      eventFailure = new AquariusError(
        "CODEX_EVENT_INVALID",
        "Codex emitted invalid JSONL progress output.",
      );
      terminateChild(child);
      return;
    }

    const item = asRecord(event.item);
    const attemptedForbiddenAction =
      item && typeof item.type === "string" && FORBIDDEN_EVENT_ITEMS.has(item.type);
    if (attemptedForbiddenAction) {
      eventFailure = new AquariusError(
        "CODEX_TOOL_VIOLATION",
        "Codex attempted a disabled tool or file change.",
      );
      terminateChild(child);
      return;
    }

    if (event.type === "turn.failed") {
      const message = asRecord(event.error)?.message;
      const { errorCode, detail } = describeTurnFailure(message, reportedError);
      const summary =
        errorCode === "model_not_found"
          ? "The configured Codex model is unavailable for this account. Choose a supported model in Codex or Aquarius configuration."
          : "Codex reported an execution failure.";
      eventFailure = new AquariusError(
        "CODEX_EXECUTION_FAILED",
        withDiagnostic(summary, detail, diagnosticPaths),
      );
    } else if (event.type === "error") {
      reportedError = typeof event.message === "string" ? event.message : true;
    } else if (event.type === "turn.completed") {
      reportedError = undefined;
      input.onProgress?.("Reading Codex response");
    } else if (isCompletedAgentMessage(event, item)) {
      const update = parseProgressRecord(() => item.text);
      if (update?.type !== "aquarius.analysis_update") return;

      if (containsPath(update, internalPaths)) {
        eventFailure = new AquariusError(
          "CODEX_RESPONSE_INVALID",
          "Codex response exposed an internal snapshot path.",
        );
        terminateChild(child);
        return;
      }

      input.onAnalysisUpdate?.(update);
    } else if (item?.type === "command_execution" && typeof item.command === "string") {
      const key = typeof item.id === "string" ? item.id : item.command;
      const referenced = commandReferences(item.command, input, viewRoot);
      if (referenced) {
        lastReferences = referenced;
      }

      if (event.type === "item.started" || event.type === "item.updated") {
        activeCommands.set(key, referenced ? `Inspecting ${referenced}` : "Inspecting project");
      } else if (event.type === "item.completed") {
        activeCommands.delete(key);
      }

      reportAnalysis();
    } else if (event.type === "turn.started" || item?.type === "reasoning") {
      reportAnalysis();
    }
  };
  reader.on("line", handleProgressLine);

  let detachExitAbort: (() => void) | undefined;
  try {
    const observeChildExit = (
      resolvePromise: (exitCode: number | null) => void,
      rejectPromise: (error: AquariusError) => void,
    ) => {
      const onAbort = () => {
        const resolveAbortedExit = () => resolvePromise(null);
        void waitForTermination(child).then(resolveAbortedExit);
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      detachExitAbort = () => input.signal.removeEventListener("abort", onAbort);
      if (input.signal.aborted) onAbort();

      const rejectStartFailure = () =>
        rejectPromise(new AquariusError("CODEX_EXECUTION_FAILED", "Codex could not start."));
      child.once("error", rejectStartFailure);
      child.once("close", resolvePromise);
    };
    const exit = new Promise<number | null>(observeChildExit);

    input.onProgress?.("Starting Codex analysis");
    const prompt = input.onAnalysisUpdate
      ? `${ANALYSIS_TRANSPORT}\n\n${input.prompt}`
      : input.prompt;
    child.stdin.end(buildSnapshotEnvironmentPrompt(prompt));
    const exitCode = await exit;

    if (input.signal.aborted)
      throw new AquariusError("CODEX_ABORTED", "Codex execution was aborted.");
    if (eventFailure) throw eventFailure;
    if (exitCode !== 0) {
      const output = stderr();
      const maximum = INPUT_LENGTH_ERROR.exec(output)?.[1];
      if (maximum) {
        throw new AquariusError(
          "CODEX_INPUT_TOO_LARGE",
          `Codex rejected an input longer than ${maximum} characters.`,
        );
      }

      const lines = output.split(STDERR_LINE_BREAK);
      const configError = lines.findIndex((line) => CONFIG_ERROR_PATTERN.test(line));
      const detail = configError === -1 ? reportedError : lines.slice(configError).join("\n");
      throw new AquariusError(
        "CODEX_EXECUTION_FAILED",
        withDiagnostic(
          `Codex exited unsuccessfully (${exitCode ?? "signal"}).`,
          detail,
          diagnosticPaths,
        ),
      );
    }
    if (reportedError)
      throw new AquariusError(
        "CODEX_EXECUTION_FAILED",
        withDiagnostic("Codex reported an execution failure.", reportedError, diagnosticPaths),
      );

    let result: unknown;
    try {
      const { content } = await readStableRegularFile(runRoot, basename(resultPath), input.signal);
      const resultText = content.toString("utf8");
      result = JSON.parse(resultText) as unknown;
    } catch {
      if (input.signal.aborted)
        throw new AquariusError("CODEX_ABORTED", "Codex execution was aborted.");
      throw new AquariusError(
        "CODEX_RESPONSE_INVALID",
        "Codex did not return a valid final JSON value.",
      );
    }

    if (containsPath(result, internalPaths)) {
      throw new AquariusError(
        "CODEX_RESPONSE_INVALID",
        "Codex response exposed an internal snapshot path.",
      );
    }

    return result;
  } finally {
    reader.close();
    detachExitAbort?.();
    detachAbort();

    terminateChild(child);
    await waitForTermination(child);

    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
};

const containsPath = (value: unknown, paths: readonly string[]): boolean => {
  if (typeof value === "string") {
    const pathText = toPosix(value);
    const candidate = process.platform === "win32" ? pathText.toLowerCase() : pathText;
    return paths.some((path) => candidate.includes(path));
  }
  if (Array.isArray(value)) return value.some((item) => containsPath(item, paths));
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, item]) => containsPath(key, paths) || containsPath(item, paths),
    );
  }
  return false;
};

const commandMentionsPath = (command: string, path: string, viewRoot: string): boolean => {
  const candidates = [path, `./${path}`, `${toPosix(viewRoot)}/${path}`];

  for (const candidate of candidates) {
    let index = command.indexOf(candidate);
    while (index !== -1) {
      const before = command[index - 1];
      const after = command[index + candidate.length];
      const startsToken = before === undefined || COMMAND_TOKEN_START.test(before);
      const endsToken = after === undefined || COMMAND_TOKEN_END.test(after);

      if (startsToken && endsToken) {
        return true;
      }

      index = command.indexOf(candidate, index + candidate.length);
    }
  }

  return false;
};

const commandReferences = (
  command: string,
  input: AdapterExecuteRequest,
  viewRoot: string,
): string => {
  const references = [
    ...input.readableFiles.filter((path) => commandMentionsPath(command, path, viewRoot)),
    ...input.ruleResources
      .filter(({ detailsPath }) => commandMentionsPath(command, detailsPath, viewRoot))
      .map(({ ruleId }) => `rule ${ruleId}`),
  ];

  const visible = references.slice(0, MAX_VISIBLE_REFERENCES).join(", ");
  const omittedCount = references.length - MAX_VISIBLE_REFERENCES;

  return omittedCount > 0 ? `${visible} (+${omittedCount} more)` : visible;
};

const parseProgressRecord = (readText: () => string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(readText());
    return asRecord(parsed);
  } catch {
    return undefined;
  }
};

const describeTurnFailure = (message: unknown, reportedError: string | true | undefined) => {
  if (typeof message !== "string")
    return { errorCode: undefined, detail: message ?? reportedError };

  try {
    const parsed = asRecord(JSON.parse(message));
    const error = asRecord(parsed?.error);
    return { errorCode: error?.code, detail: error?.message ?? message };
  } catch {
    // Codex can report failures as plain text rather than JSON.
    return { errorCode: undefined, detail: message };
  }
};

const isCompletedAgentMessage = (
  event: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
): item is Record<string, unknown> & { text: string } => {
  const completedAgentMessage =
    event.type === "item.completed" &&
    item?.type === "agent_message" &&
    typeof item.text === "string";
  return completedAgentMessage;
};
