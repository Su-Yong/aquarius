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
} from "@aquarius/core/adapter";
import { asRecord } from "./config-probe";
import { captureStderr, withDiagnostic } from "./diagnostic";
import { featureArguments, type CodexOptions, type CodexSettings } from "./options";
import { configArguments, tomlValue } from "./toml";

const FORBIDDEN_EVENT_ITEMS = new Set(["file_change", "mcp_tool_call", "web_search"]);
const ANALYSIS_TRANSPORT =
  "Send each provisional analysis frame as the sole JSON value in a public commentary message. Codex command output, private reasoning, Markdown fences, and surrounding prose cannot carry a frame.";

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
      const startsToken = before === undefined || /[\s"'`=(:,;|&<>[]/u.test(before);
      const endsToken = after === undefined || /[\s"'`:),;|&<>\]]/u.test(after);
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
  const visible = references.slice(0, 3).join(", ");
  return references.length > 3 ? `${visible} (+${references.length - 3} more)` : visible;
};

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
  child.stdin.on("error", () => {});
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
    const active = [...activeCommands.values()].at(-1);
    input.onProgress?.(
      active ??
        (lastReferences ? `AI analyzing; last referenced: ${lastReferences}` : "AI analyzing"),
    );
  };
  reader.on("line", (line) => {
    if (eventFailure || input.signal.aborted) return;
    let event: Record<string, unknown> | undefined;
    try {
      event = asRecord(JSON.parse(line));
    } catch {}
    if (!event) {
      eventFailure = new AquariusError(
        "CODEX_EVENT_INVALID",
        "Codex emitted invalid JSONL progress output.",
      );
      terminateChild(child);
      return;
    }
    const item = asRecord(event.item);
    if (item && typeof item.type === "string" && FORBIDDEN_EVENT_ITEMS.has(item.type)) {
      eventFailure = new AquariusError(
        "CODEX_TOOL_VIOLATION",
        "Codex attempted a disabled tool or file change.",
      );
      terminateChild(child);
    } else if (event.type === "turn.failed") {
      const message = asRecord(event.error)?.message;
      let errorCode: unknown;
      let detail = message ?? reportedError;
      if (typeof message === "string") {
        try {
          const error = asRecord(asRecord(JSON.parse(message))?.error);
          errorCode = error?.code;
          detail = error?.message ?? message;
        } catch {
          // Codex can report failures as plain text rather than JSON.
        }
      }
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
    } else if (
      event.type === "item.completed" &&
      item?.type === "agent_message" &&
      typeof item.text === "string"
    ) {
      let update: Record<string, unknown> | undefined;
      try {
        update = asRecord(JSON.parse(item.text));
      } catch {
        return;
      }
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
  });

  let detachExitAbort: (() => void) | undefined;
  try {
    const exit = new Promise<number | null>((resolvePromise, rejectPromise) => {
      const onAbort = () => {
        void waitForTermination(child).then(() => resolvePromise(null));
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      detachExitAbort = () => input.signal.removeEventListener("abort", onAbort);
      if (input.signal.aborted) onAbort();
      child.once("error", () =>
        rejectPromise(new AquariusError("CODEX_EXECUTION_FAILED", "Codex could not start.")),
      );
      child.once("close", resolvePromise);
    });
    input.onProgress?.("Starting Codex analysis");
    child.stdin.end(buildSnapshotEnvironmentPrompt(`${ANALYSIS_TRANSPORT}\n\n${input.prompt}`));
    const exitCode = await exit;
    if (input.signal.aborted)
      throw new AquariusError("CODEX_ABORTED", "Codex execution was aborted.");
    if (eventFailure) throw eventFailure;
    if (exitCode !== 0) {
      const output = stderr();
      const maximum = /Input exceeds the maximum length of ([0-9]{1,12}) characters\b/u.exec(
        output,
      )?.[1];
      if (maximum) {
        throw new AquariusError(
          "CODEX_INPUT_TOO_LARGE",
          `Codex rejected an input longer than ${maximum} characters.`,
        );
      }
      const lines = output.split(/\r?\n/u);
      const configError = lines.findIndex((line) =>
        /\b(?:config(?:uration)?|service_tier|toml|unknown field|unknown feature|unrecognized (?:key|field|option))\b/iu.test(
          line,
        ),
      );
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
      result = JSON.parse(content.toString("utf8")) as unknown;
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
