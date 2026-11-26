import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import { AquariusError } from "@aqtools/core/adapter";

export const resolveAntigravityExecutable = async (explicit?: string): Promise<string> => {
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) {
      throw new AquariusError(
        "ANTIGRAVITY_EXECUTABLE_INVALID",
        "Antigravity executable must be an absolute path.",
      );
    }

    const executable = await resolveExecutableFile(explicit);
    if (executable) return executable;

    throw new AquariusError(
      "ANTIGRAVITY_EXECUTABLE_NOT_FOUND",
      "Antigravity executable was not found or is not executable.",
    );
  }

  const executableNames = process.platform === "win32" ? ["agy.exe", "agy.cmd"] : ["agy"];
  const directories = (process.env.PATH ?? "")
    .split(delimiter)
    .map((directory) => directory.replace(/^"|"$/gu, ""))
    .filter(Boolean);

  for (const directory of directories) {
    for (const name of executableNames) {
      const executable = await resolveExecutableFile(join(directory, name));
      if (executable) return executable;
    }
  }

  throw new AquariusError(
    "ANTIGRAVITY_EXECUTABLE_NOT_FOUND",
    "Antigravity executable was not found on PATH.",
  );
};

const resolveExecutableFile = async (path: string): Promise<string | undefined> => {
  try {
    const executable = await realpath(path);
    if (!(await stat(executable)).isFile()) return undefined;

    await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return executable;
  } catch {
    return undefined;
  }
};
