import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  AquariusError,
  createReadonlySnapshot,
  defineAdapter,
  isNodeError,
  writeRuleResources,
  type AdapterExecuteRequest,
  type AdapterRunInfo,
  type JsonObject,
  type SessionAdapter,
} from "@aqtools/core/adapter";

import { withDiagnostic } from "./diagnostic";
import { runExec } from "./exec";
import { resolveAntigravityExecutable } from "./executable";
import { antigravityOptionsSchema, type AntigravityOptions } from "./options";

const SCHEMA_FILE_MODE = 0o600;
const SCHEMA_DELETE_RETRIES = 3;
const SCHEMA_DELETE_RETRY_DELAY_MS = 100;
const RETRYABLE_SCHEMA_DELETE_ERRORS = ["EBUSY", "EMFILE", "ENFILE", "EPERM"];

const snapshotErrorCodes: Record<string, string> = {
  AI_ABORTED: "ANTIGRAVITY_ABORTED",
  FILE_PATH_INVALID: "ANTIGRAVITY_READABLE_PATH_INVALID",
  FILE_PATH_UNSUPPORTED: "ANTIGRAVITY_READABLE_PATH_UNSUPPORTED",
  FILE_SOURCE_CHANGED: "ANTIGRAVITY_SOURCE_CHANGED",
  SNAPSHOT_CONFLICT: "ANTIGRAVITY_READABLE_PATH_INVALID",
  SNAPSHOT_ROOT_INVALID: "ANTIGRAVITY_PROJECT_ROOT_INVALID",
};

const resourceErrorCodes: Record<string, string> = {
  AI_ABORTED: "ANTIGRAVITY_ABORTED",
  INVALID_RULE_RESOURCE: "ANTIGRAVITY_RULE_RESOURCES_INVALID",
  RULE_RESOURCE_CHANGED: "ANTIGRAVITY_RULE_RESOURCE_CHANGED",
  RULE_RESOURCE_CONFLICT: "ANTIGRAVITY_RULE_RESOURCE_CONFLICT",
};

export {
  antigravityOptionsSchema,
  type AntigravityMode,
  type AntigravityOptions,
  type EffortHint,
} from "./options";

export const antigravityAdapter: SessionAdapter<ReturnType<typeof antigravityOptionsSchema.parse>> =
  defineAdapter({
    id: "antigravity",
    optionsSchema: antigravityOptionsSchema,
    async createSession(context) {
      const { readableFiles, ruleResources, options, signal, onProgress } = context;
      assertActive(signal);

      onProgress?.("Locating Antigravity");
      const executable = await resolveAntigravityExecutable(options.executable).catch(
        (cause: unknown) => {
          assertActive(signal);
          throw cause;
        },
      );
      assertActive(signal);

      const projectRoot = await realpath(context.projectRoot).catch(() => {
        assertActive(signal);
        throw new AquariusError(
          "ANTIGRAVITY_PROJECT_ROOT_INVALID",
          "Antigravity could not resolve the project root.",
        );
      });
      const runRoot = await realpath(tmpdir())
        .then((tempRoot) => mkdtemp(join(tempRoot, "aquarius-antigravity-")))
        .catch(() => {
          assertActive(signal);
          throw new AquariusError(
            "ANTIGRAVITY_EXECUTION_FAILED",
            "Antigravity could not create its temporary directory.",
          );
        });
      const viewRoot = join(runRoot, "project");
      const paths = [viewRoot, runRoot, projectRoot, resolve(context.projectRoot), executable];
      if (options.executable) paths.push(options.executable);
      const cleanup = () =>
        rm(runRoot, { recursive: true, force: true }).catch(() => {
          throw new AquariusError(
            "ANTIGRAVITY_EXECUTION_FAILED",
            "Antigravity could not remove its temporary directory.",
          );
        });

      try {
        assertActive(signal);
        try {
          await mkdir(viewRoot);
          onProgress?.(`Preparing snapshot (${readableFiles.length} context files)`);
          await createReadonlySnapshot(projectRoot, readableFiles, viewRoot, signal, onProgress);
        } catch (cause) {
          assertActive(signal);
          const summary = "Antigravity could not prepare its project snapshot.";
          const mapped = mapPreparationError(cause, snapshotErrorCodes, summary, paths);
          throw mapped ?? new AquariusError("ANTIGRAVITY_EXECUTION_FAILED", summary);
        }

        onProgress?.(`Preparing rule files (${ruleResources.length} rules)`);
        try {
          await writeRuleResources(ruleResources, viewRoot, signal);
        } catch (cause) {
          assertActive(signal);
          const summary = "Antigravity could not prepare its rule resource files.";
          const mapped = mapPreparationError(cause, resourceErrorCodes, summary, paths);
          throw mapped ?? new AquariusError("ANTIGRAVITY_RULE_RESOURCES_FAILED", summary);
        }

        const activeRequests = new Set<Promise<unknown>>();
        const disposal = new AbortController();
        let disposed: Promise<void> | undefined;

        const execute = async (request: AdapterExecuteRequest): Promise<unknown> => {
          const requestSignal = AbortSignal.any([signal, request.signal, disposal.signal]);
          assertActive(requestSignal);

          const schemaPath = await createOutputSchema(runRoot, request.outputSchema, requestSignal);
          let output: unknown;
          try {
            const input = {
              ...request,
              projectRoot,
              readableFiles,
              ruleResources,
              signal: requestSignal,
            };
            output = await runExec(
              executable,
              input,
              options,
              viewRoot,
              runRoot,
              schemaPath,
              paths,
            );
          } catch (cause) {
            await removeOutputSchema(schemaPath).catch(() => {});
            throw cause;
          }
          await removeOutputSchema(schemaPath);
          return output;
        };

        return {
          info: antigravityRunInfo(options),
          async execute(request) {
            const pending = execute(request);
            activeRequests.add(pending);
            try {
              return await pending;
            } finally {
              activeRequests.delete(pending);
            }
          },
          dispose() {
            if (!disposed) {
              disposal.abort();
              disposed = Promise.allSettled(activeRequests).then(cleanup);
            }
            return disposed;
          },
        };
      } catch (cause) {
        await cleanup().catch(() => {});
        throw cause;
      }
    },
  });

