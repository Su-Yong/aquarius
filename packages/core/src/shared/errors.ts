import type { RunError } from "./types";

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const isNodeError = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

export class AquariusError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
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
  message: errorMessage(error),
  ruleIds,
});
