import { createColors } from "picocolors";

const statusStyles = {
  success: { symbol: "✓", color: "green" },
  warning: { symbol: "⚠", color: "yellow" },
  error: { symbol: "✖", color: "red" },
  info: { symbol: "•", color: "cyan" },
  skipped: { symbol: "↷", color: "yellow" },
} as const;

export interface ProgressPart {
  text: string;
  color?: "cyan" | "magenta" | "green" | "yellow" | "red" | "dim" | "bold";
}

export interface ProgressLine {
  text: string | readonly ProgressPart[];
  status?: keyof typeof statusStyles;
}

export const formatDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

export const progressText = (message: string): string => {
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
};

const fitProgressLine = (text: string, columns: number): string => {
  let width = 0;
  let visible = "";
  for (const character of text) {
    // Conservatively count non-ASCII as double width so filenames cannot wrap the spinner.
    const characterWidth = character.codePointAt(0)! > 0x7f ? 2 : 1;
    if (width + characterWidth > columns - 2) {
      return `${visible}…`;
    }
    visible += character;
    width += characterWidth;
  }
  return visible;
};

export const terminalColors = (stream: NodeJS.WriteStream) =>
  createColors(
    Boolean(
      stream.isTTY &&
      process.env.NO_COLOR === undefined &&
      process.env.TERM !== "dumb" &&
      stream.hasColors(),
    ),
  );

export const statusText = (
  message: string,
  status: keyof typeof statusStyles,
  stream: NodeJS.WriteStream,
): string => {
  if (!stream.isTTY) return message;
  const { symbol, color } = statusStyles[status];
  return `${terminalColors(stream)[color](symbol)} ${message}`;
};

export const progressLineText = (
  line: string | ProgressLine,
  stream: NodeJS.WriteStream,
  columns?: number,
): string => {
  const { text, status } = typeof line === "string" ? { text: line } : line;
  const parts: ProgressPart[] = (typeof text === "string" ? [{ text }] : text).map((part) => ({
    ...part,
    text: part.text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " "),
  }));
  if (!stream.isTTY || process.env.TERM === "dumb") {
    return parts.map((part) => part.text).join("");
  }
  if (status) {
    const { symbol, color } = statusStyles[status];
    parts.unshift({ text: `${symbol} `, color });
  }
  const plain = parts.map((part) => part.text).join("");
  const fitted = columns === undefined ? plain : fitProgressLine(plain, columns);
  const colors = terminalColors(stream);
  let offset = 0;
  return parts
    .map((part) => {
      const visible = fitted.slice(offset, offset + part.text.length);
      offset += part.text.length;
      return part.color ? colors[part.color](visible) : visible;
    })
    .join("");
};

export const startProgress = (enabled: boolean, stream: NodeJS.WriteStream = process.stderr) => {
  if (!enabled) {
    return {
      update: (_message: string) => {},
      updateDetails: (_lines: readonly (string | ProgressLine)[]) => {},
      clear: () => {},
      stop: () => {},
    };
  }

  const interactive = stream.isTTY && process.env.TERM !== "dumb";
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const startedAt = Date.now();
  let frame = 0;
  let message = "Preparing";
  let details: (string | ProgressLine)[] = [];
  let stopped = false;
  let renderedLines = 0;
  let renderedColumns = stream.columns;
  let renderedRows = stream.rows;

  const heading = () => {
    const elapsed = formatDuration(Date.now() - startedAt);
    const activity =
      interactive && (stream.rows ?? 24) <= 2 && details.length > 0
        ? `${details.length} more lines`
        : message;
    const text = `[${elapsed}] ${activity}`;
    if (!interactive) return text;
    return progressLineText(
      {
        text: [
          { text: `${frames[frame++ % frames.length]} `, color: "cyan" },
          { text: `[${elapsed}] `, color: "dim" },
          { text: activity },
        ],
      },
      stream,
      Math.max(0, (stream.columns ?? 120) - 1),
    );
  };

  const clear = () => {
    if (!interactive || stopped || renderedLines === 0) return;
    const count = Math.min(renderedLines, Math.max(1, stream.rows ?? 24));
    let erase = "\r\x1b[2K";
    for (let line = 1; line < count; line += 1) {
      erase += "\x1b[1A\r\x1b[2K";
    }
    stream.write(erase);
    renderedLines = 0;
  };

  const render = () => {
    if (!interactive) {
      stream.write(
        `${[heading(), ...details.map((line) => progressLineText(line, stream))].join("\n")}\n`,
      );
      return;
    }
    clear();
    const columns = Math.max(0, (stream.columns ?? 120) - 1);
    const availableRows = Math.max(1, (stream.rows ?? 24) - 1);
    let lines = [heading(), ...details.map((line) => progressLineText(line, stream, columns))];
    if (lines.length > availableRows) {
      const omitted = lines.length - availableRows + 1;
      lines =
        availableRows === 1
          ? [lines[0]!]
          : [
              ...lines.slice(0, availableRows - 1),
              fitProgressLine(`… ${omitted} more lines`, columns),
            ];
    }
    stream.write(`\r${lines.join("\n")}`);
    renderedLines = lines.length;
    renderedColumns = stream.columns;
    renderedRows = stream.rows;
  };

  const renderActivity = () => {
    if (!interactive) {
      stream.write(`${heading()}\n`);
      return;
    }
    if (renderedLines === 0 || renderedColumns !== stream.columns || renderedRows !== stream.rows) {
      render();
      return;
    }
    const rowsAbove = renderedLines - 1;
    const up = rowsAbove > 0 ? `\x1b[${rowsAbove}A` : "";
    const down = rowsAbove > 0 ? `\x1b[${rowsAbove}B\r` : "";
    stream.write(`${up}\r\x1b[2K${heading()}${down}`);
  };

  render();
  const timer = setInterval(renderActivity, interactive ? 100 : 10_000);
  timer.unref();
  return {
    update: (next: string) => {
      if (stopped) return;
      const nextMessage = progressText(next);
      if (nextMessage === message) return;
      message = nextMessage;
      renderActivity();
    },
    updateDetails: (lines: readonly (string | ProgressLine)[]) => {
      if (stopped) return;
      details = lines.map((line) => (typeof line === "string" ? line : structuredClone(line)));
      render();
    },
    clear,
    stop: () => {
      if (stopped) return;
      clearInterval(timer);
      clear();
      stopped = true;
    },
  };
};
