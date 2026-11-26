import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

import { captureStderr, createPathMatcher, withDiagnostic } from "../src/diagnostic";

test("captures only the first 8,192 characters of stderr", async () => {
  const stream = Readable.from([Buffer.from("x".repeat(8_191)), Buffer.from("ab"), "ignored"]);
  const readStderr = captureStderr(stream);
  await once(stream, "end");

  expect(readStderr()).toBe(`${"x".repeat(8_191)}a`);
});

test("redacts overlapping paths and their encoded variants", () => {
  const runRoot = join(tmpdir(), "agy [run] #1");
  const viewRoot = join(runRoot, "project");
  const projectRoot = join(tmpdir(), "source project");
  const executable = join(tmpdir(), "bin", "agy");
  const paths = [runRoot, viewRoot, projectRoot, executable];
  const details = [
    viewRoot,
    runRoot,
    projectRoot.replaceAll("\\", "/"),
    JSON.stringify(executable).slice(1, -1),
    pathToFileURL(viewRoot).href,
  ];

  expect(withDiagnostic("Failure.", `\u0007${details.join("\n")}`, paths)).toBe(
    `Failure. ${Array(details.length).fill("[redacted path]").join(" ")}`,
  );

  const matcher = createPathMatcher(paths);
  for (const detail of details) expect(matcher?.test(detail)).toBe(true);
  expect(matcher?.test("src/example.ts")).toBe(false);
});

test("limits display detail and omits empty or non-text diagnostics", () => {
  expect(withDiagnostic("Failure.", "example ".repeat(1_400), [])).toBe(
    `Failure. ${"example ".repeat(150)}`,
  );
  expect(withDiagnostic("Failure.", "\n\t\u202e", [])).toBe("Failure.");
  expect(withDiagnostic("Failure.", undefined, [])).toBe("Failure.");
});
