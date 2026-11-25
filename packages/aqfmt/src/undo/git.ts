import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

export const findGitDirectory = async (projectRoot: string): Promise<string | null> => {
  let insideWorktree: string;
  let gitDirectory: string;
  try {
    const worktreeStatus = await runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
    insideWorktree = worktreeStatus.toString("utf8").trim();
    const gitDirectoryOutput = await runGit(projectRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ]);
    gitDirectory = gitDirectoryOutput.toString("utf8").trim();
  } catch {
    return null;
  }
  if (insideWorktree !== "true" || !gitDirectory) return null;
  return await realpath(gitDirectory);
};

export const runGit = async (
  root: string,
  arguments_: readonly string[],
  input?: Uint8Array,
): Promise<Buffer> => {
  const collectGitOutput = (
    resolve: (output: Buffer) => void,
    reject: (error: Error) => void,
  ) => {
    const child = spawn("git", ["-C", root, ...arguments_], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const collectStdout = (chunk: Buffer) => stdoutChunks.push(chunk);
    child.stdout.on("data", collectStdout);
    const stderrChunks: Buffer[] = [];
    const collectStderr = (chunk: Buffer) => stderrChunks.push(chunk);
    child.stderr.on("data", collectStderr);
    let settled = false;
    const rejectOnSpawnError = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once("error", rejectOnSpawnError);
    const settleOnExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const stderrText = Buffer.concat(stderrChunks).toString("utf8");
        reject(new Error(stderrText.trim() || `git exited with status ${code}`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks));
    };
    child.once("close", settleOnExit);
    const ignoreStdinError = () => undefined;
    child.stdin.on("error", ignoreStdinError);
    child.stdin.end(input ? Buffer.from(input) : undefined);
  };
  return await new Promise<Buffer>(collectGitOutput);
};
