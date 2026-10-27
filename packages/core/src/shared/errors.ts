import type { RunError } from "./types";

export class AquariusError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AquariusError";
  }
}

export const toRunError = (
  error: unknown,
  fallbackCode = "EXECUTION_FAILED",
  ruleIds: string[] = [],
): RunError => ({
  code: error instanceof AquariusError ? error.code : fallbackCode,
  message: error instanceof Error ? error.message : String(error),
  ruleIds,
});
