import { afterEach, expect, test, vi } from "vitest";

import { formatExtractConfigReport } from "../src/cli/extract-config";
import type { ExtractConfigResult } from "../src/extract/index";

afterEach(() => {
  vi.unstubAllEnvs();
});

const sampleReport = (): ExtractConfigResult["report"] => ({
  sourceRoot: "/repo",
  totalDiscovered: 500,
  sampledCount: 300,
  ai: { adapter: "codex", model: "gpt-6.2-sol", details: { serviceTier: "ultrafast" } },
  outputPath: "/repo/.aqfmtrc.json",
  findings: [
    {
      ruleId: "aquarius/imports/namespace-vs-named",
      status: "observed",
      setting: true,
      reason: "Named imports recur across files.",
      mixed: false,
      observations: null,
    },
    {
      ruleId: "aquarius/imports/organize",
      status: "observed",
      setting: true,
      reason: "Grouped imports recur across routes.",
      mixed: true,
      observations: "Relative imports occasionally mix with external imports.",
    },
    {
      ruleId: "aquarius/tests/case-style",
      status: "insufficient_evidence",
      setting: null,
      reason: "No automated test files were found.",
      mixed: false,
      observations: null,
    },
  ],
  warnings: [
    {
      code: "EXTRACT_FILES_SAMPLED",
      message: "Sampled 300 of 500 source files by directory and extension.",
      ruleIds: [],
    },
    {
      code: "RULE_OPTIONS_INVALID",
      message: "Dropped invalid option.",
      ruleIds: ["aquarius/example/rule"],
    },
  ],
});

const mockStream = (isTTY: boolean, hasColors = isTTY) =>
  ({ isTTY, hasColors: () => hasColors }) as unknown as NodeJS.WriteStream;

test("styles extract-config reports with ANSI colors and status symbols on a color TTY", () => {
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("NO_COLOR", undefined);

  const output = formatExtractConfigReport(sampleReport(), mockStream(true, true));

  expect(output).toContain(
    "\x1b[32m✓\x1b[39m \x1b[1mSaved\x1b[22m \x1b[36m/repo/.aqfmtrc.json\x1b[39m",
  );
  expect(output).toContain(
    "\x1b[36m•\x1b[39m Analyzed \x1b[1m300\x1b[22m source files from \x1b[36m/repo\x1b[39m",
  );
  expect(output).toContain(
    "\x1b[32m✓\x1b[39m \x1b[35maquarius/imports/namespace-vs-named\x1b[39m:",
  );
  expect(output).toContain("\x1b[33m⚠\x1b[39m \x1b[35maquarius/imports/organize\x1b[39m:");
  expect(output).toContain(
    "  \x1b[33mWarning:\x1b[39m \x1b[33mmixed style for\x1b[39m \x1b[35maquarius/imports/organize\x1b[39m",
  );
  expect(output).toContain(
    "  \x1b[2mObserved:\x1b[22m \x1b[2mRelative imports occasionally mix with external imports.\x1b[22m",
  );
  expect(output).toContain(
    "\x1b[33m↷\x1b[39m \x1b[33mInsufficient evidence\x1b[39m — \x1b[35maquarius/tests/case-style\x1b[39m: \x1b[2mNo automated test files were found.\x1b[22m",
  );
  expect(output).toContain(
    "\x1b[33m⚠\x1b[39m \x1b[33mWarning\x1b[39m \x1b[33mRULE_OPTIONS_INVALID\x1b[39m \x1b[35m[aquarius/example/rule]\x1b[39m: \x1b[1mDropped invalid option.\x1b[22m",
  );
});

test("keeps status symbols without ANSI colors when NO_COLOR is set on a TTY", () => {
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("NO_COLOR", "1");

  const output = formatExtractConfigReport(sampleReport(), mockStream(true, true));

  expect(output).not.toContain("\x1b[");
  expect(output).toContain("✓ Saved /repo/.aqfmtrc.json");
  expect(output).toContain("• Analyzed 300 source files from /repo");
  expect(output).toContain("✓ aquarius/imports/namespace-vs-named:");
  expect(output).toContain("⚠ aquarius/imports/organize:");
  expect(output).toContain("↷ Insufficient evidence — aquarius/tests/case-style:");
  expect(output).toContain("⚠ Warning EXTRACT_FILES_SAMPLED:");
});

test("omits ANSI colors and status symbols on non-TTY streams", () => {
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("NO_COLOR", undefined);

  const output = formatExtractConfigReport(sampleReport(), mockStream(false, false));

  expect(output).not.toContain("\x1b[");
  expect(output).toContain("Saved /repo/.aqfmtrc.json");
  expect(output).not.toContain("✓ ");
  expect(output).not.toContain("⚠ ");
  expect(output).not.toContain("↷ ");
  expect(output).toContain(
    "Insufficient evidence — aquarius/tests/case-style: No automated test files were found.",
  );
  expect(output).toContain(
    "Warning RULE_OPTIONS_INVALID [aquarius/example/rule]: Dropped invalid option.",
  );
});
