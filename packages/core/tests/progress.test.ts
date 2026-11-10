import { expect, test, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { formatDuration, startProgress, statusText } from "../src/shared/progress";

test("renders and clears interactive progress, then stops its timer", () => {
  vi.useFakeTimers();
  vi.stubEnv("TERM", "xterm");
  const write = vi.fn();
  const stream = { isTTY: true, hasColors: () => true, write } as unknown as NodeJS.WriteStream;
  try {
    const progress = startProgress(true, stream);
    progress.update("Analyzing files with AI");
    vi.advanceTimersByTime(65_100);
    expect(write.mock.calls.map(([text]) => text).join("")).toContain("Analyzing files with AI");
    expect(write).toHaveBeenLastCalledWith(expect.stringContaining("[01:05]"));
    progress.stop();
    expect(write).toHaveBeenLastCalledWith("\r\x1b[2K");
    const count = write.mock.calls.length;
    vi.advanceTimersByTime(500);
    progress.update("Late update");
    expect(write).toHaveBeenCalledTimes(count);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

test("can disable progress without writing anything", () => {
  const write = vi.fn();
  const tty = { isTTY: true, hasColors: () => true, write } as unknown as NodeJS.WriteStream;
  const pipe = { isTTY: false, write } as unknown as NodeJS.WriteStream;
  for (const progress of [startProgress(false, tty), startProgress(false, pipe)]) {
    progress.update("Analyzing");
    progress.updateDetails(["PROVISIONAL #1"]);
    progress.clear();
    progress.stop();
  }
  expect(write).not.toHaveBeenCalled();
});

test("styles interactive status while preserving redirected output and NO_COLOR", () => {
  const tty = { isTTY: true, hasColors: () => true } as unknown as NodeJS.WriteStream;
  const pipe = { isTTY: false } as NodeJS.WriteStream;
  const previous = process.env.NO_COLOR;
  const previousTerm = process.env.TERM;
  try {
    delete process.env.NO_COLOR;
    delete process.env.TERM;
    expect(statusText("Done", "success", tty)).toBe("\x1b[32m✓\x1b[39m Done");
    expect(statusText("Done", "success", pipe)).toBe("Done");
    process.env.NO_COLOR = "1";
    expect(statusText("Failed", "error", tty)).toBe("✖ Failed");
    delete process.env.NO_COLOR;
    expect(
      statusText("Done", "success", {
        isTTY: true,
        hasColors: () => false,
      } as unknown as NodeJS.WriteStream),
    ).toBe("✓ Done");
    process.env.TERM = "dumb";
    expect(statusText("Done", "success", tty)).toBe("✓ Done");
  } finally {
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test("renders plain elapsed progress in a dumb terminal", () => {
  vi.stubEnv("TERM", "dumb");
  try {
    const write = vi.fn();
    const progress = startProgress(true, { isTTY: true, write } as unknown as NodeJS.WriteStream);
    progress.update("Analyzing");
    progress.updateDetails(["PROVISIONAL #1", "Current diagnostics: 0"]);
    progress.stop();
    const output = write.mock.calls.map(([text]) => text).join("");
    expect(output).toContain("[00:00] Analyzing\n");
    expect(output).toContain("PROVISIONAL #1\n");
    expect(output).not.toContain("\x1b");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("reports activity changes and periodic elapsed time to a redirected stream", () => {
  vi.useFakeTimers();
  const write = vi.fn();
  const stream = { isTTY: false, write } as unknown as NodeJS.WriteStream;
  const progress = startProgress(true, stream);
  try {
    progress.update("Inspecting src/file.ts\n\x1b[2J");
    const firstOutput = write.mock.calls.map(([text]) => text).join("");
    expect(firstOutput).toContain("Inspecting src/file.ts");
    expect(firstOutput).not.toContain("\x1b");
    expect(firstOutput.split("\n")).toHaveLength(3);

    vi.advanceTimersByTime(10_000);
    expect(write).toHaveBeenLastCalledWith(expect.stringContaining("[00:10] Inspecting"));
    const count = write.mock.calls.length;
    progress.update("Inspecting src/file.ts\n\x1b[2J");
    expect(write).toHaveBeenCalledTimes(count);
    progress.stop();
    vi.advanceTimersByTime(20_000);
    expect(write).toHaveBeenCalledTimes(count);
  } finally {
    progress.stop();
    vi.useRealTimers();
  }
});

test("clearing for a warning keeps the elapsed timer running", () => {
  vi.useFakeTimers();
  vi.stubEnv("TERM", "xterm");
  const write = vi.fn();
  const stream = { isTTY: true, hasColors: () => false, write } as unknown as NodeJS.WriteStream;
  const progress = startProgress(true, stream);
  try {
    progress.update("Analyzing");
    progress.clear();
    const count = write.mock.calls.length;
    vi.advanceTimersByTime(1_000);
    expect(write.mock.calls.length).toBeGreaterThan(count);
    expect(write).toHaveBeenLastCalledWith(expect.stringContaining("[00:01] Analyzing"));
  } finally {
    progress.stop();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

test("formats long and sub-second durations without wrapping minutes", () => {
  expect(formatDuration(25)).toBe("00:00");
  expect(formatDuration(65_000)).toBe("01:05");
  expect(formatDuration(3_661_000)).toBe("61:01");
});

test("keeps long filenames on one interactive line", () => {
  vi.stubEnv("TERM", "xterm");
  const write = vi.fn();
  const stream = {
    isTTY: true,
    columns: 48,
    hasColors: () => false,
    write,
  } as unknown as NodeJS.WriteStream;
  const progress = startProgress(true, stream);
  try {
    progress.update(`Inspecting src/${"긴파일이름".repeat(10)}.ts`);
    const output = String(write.mock.calls.at(-1)![0]);
    expect(output).toContain("[00:00] Inspecting");
    expect(output).toContain("…");
    expect(output).not.toContain("긴파일이름".repeat(10));
    expect(output).not.toContain("\n");
  } finally {
    progress.stop();
    vi.unstubAllEnvs();
  }
});

test("replaces the whole interactive panel when findings change or disappear", () => {
  vi.useFakeTimers();
  vi.stubEnv("TERM", "xterm");
  const write = vi.fn();
  const stream = {
    isTTY: true,
    columns: 100,
    rows: 20,
    hasColors: () => false,
    write,
  } as unknown as NodeJS.WriteStream;
  const progress = startProgress(true, stream);
  try {
    progress.updateDetails(["PROVISIONAL #1", "old diagnostic", "second diagnostic"]);
    write.mockClear();
    progress.updateDetails(["PROVISIONAL #2", "revised diagnostic"]);
    const redraw = write.mock.calls.map(([text]) => String(text)).join("");
    const clearedLines = redraw.split("\x1b[2K").length - 1;
    const upwardMoves = redraw.split("\x1b[1A").length - 1;
    expect(clearedLines).toBe(4);
    expect(upwardMoves).toBe(3);
    expect(redraw).toContain("revised diagnostic");
    expect(redraw).not.toContain("old diagnostic");
    expect(redraw).not.toContain("second diagnostic");

    write.mockClear();
    progress.updateDetails(["PROVISIONAL #3", "Current diagnostics: 0"]);
    const withdrawn = write.mock.calls.map(([text]) => String(text)).join("");
    expect(withdrawn).not.toContain("revised diagnostic");
    expect(withdrawn).toContain("Current diagnostics: 0");

    write.mockClear();
    vi.advanceTimersByTime(1_000);
    const activity = write.mock.calls.map(([text]) => String(text)).join("");
    expect(activity).toContain("[00:01]");
    expect(activity).not.toContain("PROVISIONAL #3");
    expect(activity).toContain("\x1b[2A");
    expect(activity).toContain("\x1b[2B");
  } finally {
    progress.stop();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

test("bounds interactive panels to terminal height and states how much was omitted", () => {
  vi.stubEnv("TERM", "xterm");
  const write = vi.fn();
  const stream = {
    isTTY: true,
    columns: 70,
    rows: 5,
    hasColors: () => false,
    write,
  } as unknown as NodeJS.WriteStream;
  const progress = startProgress(true, stream);
  try {
    progress.updateDetails(["PROVISIONAL #1", "first", "second", "third", "fourth"]);
    const frame = String(write.mock.calls.at(-1)![0]);
    expect(frame.split("\n")).toHaveLength(4);
    expect(frame).toContain("3 more lines");
    expect(frame).not.toContain("fourth");
    stream.rows = 2;
    progress.update("Inspecting small-terminal.ts");
    const compact = String(write.mock.calls.at(-1)![0]);
    expect(compact).not.toContain("\n");
    expect(compact).toContain("5 more lines");
    stream.rows = 5;
    progress.clear();
    write.mockClear();
    progress.update("Inspecting source.ts");
    const restored = String(write.mock.calls.at(-1)![0]);
    expect(restored).toContain("PROVISIONAL #1");
    expect(restored).toContain("Inspecting source.ts");
  } finally {
    progress.stop();
    vi.unstubAllEnvs();
  }
});

test("redirected snapshots include every current line and stay distinct from activity heartbeats", () => {
  vi.useFakeTimers();
  const write = vi.fn();
  const stream = { isTTY: false, write } as unknown as NodeJS.WriteStream;
  const progress = startProgress(true, stream);
  try {
    const details = [
      "PROVISIONAL #1",
      ...Array.from({ length: 30 }, (_, index) => `finding ${index}`),
    ];
    progress.updateDetails(details);
    expect(write).toHaveBeenLastCalledWith(expect.stringContaining("finding 29\n"));
    expect(String(write.mock.calls.at(-1)![0])).not.toContain("\x1b");

    progress.updateDetails(["PROVISIONAL #2", "No current diagnostics"]);
    const current = String(write.mock.calls.at(-1)![0]);
    expect(current).not.toContain("finding 29");
    expect(current).toContain("PROVISIONAL #2");
    vi.advanceTimersByTime(10_000);
    expect(write).toHaveBeenLastCalledWith("[00:10] Preparing\n");
    progress.stop();
    const count = write.mock.calls.length;
    progress.updateDetails(["Late update"]);
    vi.advanceTimersByTime(20_000);
    expect(write).toHaveBeenCalledTimes(count);
  } finally {
    progress.stop();
    vi.useRealTimers();
  }
});

test("clips styled progress before adding ANSI and preserves safe plain output when redirected", () => {
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("NO_COLOR", undefined);
  const write = vi.fn();
  const stream = {
    isTTY: true,
    columns: 40,
    rows: 10,
    hasColors: () => true,
    write,
  } as unknown as NodeJS.WriteStream;
  const progress = startProgress(true, stream);
  const details = [
    {
      text: [{ text: "Reviewed\x1b[2J\n" }, { text: "긴파일".repeat(20), color: "cyan" as const }],
      status: "success" as const,
    },
  ];
  try {
    progress.updateDetails(details);
    const frame = String(write.mock.calls.at(-1)![0]);
    expect(frame).toContain("\x1b[36m⠙");
    expect(frame).toContain("\x1b[32m✓ \x1b[39mReviewed");
    expect(frame.endsWith("…\x1b[39m")).toBe(true);
    expect(frame).not.toContain("\x1b[2J");
    expect(frame.split("\n")).toHaveLength(2);
    const visible = stripVTControlCharacters(frame.split("\n")[1]!);
    let width = 0;
    for (const character of visible) {
      width += character.codePointAt(0)! > 0x7f ? 2 : 1;
    }
    expect(width).toBeLessThan(stream.columns);
  } finally {
    progress.stop();
    vi.unstubAllEnvs();
  }

  const redirected = startProgress(true, { isTTY: false, write } as unknown as NodeJS.WriteStream);
  try {
    redirected.updateDetails(details);
    const output = String(write.mock.calls.at(-1)![0]);
    expect(output).not.toContain("\x1b");
    expect(output).not.toContain("✓");
    expect(output).toContain("긴파일".repeat(20));
    expect(output.split("\n")).toHaveLength(3);
  } finally {
    redirected.stop();
  }
});
