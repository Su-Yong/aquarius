import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { applyFileChanges, captureBaseline, planFileChanges } from "../src/changes/apply";
import { createGitUndoStore, undoLastFileChanges } from "../src/undo/store";

const temporaryProject = async (): Promise<string> => {
  return await mkdtemp(path.join(tmpdir(), "aquarius-undo-"));
};

const removeTemporaryProject = async (root: string): Promise<void> => {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("aquarius-undo-")) {
    throw new Error(`Refusing to remove unexpected test path: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
};

const git = (root: string, arguments_: string[]): string => {
  return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
};

const gitProject = async (): Promise<string> => {
  const root = await temporaryProject();
  git(root, ["init", "--quiet"]);
  return root;
};

const canWrite = () => true;

test("undo restores dirty content without changing the index or unrelated edits", async () => {
  const root = await gitProject();
  try {
    await writeFile(path.join(root, "tracked.txt"), "index version\n");
    git(root, ["add", "tracked.txt"]);
    await writeFile(path.join(root, "tracked.txt"), "user dirty version\n");
    await writeFile(path.join(root, "unrelated.txt"), "before\n");
    const indexBefore = git(root, ["show", ":tracked.txt"]);
    const branchBefore = git(root, ["symbolic-ref", "--short", "HEAD"]);
    const baseline = await captureBaseline(root, ["tracked.txt"]);
    const plan = await planFileChanges(
      root,
      [
        {
          op: "replace",
          path: "tracked.txt",
          oldText: "user dirty version",
          newText: "formatted version",
          ruleIds: ["fmt/a"],
        },
      ],
      canWrite,
      baseline,
    );
    const store = await createGitUndoStore(root);
    expect(store).not.toBeNull();
    await applyFileChanges(plan, store);
    await writeFile(path.join(root, "unrelated.txt"), "after\n");
    git(root, ["reflog", "expire", "--expire=now", "--all"]);
    git(root, ["prune", "--expire=now"]);

    await expect(undoLastFileChanges(root)).resolves.toEqual(["tracked.txt"]);
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("user dirty version\n");
    expect(await readFile(path.join(root, "unrelated.txt"), "utf8")).toBe("after\n");
    expect(git(root, ["show", ":tracked.txt"])).toBe(indexBefore);
    expect(git(root, ["symbolic-ref", "--short", "HEAD"])).toBe(branchBefore);
    expect(git(root, ["for-each-ref", "--format=%(refname)", "refs/aquarius/aqfmt-undo"])).toBe("");
  } finally {
    await removeTemporaryProject(root);
  }
});

test("undo covers create, delete, move, replacement, and created directories", async () => {
  const root = await gitProject();
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "move.txt"), "move old\n");
    await writeFile(path.join(root, "delete.txt"), "delete me\n");
    const baseline = await captureBaseline(root, ["src/move.txt", "delete.txt"]);
    const plan = await planFileChanges(
      root,
      [
        { op: "replace", path: "src/move.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] },
        { op: "move", from: "src/move.txt", to: "created/deep/moved.txt", ruleIds: ["fmt/a"] },
        { op: "delete", path: "delete.txt", ruleIds: ["fmt/a"] },
        { op: "create", path: "created/new.txt", content: "new file\n", ruleIds: ["fmt/a"] },
      ],
      canWrite,
      baseline,
    );
    await applyFileChanges(plan, await createGitUndoStore(root));
    expect(await readFile(path.join(root, "created", "deep", "moved.txt"), "utf8")).toBe("move new\n");

    await undoLastFileChanges(root);
    expect(await readFile(path.join(root, "src", "move.txt"), "utf8")).toBe("move old\n");
    expect(await readFile(path.join(root, "delete.txt"), "utf8")).toBe("delete me\n");
    await expect(readFile(path.join(root, "created", "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, "created", "deep", "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await removeTemporaryProject(root);
  }
});

test("a later edit to one touched file rejects the entire undo", async () => {
  const root = await gitProject();
  try {
    await writeFile(path.join(root, "a.txt"), "a old");
    await writeFile(path.join(root, "b.txt"), "b old");
    const baseline = await captureBaseline(root, ["a.txt", "b.txt"]);
    const plan = await planFileChanges(
      root,
      [
        { op: "replace", path: "a.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] },
        { op: "replace", path: "b.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] },
      ],
      canWrite,
      baseline,
    );
    await applyFileChanges(plan, await createGitUndoStore(root));
    await writeFile(path.join(root, "a.txt"), "user follow-up");

    await expect(undoLastFileChanges(root)).rejects.toMatchObject({ code: "FILE_CHANGED" });
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("user follow-up");
    expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("b new");
  } finally {
    await removeTemporaryProject(root);
  }
});

test("a no-op keeps the previous record and a later real change replaces it", async () => {
  const root = await gitProject();
  try {
    await writeFile(path.join(root, "first.txt"), "first old");
    await writeFile(path.join(root, "second.txt"), "second old");
    const firstBaseline = await captureBaseline(root, ["first.txt"]);
    const firstPlan = await planFileChanges(
      root,
      [{ op: "replace", path: "first.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] }],
      canWrite,
      firstBaseline,
    );
    const store = await createGitUndoStore(root);
    await applyFileChanges(firstPlan, store);
    await applyFileChanges({ projectRoot: firstPlan.projectRoot, files: [] }, store);
    await undoLastFileChanges(root);
    expect(await readFile(path.join(root, "first.txt"), "utf8")).toBe("first old");

    const replayBaseline = await captureBaseline(root, ["first.txt"]);
    await applyFileChanges(
      await planFileChanges(
        root,
        [{ op: "replace", path: "first.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] }],
        canWrite,
        replayBaseline,
      ),
      await createGitUndoStore(root),
    );
    const secondBaseline = await captureBaseline(root, ["second.txt"]);
    await applyFileChanges(
      await planFileChanges(
        root,
        [{ op: "replace", path: "second.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] }],
        canWrite,
        secondBaseline,
      ),
      await createGitUndoStore(root),
    );
    await undoLastFileChanges(root);
    expect(await readFile(path.join(root, "first.txt"), "utf8")).toBe("first new");
    expect(await readFile(path.join(root, "second.txt"), "utf8")).toBe("second old");
  } finally {
    await removeTemporaryProject(root);
  }
});

test("a pre-write failure keeps the previous successful undo record", async () => {
  const root = await gitProject();
  try {
    await writeFile(path.join(root, "first.txt"), "first old");
    await writeFile(path.join(root, "second.txt"), "second old");
    const firstPlan = await planFileChanges(
      root,
      [{ op: "replace", path: "first.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] }],
      canWrite,
      await captureBaseline(root, ["first.txt"]),
    );
    await applyFileChanges(firstPlan, await createGitUndoStore(root));

    const secondPlan = await planFileChanges(
      root,
      [{ op: "replace", path: "second.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] }],
      canWrite,
      await captureBaseline(root, ["second.txt"]),
    );
    await writeFile(path.join(root, "second.txt"), "user edit");
    await expect(applyFileChanges(secondPlan, await createGitUndoStore(root))).rejects.toMatchObject({
      code: "FILE_CHANGED",
    });

    await undoLastFileChanges(root);
    expect(await readFile(path.join(root, "first.txt"), "utf8")).toBe("first old");
    expect(await readFile(path.join(root, "second.txt"), "utf8")).toBe("user edit");
  } finally {
    await removeTemporaryProject(root);
  }
});

test("non-Git projects still format but cannot undo", async () => {
  const root = await temporaryProject();
  try {
    await writeFile(path.join(root, "file.txt"), "old");
    const baseline = await captureBaseline(root, ["file.txt"]);
    const plan = await planFileChanges(
      root,
      [{ op: "replace", path: "file.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] }],
      canWrite,
      baseline,
    );
    expect(await createGitUndoStore(root)).toBeNull();
    await expect(applyFileChanges(plan, null)).resolves.toMatchObject({ undoAvailable: false });
    await expect(undoLastFileChanges(root)).rejects.toMatchObject({ code: "UNDO_UNAVAILABLE" });
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("new");
  } finally {
    await removeTemporaryProject(root);
  }
});

test("an incomplete pending transaction blocks new work and preserves its record", async () => {
  const root = await gitProject();
  try {
    await writeFile(path.join(root, "file.txt"), "old");
    const baseline = await captureBaseline(root, ["file.txt"]);
    const plan = await planFileChanges(
      root,
      [{ op: "replace", path: "file.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] }],
      canWrite,
      baseline,
    );
    const store = await createGitUndoStore(root);
    const transaction = await store!.begin(plan, []);
    await expect(createGitUndoStore(root)).rejects.toMatchObject({ code: "UNDO_INCOMPLETE" });
    await expect(readFile(store!.pendingPath, "utf8")).resolves.toContain('"version": 1');
    expect(git(root, ["for-each-ref", "--format=%(refname)", "refs/aquarius/aqfmt-undo"])).toContain("/pending");
    await transaction.abort();
  } finally {
    await removeTemporaryProject(root);
  }
});

test("recovers a lock owned by a dead process when no journal is pending", async () => {
  const root = await gitProject();
  try {
    await writeFile(path.join(root, "file.txt"), "old");
    const plan = await planFileChanges(
      root,
      [{ op: "replace", path: "file.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] }],
      canWrite,
      await captureBaseline(root, ["file.txt"]),
    );
    const store = await createGitUndoStore(root);
    const lockPath = store!.pendingPath.replace(/-pending\.json$/, ".lock");
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "999999999\n");

    await expect(applyFileChanges(plan, store)).resolves.toMatchObject({ changedFiles: ["file.txt"] });
    await undoLastFileChanges(root);
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("old");
  } finally {
    await removeTemporaryProject(root);
  }
});

test("serializes concurrent attempts to recover the same stale lock", async () => {
  const root = await gitProject();
  try {
    await writeFile(path.join(root, "file.txt"), "old");
    const plan = await planFileChanges(
      root,
      [{ op: "replace", path: "file.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] }],
      canWrite,
      await captureBaseline(root, ["file.txt"]),
    );
    const first = await createGitUndoStore(root);
    const second = await createGitUndoStore(root);
    const lockPath = first!.pendingPath.replace(/-pending\.json$/, ".lock");
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "999999999\n");

    const attempts = await Promise.allSettled([
      first!.begin(plan, []),
      second!.begin(plan, []),
    ]);
    const successful = attempts.filter((attempt) => attempt.status === "fulfilled");
    for (const attempt of successful) await attempt.value.abort();

    expect(successful).toHaveLength(1);
    const failed = attempts.find((attempt) => attempt.status === "rejected");
    expect(failed).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: expect.stringMatching(/^UNDO_(?:BUSY|INCOMPLETE)$/) }),
    });
  } finally {
    await removeTemporaryProject(root);
  }
});

test("undo preserves an identical user file created in the final write window", async () => {
  const root = await gitProject();
  try {
    const target = path.join(root, "file.txt");
    await writeFile(target, "old");
    const plan = await planFileChanges(
      root,
      [{ op: "replace", path: "file.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] }],
      canWrite,
      await captureBaseline(root, ["file.txt"]),
    );
    await applyFileChanges(plan, await createGitUndoStore(root));
    let injected = false;
    const injector = (async () => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          await writeFile(target, "old", { flag: "wx" });
          injected = true;
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    await expect(undoLastFileChanges(root)).rejects.toMatchObject({ code: "UNDO_ROLLBACK_INCOMPLETE" });
    await injector;
    expect(injected).toBe(true);
    expect(await readFile(target, "utf8")).toBe("old");
    await expect(createGitUndoStore(root)).rejects.toMatchObject({ code: "UNDO_INCOMPLETE" });
  } finally {
    await removeTemporaryProject(root);
  }
});

test("reports lock release failure without rolling back a committed change", async () => {
  const root = await gitProject();
  try {
    await writeFile(path.join(root, "file.txt"), "old");
    const plan = await planFileChanges(
      root,
      [{ op: "replace", path: "file.txt", oldText: "old", newText: "new", ruleIds: ["fmt/a"] }],
      canWrite,
      await captureBaseline(root, ["file.txt"]),
    );
    const store = await createGitUndoStore(root);
    const release = store!.releaseLock.bind(store);
    store!.releaseLock = async (lock) => {
      await release(lock);
      throw new Error("simulated release failure");
    };

    await expect(applyFileChanges(plan, store)).rejects.toMatchObject({
      code: "UNDO_RECORD_MAINTENANCE_FAILED",
    });
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("new");
    await undoLastFileChanges(root);
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("old");
  } finally {
    await removeTemporaryProject(root);
  }
});
