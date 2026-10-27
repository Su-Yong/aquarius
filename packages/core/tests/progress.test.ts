import { expect, test, vi } from "vitest";
import { startProgress, statusText } from "../src/shared/progress";

test("renders and clears interactive progress, then stops its timer", () => {
  vi.useFakeTimers();
  vi.stubEnv("TERM", "xterm");
  const write = vi.fn();
  const stream = { isTTY: true, hasColors: () => true, write } as unknown as NodeJS.WriteStream;
  try {
    const progress = startProgress(true, stream);
    progress.update("Analyzing files with AI");
    vi.advanceTimersByTime(100);
    expect(write.mock.calls.map(([text]) => text).join("")).toContain("Analyzing files with AI");
    progress.stop();
    expect(write).toHaveBeenLastCalledWith("\r\x1b[2K");
    const count = write.mock.calls.length;
    vi.advanceTimersByTime(500);
    expect(write).toHaveBeenCalledTimes(count);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

test("does not render for JSON or non-interactive output", () => {
  const write = vi.fn();
  const tty = { isTTY: true, hasColors: () => true, write } as unknown as NodeJS.WriteStream;
  const pipe = { isTTY: false, write } as unknown as NodeJS.WriteStream;
  for (const progress of [startProgress(false, tty), startProgress(true, pipe)]) {
    progress.update("Analyzing");
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
    expect(statusText("Done", "success", { isTTY: true, hasColors: () => false } as unknown as NodeJS.WriteStream)).toBe("✓ Done");
    process.env.TERM = "dumb";
    expect(statusText("Done", "success", tty)).toBe("✓ Done");
  } finally {
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});


test("does not render progress in a dumb terminal", () => {
  vi.stubEnv("TERM", "dumb");
  try {
    const write = vi.fn();
    const progress = startProgress(true, { isTTY: true, write } as unknown as NodeJS.WriteStream);
    progress.update("Analyzing");
    progress.stop();
    expect(write).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});
