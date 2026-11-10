import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  codexBridge,
  buildCodexConfigOverrides,
  createCodexSnapshot,
  resolveCodexExecutable,
  runExec,
} from "../src/ai/codex";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (label: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), `aquarius-codex-test-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  const tempRoot = resolve(tmpdir());
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => {
      const candidate = resolve(directory);
      if (
        dirname(candidate) !== tempRoot ||
        !candidate.startsWith(join(tempRoot, "aquarius-codex-test-"))
      ) {
        throw new Error("Refusing to remove a directory not created by this test.");
      }
      return rm(candidate, { recursive: true, force: true });
    }),
  );
});

describe("Codex readable snapshot", () => {
  test("copies only the approved regular files and preserves their relative paths", async () => {
    const root = await temporaryDirectory("copy");
    const view = await temporaryDirectory("view");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "main.ts"), "export const answer = 42;\n");
    await writeFile(join(root, "secret.txt"), "not approved\n");

    await expect(
      createCodexSnapshot(root, ["src/main.ts"], [], view, new AbortController().signal),
    ).resolves.toEqual(["src/main.ts"]);
    await expect(readFile(join(view, "src", "main.ts"), "utf8")).resolves.toBe(
      "export const answer = 42;\n",
    );
    await expect(readFile(join(view, "secret.txt"), "utf8")).rejects.toThrow();
  });

  test("rejects a readable file that matches the effective ignore policy", async () => {
    const root = await temporaryDirectory("ignore");
    const view = await temporaryDirectory("ignore-view");
    await mkdir(join(root, "generated"));
    await writeFile(join(root, "generated", "secret.ts"), "secret\n");

    await expect(
      createCodexSnapshot(
        root,
        ["generated/secret.ts"],
        [{ baseDirectory: root, patterns: ["generated/**"] }],
        view,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CODEX_IGNORE_VIOLATION" });
  });

  test("applies ignore patterns based above the project root", async () => {
    const parent = await temporaryDirectory("parent-ignore");
    const root = join(parent, "project");
    const view = await temporaryDirectory("parent-ignore-view");
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, "generated", "secret.ts"), "secret\n");

    await expect(
      createCodexSnapshot(
        root,
        ["generated/secret.ts"],
        [{ baseDirectory: parent, patterns: ["project/generated/**"] }],
        view,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CODEX_IGNORE_VIOLATION" });
  });

  test("rejects traversal, duplicate paths, and pre-aborted work", async () => {
    const root = await temporaryDirectory("invalid");
    const view = await temporaryDirectory("invalid-view");
    await writeFile(join(root, "file.ts"), "value\n");

    await expect(
      createCodexSnapshot(root, ["../file.ts"], [], view, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CODEX_READABLE_PATH_INVALID" });
    await expect(
      createCodexSnapshot(root, ["file.ts", "file.ts"], [], view, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CODEX_READABLE_PATH_INVALID" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      createCodexSnapshot(root, ["file.ts"], [], view, controller.signal),
    ).rejects.toMatchObject({ code: "CODEX_ABORTED" });
  });

  test("does not follow source symlinks", async () => {
    const root = await temporaryDirectory("symlink");
    const view = await temporaryDirectory("symlink-view");
    await writeFile(join(root, "target.ts"), "target\n");
    try {
      await symlink(join(root, "target.ts"), join(root, "linked.ts"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    await expect(
      createCodexSnapshot(root, ["linked.ts"], [], view, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CODEX_READABLE_PATH_UNSUPPORTED" });
  });
});

describe("Codex invocation policy", () => {
  test.skipIf(process.platform === "win32")(
    "delivers large task instructions in the snapshot without overwriting repository files",
    async () => {
      const root = await temporaryDirectory("large-task");
      const executable = join(root, "codex");
      const resultPath = join(root, "result.json");
      const capturedPrompt = join(root, "stdin.txt");
      const existing = join(root, ".aquarius-task-existing");
      await mkdir(existing);
      await writeFile(join(existing, "instructions.txt"), "repository-owned\n");
      const script = `#!${process.execPath}
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(capturedPrompt)}, prompt);
  fs.writeFileSync(${JSON.stringify(resultPath)}, "{}");
  console.error("Recovered TLS warning: invalid peer certificate (UnknownIssuer)");
  console.log(JSON.stringify({ type: "turn.completed" }));
});
`;
      await writeFile(executable, script, { mode: 0o755 });
      const prompt = "Large rule instructions 한글\n".repeat(60_000);
      expect(prompt.length).toBeGreaterThan(1_048_576);
      await expect(
        runExec(
          executable,
          {
            projectRoot: root,
            readableFiles: [],
            ignore: [],
            prompt,
            ruleResources: { directory: root, files: [] },
            outputSchema: { type: "object" },
            options: {},
            signal: new AbortController().signal,
          },
          {},
          root,
          root,
          join(root, "schema.json"),
          resultPath,
          [],
        ),
      ).resolves.toEqual({});

      const tasks = (await readdir(root)).filter(
        (name) => name.startsWith(".aquarius-task-") && name !== ".aquarius-task-existing",
      );
      expect(tasks).toHaveLength(1);
      expect(await readFile(join(root, tasks[0]!, "instructions.txt"), "utf8")).toBe(prompt);
      const sent = await readFile(capturedPrompt, "utf8");
      expect(sent.length).toBeLessThan(2_048);
      expect(sent).toContain(`${tasks[0]}/instructions.txt`);
      expect(sent).toContain("not a target");
      expect(await readFile(join(existing, "instructions.txt"), "utf8")).toBe("repository-owned\n");
    },
  );

  test.skipIf(process.platform === "win32")(
    "reports input-size rejection without exposing arbitrary stderr",
    async () => {
      const root = await temporaryDirectory("stderr");
      const executable = join(root, "codex");
      const runWithStderr = async (stderr: string) => {
        await writeFile(
          executable,
          `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => {
  process.stderr.write(${JSON.stringify(stderr)});
  process.exitCode = 1;
});
`,
          { mode: 0o755 },
        );
        return runExec(
          executable,
          {
            projectRoot: root,
            readableFiles: [],
            ignore: [],
            prompt: "Fixture instructions.",
            ruleResources: { directory: root, files: [] },
            outputSchema: { type: "object" },
            options: {},
            signal: new AbortController().signal,
          },
          {},
          root,
          root,
          join(root, "schema.json"),
          join(root, "result.json"),
          [],
        );
      };

      await expect(
        runWithStderr(
          "Error: Input exceeds the maximum length of 1048576 characters. secret-value",
        ),
      ).rejects.toMatchObject({
        code: "CODEX_INPUT_TOO_LARGE",
        message: "Codex rejected an input longer than 1048576 characters.",
      });
      await expect(runWithStderr("Unexpected failure: secret-value")).rejects.toMatchObject({
        code: "CODEX_EXECUTION_FAILED",
        message: "Codex exited unsuccessfully (1).",
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "accepts a recovered error but rejects a final failure",
    async () => {
      const root = await temporaryDirectory("events");
      const executable = join(root, "codex");
      const resultPath = join(root, "result.json");
      const input = {
        projectRoot: root,
        readableFiles: [],
        ignore: [],
        prompt: "Return an empty object.",
        ruleResources: { directory: root, files: [] },
        outputSchema: { type: "object" },
        options: {},
        signal: new AbortController().signal,
      };

      const runWithEvents = async (events: object[]) => {
        const script =
          `#!${process.execPath}\n` +
          `const fs = require("node:fs");\n` +
          `process.stdin.resume();\n` +
          `process.stdin.on("end", () => {\n` +
          `  fs.writeFileSync(${JSON.stringify(resultPath)}, "{}");\n` +
          `  for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n` +
          `});\n`;
        await writeFile(executable, script, { mode: 0o755 });
        return runExec(
          executable,
          input,
          {},
          root,
          root,
          join(root, "schema.json"),
          resultPath,
          [],
        );
      };

      await expect(runWithEvents([{ type: "error" }, { type: "turn.completed" }])).resolves.toEqual(
        {},
      );
      await expect(
        runWithEvents([{ type: "error" }, { type: "turn.failed" }]),
      ).rejects.toMatchObject({ code: "CODEX_EXECUTION_FAILED" });
      await expect(
        runWithEvents([
          {
            type: "turn.failed",
            error: { message: JSON.stringify({ error: { code: "model_not_found" } }) },
          },
        ]),
      ).rejects.toMatchObject({
        code: "CODEX_EXECUTION_FAILED",
        message: expect.stringContaining("configured Codex model is unavailable"),
      });
      await expect(runWithEvents([{ type: "error" }])).rejects.toMatchObject({
        code: "CODEX_EXECUTION_FAILED",
      });
      await expect(
        runWithEvents([
          { type: "error" },
          { type: "item.completed", item: { type: "file_change" } },
        ]),
      ).rejects.toMatchObject({ code: "CODEX_TOOL_VIOLATION" });
    },
  );

  test("uses invocation-only permission settings without a legacy sandbox flag", () => {
    const view = join(tmpdir(), "aquarius-view");
    const source = join(tmpdir(), "aquarius-source");
    const codexHome = join(tmpdir(), "codex-home");
    const overrides = buildCodexConfigOverrides(view, [source, codexHome]);
    const combined = overrides.join("\n");

    expect(combined).toContain('default_permissions="aquarius-read"');
    expect(combined).toContain('":root"="read"');
    expect(combined).toContain(`${JSON.stringify(source)}="deny"`);
    expect(combined).toContain("project_doc_max_bytes=0");
    expect(combined).toContain('web_search="disabled"');
    expect(combined).not.toContain("sandbox_mode");
  });

  test("requires an absolute explicit executable and resolves an existing native file", async () => {
    await expect(resolveCodexExecutable("codex")).rejects.toMatchObject({
      code: "CODEX_EXECUTABLE_INVALID",
    });
    const resolved = await resolveCodexExecutable(process.execPath);
    expect(isAbsolute(resolved)).toBe(true);
  });

  test("prefers an npm packaged native binary over an earlier desktop executable", async () => {
    const desktopDirectory = await temporaryDirectory("desktop-path");
    const npmDirectory = await temporaryDirectory("npm-path");
    const platforms: Record<string, readonly [string, string, string]> = {
      "darwin-arm64": ["codex-darwin-arm64", "aarch64-apple-darwin", "codex"],
      "darwin-x64": ["codex-darwin-x64", "x86_64-apple-darwin", "codex"],
      "linux-arm64": ["codex-linux-arm64", "aarch64-unknown-linux-musl", "codex"],
      "linux-x64": ["codex-linux-x64", "x86_64-unknown-linux-musl", "codex"],
      "win32-arm64": ["codex-win32-arm64", "aarch64-pc-windows-msvc", "codex.exe"],
      "win32-x64": ["codex-win32-x64", "x86_64-pc-windows-msvc", "codex.exe"],
    };
    const platform = platforms[`${process.platform}-${process.arch}`];
    if (!platform) return;
    const [packageName, target, binaryName] = platform;
    const desktopExecutable = join(
      desktopDirectory,
      process.platform === "win32" ? "codex.exe" : "codex",
    );
    const packageRoot = join(npmDirectory, "node_modules", "@openai", "codex");
    const npmExecutable = join(
      packageRoot,
      "node_modules",
      "@openai",
      packageName,
      "vendor",
      target,
      "bin",
      binaryName,
    );
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await mkdir(dirname(npmExecutable), { recursive: true });
    await writeFile(desktopExecutable, "desktop");
    await writeFile(join(packageRoot, "bin", "codex.js"), "shim");
    await writeFile(npmExecutable, "npm");
    if (process.platform !== "win32") {
      await Promise.all(
        [desktopExecutable, join(packageRoot, "bin", "codex.js"), npmExecutable].map((path) =>
          chmod(path, 0o755),
        ),
      );
    }

    const originalPath = process.env.PATH;
    process.env.PATH = [desktopDirectory, npmDirectory].join(delimiter);
    try {
      await expect(resolveCodexExecutable()).resolves.toBe(await realpath(npmExecutable));
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("returns the stable bridge identity and stops before any process for an aborted request", async () => {
    const root = await temporaryDirectory("aborted-run");
    const controller = new AbortController();
    controller.abort();

    expect(codexBridge.id).toBe("codex");
    await expect(
      codexBridge.run({
        projectRoot: root,
        readableFiles: [],
        ignore: [],
        prompt: "Return an empty object.",
        ruleResources: { directory: root, files: [] },
        outputSchema: { type: "object" },
        options: { executable: process.execPath },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CODEX_ABORTED" });
  });
});
