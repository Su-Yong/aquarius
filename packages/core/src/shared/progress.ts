import { createColors } from "picocolors";

export const terminalColors = (stream: NodeJS.WriteStream) =>
  createColors(Boolean(stream.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb" && stream.hasColors()));

export const statusText = (message: string, status: "success" | "warning" | "error" | "info", stream: NodeJS.WriteStream): string => {
  if (!stream.isTTY) return message;
  const symbols = { success: "✓", warning: "⚠", error: "✖", info: "•" };
  const colors = { success: "green", warning: "yellow", error: "red", info: "cyan" } as const;
  const marker = symbols[status];
  return `${terminalColors(stream)[colors[status]](marker)} ${message}`;
};

export const startProgress = (enabled: boolean, stream: NodeJS.WriteStream = process.stderr) => {
  if (!enabled || !stream.isTTY || process.env.TERM === "dumb") return { update: (_message: string) => {}, stop: () => {} };

  const frames = ["|", "/", "-", "\\"];
  let frame = 0;
  let message = "Preparing";
  const render = () => stream.write(`\r\x1b[2K${statusText(`${frames[frame++ % frames.length]} ${message}...`, "info", stream)}`);
  render();
  const timer = setInterval(render, 100);
  timer.unref();
  return {
    update: (next: string) => { message = next; render(); },
    stop: () => { clearInterval(timer); stream.write("\r\x1b[2K"); },
  };
};
