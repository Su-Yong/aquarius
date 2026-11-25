import type { LoadedConfig } from "../config/types";
import { AquariusError, errorMessage } from "../shared/errors";
import { isPlainObject } from "../shared/json";
import { importProjectModule } from "../shared/modules";
import { formatZodIssues } from "../shared/zod";
import type { JsonObject } from "../shared/types";
import type { AdapterRunInfo, AdapterSession, AiAdapter, SessionAdapter } from "./types";

const loadAdapter = async (config: LoadedConfig): Promise<unknown> => {
  const specifier = config.ai.adapter;
  if (!specifier) {
    throw new AquariusError(
      "AI_ADAPTER_REQUIRED",
      'Set ai.adapter in the project configuration, such as "@aquarius/codex" or "./adapter.mjs".',
    );
  }
  try {
    return await importProjectModule(specifier, config.configDirectory);
  } catch (error) {
    throw new AquariusError(
      "AI_ADAPTER_LOAD_FAILED",
      `Could not load AI adapter "${specifier}": ${errorMessage(error)}`,
    );
  }
};

const isAdapter = (value: unknown): value is AiAdapter => {
  if (!isPlainObject(value) || typeof value.id !== "string" || value.id.trim() === "") {
    return false;
  }
  if (
    value.optionsSchema !== undefined &&
    (typeof value.optionsSchema !== "object" ||
      value.optionsSchema === null ||
      !("safeParse" in value.optionsSchema) ||
      typeof value.optionsSchema.safeParse !== "function")
  ) {
    return false;
  }
  return (
    (typeof value.createSession === "function" && value.run === undefined) ||
    (typeof value.run === "function" && value.createSession === undefined)
  );
};

const assertRunInfo = (value: unknown, id: string): AdapterRunInfo => {
  if (value === undefined) return { adapter: id };
  if (!isPlainObject(value)) {
    throw new AquariusError("INVALID_AI_ADAPTER", "AI adapter session info must be an object.");
  }
  const { adapter, model, details } = value;
  if (adapter !== undefined && (typeof adapter !== "string" || adapter.trim() === "")) {
    throw new AquariusError(
      "INVALID_AI_ADAPTER",
      "AI adapter session info.adapter must be a non-empty string.",
    );
  }
  if (model !== undefined && typeof model !== "string") {
    throw new AquariusError(
      "INVALID_AI_ADAPTER",
      "AI adapter session info.model must be a string.",
    );
  }
  if (
    details !== undefined &&
    (!isPlainObject(details) || !Object.values(details).every((item) => typeof item === "string"))
  ) {
    throw new AquariusError(
      "INVALID_AI_ADAPTER",
      "AI adapter session info.details must be a record of strings.",
    );
  }
  return {
    adapter: adapter ?? id,
    ...(model !== undefined && { model }),
    ...(details !== undefined && { details: { ...details } as Record<string, string> }),
  };
};

const assertSession = async (value: unknown, id: string): Promise<AdapterSession> => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("execute" in value) ||
    typeof value.execute !== "function" ||
    !("dispose" in value) ||
    typeof value.dispose !== "function"
  ) {
    throw new AquariusError(
      "INVALID_AI_ADAPTER",
      "AI adapter session must provide execute and dispose functions.",
    );
  }
  const session = value as AdapterSession;
  try {
    return {
      info: assertRunInfo(session.info, id),
      execute: (request) => session.execute(request),
      dispose: () => session.dispose(),
    };
  } catch (cause) {
    try {
      await session.dispose();
    } catch {
      // Preserve the validation error when an invalid session also fails to dispose.
    }
    throw cause;
  }
};

const parseOptions = (adapter: AiAdapter, options: JsonObject): JsonObject => {
  if (!adapter.optionsSchema) return options;
  try {
    const parsed = adapter.optionsSchema.safeParse(options);
    if (parsed.success) return parsed.data;
    throw new Error(formatZodIssues(parsed.error, "ai.options"));
  } catch (error) {
    throw new AquariusError(
      "AI_ADAPTER_OPTIONS_INVALID",
      `Invalid ai.options for AI adapter "${adapter.id}": ${errorMessage(error)}`,
    );
  }
};

const sessionAdapter = (adapter: AiAdapter): SessionAdapter => {
  const { id, optionsSchema } = adapter;
  if (adapter.createSession) {
    return {
      id,
      optionsSchema,
      async createSession(context) {
        return assertSession(await adapter.createSession(context), id);
      },
    };
  }
  return {
    id,
    optionsSchema,
    createSession: () => ({
      info: { adapter: id },
      execute: (request) => adapter.run(request),
      dispose: () => {},
    }),
  };
};

export const resolveAdapter = async (
  config: LoadedConfig,
  supplied?: AiAdapter,
): Promise<{ adapter: SessionAdapter; options: JsonObject }> => {
  const loaded = supplied ?? (await loadAdapter(config));
  if (!isAdapter(loaded)) {
    throw new AquariusError(
      "INVALID_AI_ADAPTER",
      "AI adapter must export an id and either a createSession or a run function.",
    );
  }
  return {
    adapter: sessionAdapter(loaded),
    options: parseOptions(loaded, config.ai.options),
  };
};
