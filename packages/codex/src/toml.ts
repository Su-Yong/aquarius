import { z } from "zod";

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

const tomlText = z
  .string()
  .refine((value) => value.isWellFormed(), "Expected well-formed Unicode.");

export const tomlValueSchema: z.ZodType<TomlValue, TomlValue> = z.lazy(() =>
  z.union([
    tomlText,
    z.number(),
    z.boolean(),
    z.array(tomlValueSchema),
    z.record(tomlText, tomlValueSchema),
  ]),
);

export const tomlString = (value: string): string =>
  JSON.stringify(value).replaceAll("\u007f", "\\u007f");

export const tomlValue = (value: TomlValue): string => {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0.0";
    // TOML integers are signed 64-bit. Use a float for JS numbers outside the safe integer range.
    return Number.isInteger(value) && !Number.isSafeInteger(value)
      ? value.toExponential()
      : String(value);
  }
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(",")}]`;
  const entries = Object.entries(value).map(
    ([key, item]) => `${tomlString(key)}=${tomlValue(item)}`,
  );
  return `{${entries.join(",")}}`;
};

export const configArguments = (overrides: readonly string[]): string[] => {
  return overrides.flatMap((override) => ["-c", override]);
};
