import { z } from "zod";

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

const tomlText = z
  .string()
  .refine((value) => value.isWellFormed(), "Expected well-formed Unicode.");

export const tomlValueSchema: z.ZodType<TomlValue, TomlValue> = z.lazy(buildTomlValueSchema);

export const tomlValue = (value: TomlValue): string => {
  if (typeof value === "string") return tomlString(value);
  else if (typeof value === "boolean") return String(value);
  else if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0.0";
    // TOML integers are signed 64-bit. Use a float for JS numbers outside the safe integer range.
    return Number.isInteger(value) && !Number.isSafeInteger(value)
      ? value.toExponential()
      : String(value);
  } else if (Array.isArray(value)) {
    const serializedItems = value.map(tomlValue);
    return `[${serializedItems.join(",")}]`;
  }

  const tableEntries = Object.entries(value);
  const serializedEntries = tableEntries.map(([key, item]) => `${tomlString(key)}=${tomlValue(item)}`);
  return `{${serializedEntries.join(",")}}`;
};

export const tomlString = (value: string): string => {
  const quotedString = JSON.stringify(value);
  return quotedString.replaceAll("\u007f", "\\u007f");
};

export const configArguments = (overrides: readonly string[]): string[] => {
  return overrides.flatMap((override) => ["-c", override]);
};

function buildTomlValueSchema() {
  return z.union([
    tomlText,
    z.number(),
    z.boolean(),
    z.array(tomlValueSchema),
    z.record(tomlText, tomlValueSchema),
  ]);
}
