import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

export const runGit = async (
  root: string,
  arguments_: readonly string[],
  input?: Uint8Array,
): Promise<Buffer> => {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["-C", root, ...arguments_], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(Buffer.concat(stdout));
      else
        reject(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim() || `git exited with status ${code}`,
          ),
        );
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ? Buffer.from(input) : undefined);
  });
};

export const findGitDirectory = async (projectRoot: string): Promise<string | null> => {
  let inside: string;
  let gitDirectory: string;
  try {
    inside = (await runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]))
      .toString("utf8")
      .trim();
    gitDirectory = (await runGit(projectRoot, ["rev-parse", "--path-format=absolute", "--git-dir"]))
      .toString("utf8")
      .trim();
  } catch {
    return null;
  }
  if (inside !== "true" || !gitDirectory) return null;
  return await realpath(gitDirectory);
};
