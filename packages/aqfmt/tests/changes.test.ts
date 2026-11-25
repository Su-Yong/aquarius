import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { applyFileChanges } from "../src/changes/apply";
import { planFileChanges, planPartialFileReplacements } from "../src/changes/plan";
import { captureBaseline } from "../src/changes/state";
import type { UndoStore } from "../src/changes/types";

const temporaryProject = async (): Promise<string> => {
  return await mkdtemp(path.join(tmpdir(), "aquarius-changes-"));
};

const removeTemporaryProject = async (root: string): Promise<void> => {
  const resolved = path.resolve(root);
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith("aquarius-changes-")
  ) {
    throw new Error(`Refusing to remove unexpected test path: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
};

const canWrite = () => true;

test("plans every replacement against the same original and applies it once", async () => {
  const root = await temporaryProject();
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "sample.txt"), "one\ntwo\nthree\n");
    const baseline = await captureBaseline(root, ["src/sample.txt"]);
    const plan = await planFileChanges(
      root,
      [
        {
          op: "replace",
          path: "src/sample.txt",
          patch: "@@ -3 +3 @@\n-three\n+THREE\n",
          ruleIds: ["fmt/a"],
        },
        {
          op: "replace",
          path: "src/sample.txt",
          patch: "@@ -1 +1 @@\n-one\n+ONE\n",
          ruleIds: ["fmt/b"],
        },
      ],
      canWrite,
      baseline,
    );

    expect(Buffer.from(plan.files[0]!.after!.content).toString()).toBe("ONE\ntwo\nTHREE\n");
    await expect(applyFileChanges(plan, null)).resolves.toEqual({
      changedFiles: ["src/sample.txt"],
      undoAvailable: false,
    });
    expect(await readFile(path.join(root, "src", "sample.txt"), "utf8")).toBe("ONE\ntwo\nTHREE\n");

    const noOpBaseline = await captureBaseline(root, ["src/sample.txt"]);
    const noOp = await planFileChanges(
      root,
      [
        {
          op: "replace",
          path: "src/sample.txt",
          patch: "@@ -2 +2 @@\n-two\n+two\n",
          ruleIds: ["fmt/a"],
        },
      ],
      canWrite,
      noOpBaseline,
    );
    expect(noOp.files).toEqual([]);
  } finally {
    await removeTemporaryProject(root);
  }
});

test("both planners normalize caller-supplied baseline paths", async () => {
  const root = await temporaryProject();
  try {
    const relativePath = "src/nested/sample.txt";
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await writeFile(path.join(root, relativePath), "before\n");
    const baseline = await captureBaseline(root, [relativePath]);
    const suppliedBaseline = new Map([["src//nested\\sample.txt", baseline.get(relativePath)!]]);
    const changes = [
      {
        op: "replace" as const,
        path: relativePath,
        patch: "@@ -1 +1 @@\n-before\n+after\n",
        ruleIds: ["fmt/a"],
      },
    ];

    const fullPlan = await planFileChanges(root, changes, canWrite, suppliedBaseline);
    const { plan, failures } = await planPartialFileReplacements(
      root,
      changes,
      canWrite,
      suppliedBaseline,
    );

    expect(failures).toEqual([]);
    expect(plan).toEqual(fullPlan);
    expect(plan.files.map(({ path }) => path)).toEqual([relativePath]);
  } finally {
    await removeTemporaryProject(root);
  }
});

test("preserves a UTF-8 BOM and exact CRLF bytes during replacement", async () => {
  const root = await temporaryProject();
  try {
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("one\r\ntwo\r\n"),
    ]);
    await writeFile(path.join(root, "bom.txt"), original);
    const plan = await planFileChanges(
      root,
      [
        {
          op: "replace",
          path: "bom.txt",
          patch: "@@ -1 +1 @@\n-one\n+ONE\n",
          ruleIds: ["fmt/a"],
        },
      ],
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
    await writeFile(path.join(root, "ambiguous.txt"), "abc\nother\nabc\n");
    await writeFile(path.join(root, "overlap.txt"), "abc\n");
    const baseline = await captureBaseline(root, ["ambiguous.txt", "overlap.txt"]);
    await expect(
      planFileChanges(
        root,
        [
          {
            op: "replace",
            path: "ambiguous.txt",
            patch: "@@ -2 +2 @@\n-abc\n+x\n",
            ruleIds: ["fmt/a"],
          },
        ],
        canWrite,
        baseline,
      ),
    ).rejects.toMatchObject({ code: "REPLACE_MISMATCH" });
    await expect(
      planFileChanges(
        root,
        [
          {
            op: "replace",
            path: "overlap.txt",
            patch: "@@ -1 +1 @@\n-abc\n+x\n",
            ruleIds: ["fmt/a"],
          },
          {
            op: "replace",
            path: "overlap.txt",
            patch: "@@ -1 +1 @@\n-abc\n+y\n",
            ruleIds: ["fmt/b"],
          },
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
        {
          op: "replace",
          path: "src/old.txt",
          patch: "@@ -1 +1 @@\n-before value\n+after value\n",
          ruleIds: ["fmt/edit"],
        },
      ],
      canWrite,
      baseline,
    );
    await applyFileChanges(plan, null);
    await expect(readFile(path.join(root, "src", "old.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(path.join(root, "generated", "deep", "new.txt"), "utf8")).toBe(
      "after value\n",
    );
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
        [
          {
            op: "replace",
            path: "file.txt",
            patch: "@@ -1 +1 @@\n-original\n+formatted\n",
            ruleIds: ["fmt/a"],
          },
        ],
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
          patch: "@@ -1 +1 @@\n-edited before response\n+formatted\n",
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
        {
          op: "replace",
          path: "first.txt",
          patch: "@@ -1 +1 @@\n-first old\n+first new\n",
          ruleIds: ["fmt/a"],
        },
        {
          op: "replace",
          path: "second.txt",
          patch: "@@ -1 +1 @@\n-second old\n+second new\n",
          ruleIds: ["fmt/a"],
        },
        { op: "create", path: "created/deep/new.txt", content: "new", ruleIds: ["fmt/a"] },
      ],
      canWrite,
      baseline,
    );
    let aborted = false;
    const failingStore: UndoStore = {
      async begin() {
        return {
          committed: false,
          async commit() {
            throw new Error("manifest write failed");
          },
          async abort() {
            aborted = true;
          },
          async preserve() {},
        };
      },
    };

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
      [
        {
          op: "replace",
          path: "race.txt",
          patch: "@@ -1 +1 @@\n-old\n+formatted\n",
          ruleIds: ["fmt/a"],
        },
      ],
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

    await expect(applyFileChanges(plan, null)).rejects.toMatchObject({
      code: "APPLY_ROLLBACK_INCOMPLETE",
    });
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
    await expect(
      planFileChanges(
        root,
        [
          {
            op: "replace",
            path: "one.txt",
            patch: "@@ -1 +1 @@\n-same\n+first\n",
            ruleIds: ["fmt/a"],
          },
          {
            op: "replace",
            path: "alias.txt",
            patch: "@@ -1 +1 @@\n-same\n+second\n",
            ruleIds: ["fmt/a"],
          },
        ],
        canWrite,
        baseline,
      ),
    ).rejects.toMatchObject({ code: "PATH_ALIAS_CONFLICT" });
  } finally {
    await removeTemporaryProject(root);
  }
});

test("plans replacements per file and attributes only the patches that failed", async () => {
  const root = await temporaryProject();
  try {
    const names = ["good.txt", "overlap.txt", "mismatch.txt", "edited.txt", "one.txt", "alias.txt"];
    for (const name of names.slice(0, -1)) {
      await writeFile(path.join(root, name), "first\nsecond\n");
    }
    await link(path.join(root, "one.txt"), path.join(root, "alias.txt"));
    const baseline = await captureBaseline(root, names);
    await writeFile(path.join(root, "edited.txt"), "user edit\n");

    const firstLine = "@@ -1 +1 @@\n-first\n+FIRST\n";
    const { plan, failures } = await planPartialFileReplacements(
      root,
      [
        ...names.map((path) => ({
          op: "replace" as const,
          path,
          patch: firstLine,
          ruleIds: ["fmt/a"],
        })),
        {
          op: "replace",
          path: "overlap.txt",
          patch: "@@ -1 +1 @@\n-first\n+Different\n",
          ruleIds: ["fmt/a", "fmt/b"],
        },
        {
          op: "replace",
          path: "overlap.txt",
          patch: "@@ -2 +2 @@\n-second\n+SECOND\n",
          ruleIds: ["fmt/other"],
        },
        {
          op: "replace",
          path: "mismatch.txt",
          patch: "@@ -2 +2 @@\n-absent\n+SECOND\n",
          ruleIds: ["fmt/c"],
        },
      ],
      canWrite,
      baseline,
    );

    expect(plan.files.map(({ path }) => path)).toEqual(["good.txt"]);
    expect(failures).toHaveLength(5);
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "overlap.txt",
          repairable: true,
          error: expect.objectContaining({ code: "REPLACE_OVERLAP", ruleIds: ["fmt/a", "fmt/b"] }),
        }),
        expect.objectContaining({
          path: "mismatch.txt",
          repairable: true,
          error: expect.objectContaining({ code: "REPLACE_MISMATCH", ruleIds: ["fmt/c"] }),
        }),
        expect.objectContaining({
          path: "edited.txt",
          repairable: false,
          error: expect.objectContaining({ code: "SOURCE_CHANGED", ruleIds: [] }),
        }),
        ...["one.txt", "alias.txt"].map((path) =>
          expect.objectContaining({
            path,
            repairable: false,
            error: expect.objectContaining({ code: "PATH_ALIAS_CONFLICT", ruleIds: [] }),
          }),
        ),
      ]),
    );
    await expect(applyFileChanges(plan, null)).resolves.toMatchObject({
      changedFiles: ["good.txt"],
    });
    expect(await readFile(path.join(root, "good.txt"), "utf8")).toBe("FIRST\nsecond\n");
    expect(await readFile(path.join(root, "overlap.txt"), "utf8")).toBe("first\nsecond\n");
    expect(await readFile(path.join(root, "mismatch.txt"), "utf8")).toBe("first\nsecond\n");
    expect(await readFile(path.join(root, "edited.txt"), "utf8")).toBe("user edit\n");
  } finally {
    await removeTemporaryProject(root);
  }
});

test.runIf(process.platform === "win32")(
  "rejects NTFS alternate streams and Windows path aliases",
  async () => {
    const root = await temporaryProject();
    try {
      const target = path.join(root, "download.txt");
      await writeFile(target, "old");
      await writeFile(`${target}:Zone.Identifier`, "[ZoneTransfer]");
      const plan = await planFileChanges(
        root,
        [
          {
            op: "replace",
            path: "download.txt",
            patch: "@@ -1 +1 @@\n-old\n+new\n",
            ruleIds: ["fmt/a"],
          },
        ],
        canWrite,
        await captureBaseline(root, ["download.txt"]),
      );
      await expect(applyFileChanges(plan, null)).rejects.toMatchObject({
        code: "FILE_METADATA_UNSUPPORTED",
      });
      expect(await readFile(target, "utf8")).toBe("old");
      expect(await readFile(`${target}:Zone.Identifier`, "utf8")).toBe("[ZoneTransfer]");

      for (const reserved of ["CON.txt", "trailing.", "trailing ", "file:stream"]) {
        await expect(
          planFileChanges(
            root,
            [{ op: "create", path: reserved, content: "x", ruleIds: ["fmt/a"] }],
            canWrite,
            new Map(),
          ),
        ).rejects.toMatchObject({ code: "PATH_INVALID" });
      }
    } finally {
      await removeTemporaryProject(root);
    }
  },
);

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
