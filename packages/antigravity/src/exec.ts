import { createInterface } from "node:readline";

import {
  AquariusError,
  buildSnapshotEnvironmentPrompt,
  errorMessage,
  isNodeError,
  isPlainObject,
  waitForTermination,
  type AdapterExecuteRequest,
  type JsonObject,
} from "@aqtools/core/adapter";

import { captureStderr, createPathMatcher, withDiagnostic } from "./diagnostic";
import type { AntigravityOptions } from "./options";
import { spawnAntigravity } from "./process";
import { assertNoSnapshotPath, createStepHandler, parseJson } from "./stream";

const NO_PROVISIONAL_UPDATES =
  "This adapter does not support provisional analysis updates. Never emit intermediate aquarius.analysis_update frames or progress messages; return only the final JSON value matching the output schema.";

export const runExec = async (
  executable: string,
  input: AdapterExecuteRequest,
  options: AntigravityOptions,
  viewRoot: string,
  runRoot: string,
  schemaPath: string,
  diagnosticPaths: readonly string[],
): Promise<unknown> => {
  const { signal, onProgress } = input;
  const snapshotPaths = createPathMatcher([viewRoot, runRoot]);
  const executionError = (message: string, detail?: string) =>
    new AquariusError(
      "ANTIGRAVITY_EXECUTION_FAILED",
      withDiagnostic(message, detail, diagnosticPaths),
    );
  const abortedError = () =>
    new AquariusError("ANTIGRAVITY_ABORTED", "Antigravity execution was aborted.");

  if (signal.aborted) throw abortedError();
  onProgress?.("Starting Antigravity analysis");
  if (signal.aborted) throw abortedError();

  let runningProcess: ReturnType<typeof spawnAntigravity>;
  try {
    runningProcess = spawnAntigravity(executable, commandArguments(options, schemaPath), viewRoot);
  } catch (cause) {
    throw executionError("Antigravity could not start.", errorMessage(cause));
  }

  const { child, terminate } = runningProcess;
  const stderr = captureStderr(child.stderr);
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const handleStep = createStepHandler(input, viewRoot);
  let result: JsonObject | undefined;
  let stopReading = false;
  let detachAbort: (() => void) | undefined;

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const abort = () => {
        terminate();
        resolve(null);
      };
      signal.addEventListener("abort", abort, { once: true });
      detachAbort = () => signal.removeEventListener("abort", abort);

      child.once("close", resolve);
      child.on("error", (error) =>
        reject(executionError("Antigravity could not start.", error.message)),
      );
      // A child that exits before reading the prompt reports its error on the process streams.
      child.stdin.on("error", (error) => {
        if (
          isNodeError(error, "EPIPE") ||
          isNodeError(error, "ECONNRESET") ||
          isNodeError(error, "EOF") ||
          child.exitCode !== null ||
          child.signalCode !== null
        ) {
          return;
        }
        stopReading = true;
        reject(executionError("Could not send the Antigravity prompt.", error.message));
      });
      reader.on("error", (error) =>
        reject(executionError("Could not read the Antigravity stream.", error.message)),
      );
      reader.on("line", (line) => {
        if (stopReading || signal.aborted) return;

        try {
          const event = parseJson(line);
          if (!isPlainObject(event)) {
            throw new AquariusError(
              "ANTIGRAVITY_EVENT_INVALID",
              "Antigravity emitted invalid NDJSON output.",
            );
          }

          if (event.event === "step_update" && isPlainObject(event.step_update)) {
            handleStep(event.step_update);
          } else if (event.event === "result" && isPlainObject(event.result)) {
            result = event.result;
            if (result.status === "SUCCESS") onProgress?.("Reading Antigravity response");
          }
        } catch (error) {
          stopReading = true;
          reader.close();
          terminate();
          reject(error);
        }
      });

      if (signal.aborted) abort();
      else child.stdin.end(promptFrame(input));
    });

    if (signal.aborted) throw abortedError();
    if (result && result.status !== "SUCCESS") {
      const errorDetail =
        typeof result.error === "string"
          ? result.error.trim() || undefined
          : result.error !== undefined
            ? JSON.stringify(result.error)
            : undefined;
      const statusDetail =
        typeof result.status === "string" && result.status.trim() !== ""
          ? `status=${result.status}`
          : undefined;
      const detail = [errorDetail ?? statusDetail, stderr()].filter(Boolean).join("\n");
      throw executionError("Antigravity reported an execution failure.", detail);
    }
    if (exitCode !== 0) {
      throw executionError(
        `Antigravity exited unsuccessfully (${exitCode ?? "signal"}).`,
        stderr(),
      );
    }

    const output =
      result?.structured_output !== undefined
        ? result.structured_output
        : typeof result?.response === "string"
          ? parseJson(result.response)
          : undefined;
    if (output === undefined) {
      throw new AquariusError(
        "ANTIGRAVITY_RESPONSE_INVALID",
        "Antigravity did not return a valid final JSON value.",
      );
    }
    assertNoSnapshotPath(output, snapshotPaths);
    return output;
  } catch (cause) {
    if (signal.aborted) throw abortedError();
    throw cause;
  } finally {
    reader.close();
    detachAbort?.();
    terminate();
    await waitForTermination(child);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
};

const commandArguments = (options: AntigravityOptions, schemaPath: string): string[] => {
  const args = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--json-schema",
    schemaPath,
    "--disable-slash-commands",
  ];
  if (options.sandbox !== false) args.push("--sandbox");

  const { model, effort, agent, mode } = options;
  for (const [name, value] of Object.entries({ model, effort, agent, mode })) {
    if (value === undefined) continue;
    if (value.startsWith("-")) args.push(`--${name}=${value}`);
    else args.push(`--${name}`, value);
  }
  return args;
};

const promptFrame = (input: AdapterExecuteRequest): string => {
  const prompt = buildSnapshotEnvironmentPrompt(input.prompt);
  const content = `${NO_PROVISIONAL_UPDATES}\n\n${prompt}`;
  return `${JSON.stringify({ event: "user", message: { content } })}\n`;
};
