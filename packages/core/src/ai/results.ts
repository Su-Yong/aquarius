import { isAbsolute } from "node:path";
import { z } from "zod";
import { AquariusError, toRunError } from "../shared/errors";
import type { RunError } from "../shared/types";

export const errorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  ruleIds: z.array(z.string()),
});

export const parseResultItem = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  name: string,
): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AquariusError("INVALID_AI_ITEM", `Invalid ${name} structure: ${parsed.error.message}`);
  }
  return parsed.data;
};

export const resultEnvelope = (value: unknown, arrays: string[]): Record<string, unknown[]> => {
  const fields = Object.fromEntries(arrays.map((key) => [key, z.array(z.unknown())]));
  const parsed = z.strictObject(fields).safeParse(value);
  if (!parsed.success) {
    throw new AquariusError("INVALID_AI_RESPONSE", "AI response must contain only the expected result arrays.");
  }
  return parsed.data;
};

export const references = (value: unknown, known: Set<string>, allowEmpty = false): string[] => {
  const parsed = z.array(z.string()).safeParse(value);
  if (!parsed.success || (!allowEmpty && parsed.data.length === 0) ||
      parsed.data.some((id) => !known.has(id)) || new Set(parsed.data).size !== parsed.data.length) {
    throw new AquariusError("INVALID_RULE_REFERENCE", "AI result contains an unknown, repeated, or missing rule reference.");
  }
  return parsed.data;
};

export const nonempty = (value: string, label: string): void => {
  if (value.trim() === "") throw new AquariusError("INVALID_AI_ITEM", `${label} must not be empty.`);
};

export const normalizedPath = (value: string): string => {
  const segments = value.split("/");
  if (value === "" || value.includes("\\") || value.includes(":") || /[\u0000-\u001f]/u.test(value) ||
      isAbsolute(value) || segments.some((part) => part === "" || part === "." || part === "..")) {
    throw new AquariusError("INVALID_RESULT_PATH", "AI result path must be a normalized project-relative file path.");
  }
  return value;
};

export const collectErrors = (items: unknown[], known: Set<string>, output: RunError[]): void => {
  for (const item of items) {
    try {
      const supplied = parseResultItem(errorSchema, item, "execution error");
      const ruleIds = references(supplied.ruleIds, known, true);
      nonempty(supplied.code, "Error code");
      nonempty(supplied.message, "Error message");
      output.push({ code: supplied.code, message: supplied.message, ruleIds });
    } catch (cause) {
      output.push(toRunError(cause, "INVALID_EXECUTION_ERROR"));
    }
  }
};

export const checkCompletion = (items: unknown[], known: Set<string>, errors: RunError[]): void => {
  let completed: string[];
  try {
    completed = references(items, known, true);
  } catch (cause) {
    errors.push(toRunError(cause, "INVALID_COMPLETION"));
    completed = [];
  }
  const accounted = new Set([...completed, ...errors.flatMap((entry) => entry.ruleIds)]);
  const missing = [...known].filter((id) => !accounted.has(id));
  if (missing.length) {
    errors.push({
      code: "INCOMPLETE_AI_RESPONSE",
      message: "AI did not complete all requested rules.",
      ruleIds: missing,
    });
  }
};
