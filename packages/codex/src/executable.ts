import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { AquariusError } from "@aquarius/core/adapter";

const isExecutableFile = async (path: string): Promise<boolean> => {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
};

const platformPackage = (): { packageName: string; target: string; binary: string } | undefined => {
  const key = `${process.platform}-${process.arch}`;
  const targets: Record<string, { packageName: string; target: string; binary: string }> = {
    "darwin-arm64": {
      packageName: "codex-darwin-arm64",
      target: "aarch64-apple-darwin",
      binary: "codex",
    },
    "darwin-x64": {
      packageName: "codex-darwin-x64",
      target: "x86_64-apple-darwin",
      binary: "codex",
    },
    "linux-arm64": {
      packageName: "codex-linux-arm64",
      target: "aarch64-unknown-linux-musl",
      binary: "codex",
    },
    "linux-x64": {
      packageName: "codex-linux-x64",
      target: "x86_64-unknown-linux-musl",
      binary: "codex",
    },
    "win32-arm64": {
      packageName: "codex-win32-arm64",
      target: "aarch64-pc-windows-msvc",
      binary: "codex.exe",
    },
    "win32-x64": {
      packageName: "codex-win32-x64",
      target: "x86_64-pc-windows-msvc",
      binary: "codex.exe",
    },
  };
  return targets[key];
};

const packagedBinary = async (packageRoot: string): Promise<string | undefined> => {
  const platform = platformPackage();
  if (!platform) return undefined;
  const packageDirectory = join(packageRoot, "node_modules", "@openai", platform.packageName);
  const hoistedDirectory = join(dirname(dirname(packageRoot)), "@openai", platform.packageName);
  for (const directory of [packageDirectory, hoistedDirectory]) {
    const candidate = join(directory, "vendor", platform.target, "bin", platform.binary);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
};

export const resolveCodexExecutable = async (explicit?: string): Promise<string> => {
  if (explicit !== undefined) {
    if (!isAbsolute(explicit))
      throw new AquariusError(
        "CODEX_EXECUTABLE_INVALID",
        "Codex executable must be an absolute path.",
      );
    if (!(await isExecutableFile(explicit)))
      throw new AquariusError("CODEX_EXECUTABLE_NOT_FOUND", "Codex executable was not found.");
    return realpath(explicit);
  }

  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const pathDirectories = (process.env.PATH ?? "")
    .split(delimiter)
    .map((directory) => directory.replace(/^"|"$/g, ""))
    .filter(Boolean);

  for (const directory of pathDirectories) {
    const npmPackageRoot = join(directory, "node_modules", "@openai", "codex");
    if (await isExecutableFile(join(npmPackageRoot, "bin", "codex.js"))) {
      const native = await packagedBinary(npmPackageRoot);
      if (native) return realpath(native);
    }
  }

  for (const directory of pathDirectories) {
    const shim = join(directory, executableName);
    if (await isExecutableFile(shim)) {
      if (process.platform !== "win32") {
        try {
          const resolvedShim = await realpath(shim);
          if (resolvedShim.endsWith(`${sep}bin${sep}codex.js`)) {
            const native = await packagedBinary(dirname(dirname(resolvedShim)));
            if (native) return realpath(native);
          }
        } catch {
          // Fall through to the executable itself when a shim target cannot be resolved.
        }
      }
      return realpath(shim);
    }
  }

  throw new AquariusError(
    "CODEX_EXECUTABLE_NOT_FOUND",
    "A native Codex executable was not found on PATH.",
  );
};
