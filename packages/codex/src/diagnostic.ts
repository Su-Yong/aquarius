import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { toPosix } from "@aquarius/core/adapter";

export const captureStderr = (stream: Readable): (() => string) => {
  let output = "";
  stream.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk.slice(0, 8_192 - output.length);
  });
  return () => output;
};

export const withDiagnostic = (
  message: string,
  detail: unknown,
  paths: readonly string[],
): string => {
  if (typeof detail !== "string") return message;
  let text = detail.slice(0, 8_192);
  for (const path of [...paths].sort((left, right) => right.length - left.length)) {
    const variants = new Set([
      path,
      toPosix(path),
      JSON.stringify(path).slice(1, -1),
      pathToFileURL(path).href,
    ]);
    for (const variant of variants) {
      if (!variant) continue;
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      text = text.replace(
        new RegExp(escaped, process.platform === "win32" ? "giu" : "gu"),
        "[redacted path]",
      );
    }
  }
  const diagnostic = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return diagnostic ? `${message} ${diagnostic.slice(0, 1_200)}` : message;
};
