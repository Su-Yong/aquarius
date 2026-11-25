import { pathToFileURL } from "node:url";
import type { Readable } from "node:stream";

import { toPosix } from "@aquarius/core/adapter";

const RAW_DIAGNOSTIC_LIMIT = 8_192;
const DISPLAY_DIAGNOSTIC_LIMIT = 1_200;

export const captureStderr = (stream: Readable): (() => string) => {
  let output = "";
  const encodedStream = stream.setEncoding("utf8");

  const collectStderr = (chunk: string) => {
    const remainingCapacity = RAW_DIAGNOSTIC_LIMIT - output.length;
    output += chunk.slice(0, remainingCapacity);
  };

  encodedStream.on("data", collectStderr);

  return () => output;
};

export const withDiagnostic = (
  message: string,
  detail: unknown,
  paths: readonly string[],
): string => {
  if (typeof detail !== "string") return message;

  let redactedDetail = detail.slice(0, RAW_DIAGNOSTIC_LIMIT);
  const longestPathsFirst = [...paths].sort((left, right) => right.length - left.length);
  for (const path of longestPathsFirst) {
    const pathVariants = new Set([
      path,
      toPosix(path),
      JSON.stringify(path).slice(1, -1),
      pathToFileURL(path).href,
    ]);
    for (const variant of pathVariants) {
      if (!variant) continue;
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const flags = process.platform === "win32" ? "giu" : "gu";
      redactedDetail = redactedDetail.replace(new RegExp(escaped, flags), "[redacted path]");
    }
  }

  const diagnostic = redactedDetail
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return diagnostic ? `${message} ${diagnostic.slice(0, DISPLAY_DIAGNOSTIC_LIMIT)}` : message;
};