export default antigravityAdapter;

const assertActive = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new AquariusError("ANTIGRAVITY_ABORTED", "Antigravity execution was aborted.");
  }
};

const createOutputSchema = async (
  runRoot: string,
  outputSchema: JsonObject,
  signal: AbortSignal,
): Promise<string> => {
  const schemaPath = join(runRoot, `schema-${randomUUID()}.json`);
  const schemaWriteFailure = () => {
    assertActive(signal);
    return new AquariusError(
      "ANTIGRAVITY_EXECUTION_FAILED",
      "Antigravity could not prepare its output schema.",
    );
  };
  const schema = await open(schemaPath, "wx", SCHEMA_FILE_MODE).catch(() => {
    throw schemaWriteFailure();
  });

  try {
    try {
      await schema.writeFile(JSON.stringify(outputSchema), { signal });
    } finally {
      await schema.close();
    }
  } catch {
    await removeOutputSchema(schemaPath).catch(() => {});
    throw schemaWriteFailure();
  }
  return schemaPath;
};

const removeOutputSchema = async (schemaPath: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await unlink(schemaPath);
      return;
    } catch (cause) {
      if (isNodeError(cause, "ENOENT")) return;
      const retryable = RETRYABLE_SCHEMA_DELETE_ERRORS.some((code) => isNodeError(cause, code));
      if (!retryable || attempt === SCHEMA_DELETE_RETRIES) {
        throw new AquariusError(
          "ANTIGRAVITY_EXECUTION_FAILED",
          "Antigravity could not remove its output schema.",
        );
      }
    }
    await delay(SCHEMA_DELETE_RETRY_DELAY_MS * (attempt + 1));
  }
};

const antigravityRunInfo = (options: AntigravityOptions): AdapterRunInfo => {
  const { model, effort, agent, mode, sandbox } = options;
  const details: Record<string, string> = {};
  if (effort !== undefined) details.effort = effort;
  if (agent !== undefined) details.agent = agent;
  if (mode !== undefined) details.mode = mode;
  if (sandbox === false) details.sandbox = "false";

  return {
    adapter: "antigravity",
    ...(model !== undefined && { model }),
    ...(Object.keys(details).length > 0 && { details }),
  };
};

const mapPreparationError = (
  cause: unknown,
  errorCodes: Record<string, string>,
  summary: string,
  paths: readonly string[],
): AquariusError | undefined => {
  if (!(cause instanceof AquariusError)) return undefined;
  const code = errorCodes[cause.code];
  return code ? new AquariusError(code, withDiagnostic(summary, cause.message, paths)) : undefined;
};
