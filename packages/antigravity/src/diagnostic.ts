import { pathToFileURL } from "node:url";
import type { Readable } from "node:stream";

import { toPosix } from "@aqtools/core/adapter";

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

export const createPathMatcher = (paths: readonly string[]): RegExp | undefined => {
  const variants = new Set(paths.filter(Boolean).flatMap(pathVariants));
  if (variants.size === 0) return undefined;

  const pattern = [...variants]
    .sort((left, right) => right.length - left.length)
    .map((variant) => variant.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");

  return new RegExp(pattern, process.platform === "win32" ? "iu" : "u");
};

export const withDiagnostic = (
  message: string,
  detail: unknown,
  paths: readonly string[],
): string => {
  if (typeof detail !== "string") return message;

  const matcher = createPathMatcher(paths);
  let diagnostic = detail.slice(0, RAW_DIAGNOSTIC_LIMIT);
  if (matcher) {
    diagnostic = diagnostic.replace(
      new RegExp(matcher.source, `${matcher.flags}g`),
      "[redacted path]",
    );
  }

  diagnostic = diagnostic
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return diagnostic ? `${message} ${diagnostic.slice(0, DISPLAY_DIAGNOSTIC_LIMIT)}` : message;
};

const pathVariants = (path: string): string[] => {
  const posix = toPosix(path);
  const fileUrl = pathToFileURL(path).href;
  const variants = [path, posix, fileUrl, decodeURIComponent(fileUrl)];
  return [...variants, ...variants.map((variant) => JSON.stringify(variant).slice(1, -1))];
};
