import { chmod, link, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { applyFileChanges, captureBaseline, planFileChanges } from "../src/changes/apply";
import type { GitUndoStore } from "../src/undo/store";

const temporaryProject = async (): Promise<string> => {
  return await mkdtemp(path.join(tmpdir(), "aquarius-changes-"));
};

const removeTemporaryProject = async (root: string): Promise<void> => {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("aquarius-changes-")) {
    throw new Error(`Refusing to remove unexpected test path: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
};

const canWrite = () => true;

test("plans every replacement against the same original and applies it once", async () => {
  const root = await temporaryProject();
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "sample.txt"), "one two three\n");
    const baseline = await captureBaseline(root, ["src/sample.txt"]);
    const plan = await planFileChanges(
      root,
      [
        { op: "replace", path: "src/sample.txt", oldText: "three", newText: "THREE", ruleIds: ["fmt/a"] },
        { op: "replace", path: "src/sample.txt", oldText: "one", newText: "ONE", ruleIds: ["fmt/b"] },
      ],
      canWrite,
      baseline,
    );

    expect(Buffer.from(plan.files[0]!.after!.content).toString()).toBe("ONE two THREE\n");
    await expect(applyFileChanges(plan, null)).resolves.toEqual({
      changedFiles: ["src/sample.txt"],
      undoAvailable: false,
    });
    expect(await readFile(path.join(root, "src", "sample.txt"), "utf8")).toBe("ONE two THREE\n");

    const noOpBaseline = await captureBaseline(root, ["src/sample.txt"]);
    const noOp = await planFileChanges(
      root,
      [{ op: "replace", path: "src/sample.txt", oldText: "two", newText: "two", ruleIds: ["fmt/a"] }],
      canWrite,
      noOpBaseline,
    );
    expect(noOp.files).toEqual([]);
  } finally {
    await removeTemporaryProject(root);
  }
});

test("preserves a UTF-8 BOM and exact CRLF bytes during replacement", async () => {
  const root = await temporaryProject();
  try {
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\r\ntwo\r\n")]);
    await writeFile(path.join(root, "bom.txt"), original);
    const plan = await planFileChanges(
      root,
      [{ op: "replace", path: "bom.txt", oldText: "one\r\n", newText: "ONE\r\n", ruleIds: ["fmt/a"] }],
      canWrite,
      await captureBaseline(root, ["bom.txt"]),
    );
    await applyFileChanges(plan, null);
    expect(await readFile(path.join(root, "bom.txt"))).toEqual(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("ONE\r\ntwo\r\n")]),
    );
  } finally {
    await removeTemporaryProject(root);
  }
});

test("rejects ambiguous and overlapping replacement ranges", async () => {
  const root = await temporaryProject();
  try {
    await writeFile(path.join(root, "ambiguous.txt"), "abc abc");
    await writeFile(path.join(root, "overlap.txt"), "abcdef");
    const baseline = await captureBaseline(root, ["ambiguous.txt", "overlap.txt"]);
    await expect(
      planFileChanges(
        root,
        [{ op: "replace", path: "ambiguous.txt", oldText: "abc", newText: "x", ruleIds: ["fmt/a"] }],
        canWrite,
        baseline,
      ),
    ).rejects.toMatchObject({ code: "REPLACE_NOT_UNIQUE" });
    await expect(
      planFileChanges(
        root,
        [
          { op: "replace", path: "overlap.txt", oldText: "abc", newText: "x", ruleIds: ["fmt/a"] },
          { op: "replace", path: "overlap.txt", oldText: "cde", newText: "y", ruleIds: ["fmt/b"] },
        ],
        canWrite,
        baseline,
      ),
    ).rejects.toMatchObject({ code: "REPLACE_OVERLAP" });
  } finally {
    await removeTemporaryProject(root);
  }
});

test("moves transformed original content and creates safe parent directories", async () => {
  const root = await temporaryProject();
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "old.txt"), "before value\n");
    await chmod(path.join(root, "src", "old.txt"), 0o644);
    const baseline = await captureBaseline(root, ["src/old.txt"]);
    const plan = await planFileChanges(
      root,
      [
        { op: "move", from: "src/old.txt", to: "generated/deep/new.txt", ruleIds: ["fmt/move"] },
        { op: "replace", path: "src/old.txt", oldText: "before", newText: "after", ruleIds: ["fmt/edit"] },
      ],
      canWrite,
      baseline,
    );
    await applyFileChanges(plan, null);
    await expect(readFile(path.join(root, "src", "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, "generated", "deep", "new.txt"), "utf8")).toBe("after value\n");
  } finally {
    await removeTemporaryProject(root);
  }
});

test("rejects destinations, unsafe combinations, and write-policy violations before writing", async () => {
  const root = await temporaryProject();
  try {
    await writeFile(path.join(root, "source.txt"), "source");
    await writeFile(path.join(root, "taken.txt"), "taken");
    const baseline = await captureBaseline(root, ["source.txt", "taken.txt"]);
    await expect(
      planFileChanges(
        root,
        [{ op: "move", from: "source.txt", to: "taken.txt", ruleIds: ["fmt/a"] }],
        canWrite,
        baseline,
      ),
    ).rejects.toMatchObject({ code: "DESTINATION_EXISTED" });
    await expect(
      planFileChanges(
        root,
        [
          { op: "create", path: "new", content: "file", ruleIds: ["fmt/a"] },
          { op: "create", path: "new-child", content: "sibling", ruleIds: ["fmt/a"] },
          { op: "create", path: "new/child", content: "child", ruleIds: ["fmt/a"] },
        ],
        canWrite,
        baseline,
      ),
    ).rejects.toMatchObject({ code: "PATH_CONFLICT" });
    await expect(
      planFileChanges(
        root,
        [{ op: "delete", path: "source.txt", ruleIds: ["fmt/a"] }],
        () => false,
        baseline,
      ),
    ).rejects.toMatchObject({ code: "PATH_NOT_WRITABLE" });
    expect(await readFile(path.join(root, "source.txt"), "utf8")).toBe("source");
    expect(await readFile(path.join(root, "taken.txt"), "utf8")).toBe("taken");
  } finally {
    await removeTemporaryProject(root);
  }
});

test("preserves edits made after baseline capture or after planning", async () => {
  const root = await temporaryProject();
  try {
    await writeFile(path.join(root, "file.txt"), "original");
    const staleBaseline = await captureBaseline(root, ["file.txt"]);
    await writeFile(path.join(root, "file.txt"), "edited before response");
    await expect(
      planFileChanges(
        root,
        [{ op: "replace", path: "file.txt", oldText: "original", newText: "formatted", ruleIds: ["fmt/a"] }],
        canWrite,
        staleBaseline,
      ),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });

    const baseline = await captureBaseline(root, ["file.txt"]);
    const plan = await planFileChanges(
      root,
      [
        {
          op: "replace",
          path: "file.txt",
          oldText: "edited before response",
          newText: "formatted",
          ruleIds: ["fmt/a"],
        },
      ],
      canWrite,
      baseline,
    );
    await writeFile(path.join(root, "file.txt"), "edited after planning");
    await expect(applyFileChanges(plan, null)).rejects.toMatchObject({ code: "FILE_CHANGED" });
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("edited after planning");
  } finally {
    await removeTemporaryProject(root);
  }
});

test("restores all files when recording the successful write fails", async () => {
  const root = await temporaryProject();
  try {
    await writeFile(path.join(root, "first.txt"), "first old");
    await writeFile(path.join(root, "second.txt"), "second old");
    const baseline = await captureBaseline(root, ["first.txt", "second.txt"]);
    const plan = await planFileChanges(
      root,
      [
        { op: "replace", path: "first.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] },
        { op: "replace", path: "second.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] },
        { op: "create", path: "created/deep/new.txt", content: "new", ruleIds: ["fmt/a"] },
      ],
      canWrite,
      baseline,
    );
    let aborted = false;
    const failingStore = {
      async begin() {
        return {
          async commit() {
            throw new Error("manifest write failed");
          },
          async abort() {
            aborted = true;
          },
          async preserve() {},
        };
      },
    } as unknown as GitUndoStore;

    await expect(applyFileChanges(plan, failingStore)).rejects.toThrow("manifest write failed");
    expect(aborted).toBe(true);
    expect(await readFile(path.join(root, "first.txt"), "utf8")).toBe("first old");
    expect(await readFile(path.join(root, "second.txt"), "utf8")).toBe("second old");
    await expect(lstat(path.join(root, "created"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await removeTemporaryProject(root);
  }
});

test("does not overwrite an identical user file created in the final write window", async () => {
  const root = await temporaryProject();
  try {
    const target = path.join(root, "race.txt");
    await writeFile(target, "old");
    const plan = await planFileChanges(
      root,
      [{ op: "replace", path: "race.txt", oldText: "old", newText: "formatted", ruleIds: ["fmt/a"] }],
      canWrite,
      await captureBaseline(root, ["race.txt"]),
    );
    let injected = false;
    const injector = (async () => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          await writeFile(target, "formatted", { flag: "wx" });
          injected = true;
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    await expect(applyFileChanges(plan, null)).rejects.toMatchObject({ code: "APPLY_ROLLBACK_INCOMPLETE" });
    await injector;
    expect(injected).toBe(true);
    expect(await readFile(target, "utf8")).toBe("formatted");
  } finally {
    await removeTemporaryProject(root);
  }
});

test("cleans directories created before a later mkdir failure", async () => {
  const root = await temporaryProject();
  try {
    await mkdir(path.join(root, "dirs"));
    const numbered = Array.from({ length: 128 }, (_, index) => index.toString().padStart(3, "0"));
    const changes = [
      ...numbered.map((name) => ({
        op: "create" as const,
        path: `dirs/${name}/file.txt`,
        content: name,
        ruleIds: ["fmt/a"],
      })),
      { op: "create" as const, path: "dirs/zzz/file.txt", content: "late", ruleIds: ["fmt/a"] },
    ];
    const plan = await planFileChanges(root, changes, canWrite, new Map());
    const applying = applyFileChanges(plan, null);
    const blocker = (async () => {
      while (true) {
        try {
          await lstat(path.join(root, "dirs", "000"));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      await writeFile(path.join(root, "dirs", "zzz"), "user blocker", { flag: "wx" });
    })();

    await expect(applying).rejects.toBeDefined();
    await blocker;
    for (const name of numbered) {
      await expect(lstat(path.join(root, "dirs", name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(path.join(root, "dirs", "zzz"), "utf8")).toBe("user blocker");
  } finally {
    await removeTemporaryProject(root);
  }
});

test("rejects hard-link aliases of the same source file", async () => {
  const root = await temporaryProject();
  try {
    await writeFile(path.join(root, "one.txt"), "same");
    await link(path.join(root, "one.txt"), path.join(root, "alias.txt"));
    const baseline = await captureBaseline(root, ["one.txt", "alias.txt"]);
    await expect(planFileChanges(
      root,
      [
        { op: "replace", path: "one.txt", oldText: "same", newText: "first", ruleIds: ["fmt/a"] },
        { op: "replace", path: "alias.txt", oldText: "same", newText: "second", ruleIds: ["fmt/a"] },
      ],
      canWrite,
      baseline,
    )).rejects.toMatchObject({ code: "PATH_ALIAS_CONFLICT" });
  } finally {
    await removeTemporaryProject(root);
  }
});

test.runIf(process.platform === "win32")("rejects NTFS alternate streams and Windows path aliases", async () => {
  const root = await temporaryProject();
  try {
    const target = path.join(root, "download.txt");
    await writeFile(target, "old");
    await writeFile(`${target}:Zone.Identifier`, "[ZoneTransfer]");
    const plan = await planFileChanges(
      root,
      [{ op: "replace", path: "download.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] }],
      canWrite,
      await captureBaseline(root, ["download.txt"]),
    );
    await expect(applyFileChanges(plan, null)).rejects.toMatchObject({ code: "FILE_METADATA_UNSUPPORTED" });
    expect(await readFile(target, "utf8")).toBe("old");
    expect(await readFile(`${target}:Zone.Identifier`, "utf8")).toBe("[ZoneTransfer]");

    for (const reserved of ["CON.txt", "trailing.", "trailing ", "file:stream"]) {
      await expect(planFileChanges(
        root,
        [{ op: "create", path: reserved, content: "x", ruleIds: ["fmt/a"] }],
        canWrite,
        new Map(),
      )).rejects.toMatchObject({ code: "PATH_INVALID" });
    }
  } finally {
    await removeTemporaryProject(root);
  }
});

test("rejects paths whose parent is a symbolic link", async ({ skip }) => {
  const root = await temporaryProject();
  try {
    await mkdir(path.join(root, "real"));
    try {
      await symlink(
        path.join(root, "real"),
        path.join(root, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        skip();
        return;
      }
      throw error;
    }
    await expect(
      planFileChanges(
        root,
        [{ op: "create", path: "linked/new.txt", content: "unsafe", ruleIds: ["fmt/a"] }],
        canWrite,
        new Map(),
      ),
    ).rejects.toMatchObject({ code: "SYMLINK_UNSUPPORTED" });
  } finally {
    await removeTemporaryProject(root);
  }
});
