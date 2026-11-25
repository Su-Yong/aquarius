import type { JsonObject } from "./types";

export const isPlainObject = (value: unknown): value is JsonObject => {
  const isNonArrayObject =
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isNonArrayObject) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
