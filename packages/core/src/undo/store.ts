import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import {
  assertFilePlanState,
  canonicalProjectRoot,
  FileTransitionRecoveredError,
  removeEmptyDirectories,
  transitionFilePlan,
} from "../changes/apply";
import { AquariusError } from "../shared/errors";
import type { FileChangePlan, FileState } from "../changes/types";
import { parseUndoManifest } from "./schema";
import type { StoredFile, StoredFileState, UndoManifest } from "./schema";

const fail: (code: string, message: string) => never = (code, message) => {
  throw new AquariusError(code, message);
};

const rootKey = (root: string): string => {
  return createHash("sha256").update(root).digest("hex").slice(0, 24);
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const runGit = async (root: string, arguments_: readonly string[], input?: Uint8Array): Promise<Buffer> => {
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
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `git exited with status ${code}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ? Buffer.from(input) : undefined);
  });
};

const writeJsonAtomic = async (file: string, value: unknown): Promise<void> => {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

export class GitUndoTransaction {
  private finished = false;
  committed = false;

  constructor(
    private readonly store: GitUndoStore,
    private readonly manifest: UndoManifest,
    private readonly lock: FileHandle,
  ) {}

  async commit(createdDirectories: readonly string[]): Promise<void> {
    if (this.finished) fail("UNDO_TRANSACTION_CLOSED", "Undo transaction is already closed");
    const completed = { ...this.manifest, createdDirectories: [...createdDirectories] };
    const tree = await this.store.pinPending(completed);
    await writeJsonAtomic(this.store.pendingPath, completed);
    await this.store.movePendingRefToLast(tree);
    this.committed = true;
    let maintenanceFailure: unknown;
    try {
      await writeJsonAtomic(this.store.manifestPath, completed);
    } catch (error) {
      maintenanceFailure = error;
    }
    try {
      await unlink(this.store.pendingPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") maintenanceFailure ??= error;
    }
    this.finished = true;
    try {
      await this.store.releaseLock(this.lock);
    } catch (error) {
      maintenanceFailure ??= error;
    }
    if (maintenanceFailure) {
      throw new AquariusError(
        "UNDO_RECORD_MAINTENANCE_FAILED",
        `The change and pinned undo record succeeded, but local cleanup failed: ${String(maintenanceFailure)}`,
      );
    }
  }

  async abort(): Promise<void> {
    if (this.finished) return;
    await unlink(this.store.pendingPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await this.store.deletePendingRef();
    this.finished = true;
    await this.store.releaseLock(this.lock);
  }

  async preserve(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.store.releaseLock(this.lock);
  }
}

export class GitUndoStore {
  readonly manifestPath: string;
  readonly pendingPath: string;
  private readonly lockPath: string;
  private readonly recoveryLockPath: string;
  private readonly manifestRef: string;
  private readonly pendingRef: string;

  constructor(
    readonly projectRoot: string,
    private readonly directory: string,
  ) {
    const key = rootKey(projectRoot);
    this.manifestPath = path.join(directory, `${key}-last.json`);
    this.pendingPath = path.join(directory, `${key}-pending.json`);
    this.lockPath = path.join(directory, `${key}.lock`);
    this.recoveryLockPath = path.join(directory, `${key}.recover.lock`);
    this.manifestRef = `refs/aquarius/aqfmt-undo/${key}/last`;
    this.pendingRef = `refs/aquarius/aqfmt-undo/${key}/pending`;
  }

  private async acquireLock(): Promise<FileHandle> {
    await mkdir(this.directory, { recursive: true });
    const createOwnedLock = async (): Promise<FileHandle | undefined> => {
      let lock: FileHandle;
      try {
        lock = await open(this.lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
        throw error;
      }
      try {
        await lock.writeFile(`${process.pid}\n`, "utf8");
        await lock.sync();
        return lock;
      } catch (error) {
        await lock.close().catch(() => undefined);
        await unlink(this.lockPath).catch((caught: NodeJS.ErrnoException) => {
          if (caught.code !== "ENOENT") throw caught;
        });
        throw error;
      }
    };

    const immediate = await createOwnedLock();
    if (immediate) return immediate;

    let recovery: FileHandle;
    try {
      recovery = await open(this.recoveryLockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        fail("UNDO_BUSY", `Another aqfmt process is recovering the transaction lock: ${this.recoveryLockPath}`);
      }
      throw error;
    }
    try {
      await recovery.writeFile(`${process.pid}\n`, "utf8");
      await recovery.sync();
      const appeared = await createOwnedLock();
      if (appeared) return appeared;
      if (await this.hasPending()) {
        fail("UNDO_INCOMPLETE", `An incomplete aqfmt transaction must be recovered first: ${this.pendingPath}`);
      }
      let owner = Number.NaN;
      try {
        owner = Number.parseInt((await readFile(this.lockPath, "utf8")).trim(), 10);
      } catch {
        fail("UNDO_BUSY", `The aqfmt transaction lock owner cannot be verified: ${this.lockPath}`);
      }
      if (!Number.isInteger(owner) || owner <= 0) {
        fail("UNDO_BUSY", `The aqfmt transaction lock owner is invalid: ${this.lockPath}`);
      }
      let alive = true;
      try {
        process.kill(owner, 0);
      } catch (caught) {
        alive = (caught as NodeJS.ErrnoException).code !== "ESRCH";
      }
      if (alive) fail("UNDO_BUSY", `Another aqfmt file transaction owns the lock: ${this.lockPath}`);
      await unlink(this.lockPath).catch((caught: NodeJS.ErrnoException) => {
        if (caught.code !== "ENOENT") throw caught;
      });
      const reclaimed = await createOwnedLock();
      if (!reclaimed) fail("UNDO_BUSY", `Another aqfmt process acquired the transaction lock: ${this.lockPath}`);
      return reclaimed;
    } finally {
      await recovery.close().catch(() => undefined);
      await unlink(this.recoveryLockPath).catch(() => undefined);
    }
  }

  async releaseLock(lock: FileHandle): Promise<void> {
    let failure: unknown;
    try {
      await lock.close();
    } catch (error) {
      failure = error;
    }
    try {
      await unlink(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure ??= error;
    }
    if (failure) {
      throw new AquariusError("UNDO_LOCK_RELEASE_FAILED", `Could not release aqfmt transaction lock: ${String(failure)}`);
    }
  }

  private async hashObject(content: Uint8Array): Promise<string> {
    const oid = (await runGit(this.projectRoot, ["hash-object", "-w", "--stdin"], content)).toString("utf8").trim();
    if (!/^[0-9a-f]{40,64}$/.test(oid)) fail("GIT_UNDO_FAILED", "git hash-object returned an invalid object ID");
    return oid;
  }

  private async storeState(state: FileState | null): Promise<StoredFileState | null> {
    if (state === null) return null;
    return { blob: await this.hashObject(state.content), mode: state.mode };
  }

  private async loadState(state: StoredFileState | null): Promise<FileState | null> {
    if (state === null) return null;
    return {
      content: new Uint8Array(await runGit(this.projectRoot, ["cat-file", "blob", state.blob])),
      mode: state.mode,
    };
  }

  private async readRef(ref: string): Promise<string | undefined> {
    try {
      const oid = (await runGit(this.projectRoot, ["rev-parse", "--verify", ref])).toString("utf8").trim();
      return /^[0-9a-f]{40,64}$/.test(oid) ? oid : undefined;
    } catch {
      return undefined;
    }
  }

  private async updateRefs(commands: string): Promise<void> {
    await runGit(this.projectRoot, ["update-ref", "--stdin"], Buffer.from(`start\n${commands}prepare\ncommit\n`));
  }

  private async manifestTree(manifest: UndoManifest): Promise<string> {
    const entries: { name: string; blob: string }[] = [{
      name: "manifest.json",
      blob: await this.hashObject(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)),
    }];
    for (const [index, file] of manifest.files.entries()) {
      if (file.before) entries.push({ name: `${index.toString().padStart(6, "0")}-before`, blob: file.before.blob });
      if (file.after) entries.push({ name: `${index.toString().padStart(6, "0")}-after`, blob: file.after.blob });
    }
    const treeInput = entries.map(({ name, blob }) => `100644 blob ${blob}\t${name}\n`).join("");
    const tree = (await runGit(this.projectRoot, ["mktree"], Buffer.from(treeInput))).toString("utf8").trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) fail("GIT_UNDO_FAILED", "git mktree returned an invalid object ID");
    return tree;
  }

  async hasPending(): Promise<boolean> {
    return await exists(this.pendingPath) || (await this.readRef(this.pendingRef)) !== undefined;
  }

  async pinPending(manifest: UndoManifest): Promise<string> {
    const tree = await this.manifestTree(manifest);
    await runGit(this.projectRoot, ["update-ref", this.pendingRef, tree]);
    return tree;
  }

  async movePendingRefToLast(tree: string): Promise<void> {
    await this.updateRefs(`update ${this.manifestRef} ${tree}\ndelete ${this.pendingRef} ${tree}\n`);
  }

  async deletePendingRef(): Promise<void> {
    const pending = await this.readRef(this.pendingRef);
    if (pending) await runGit(this.projectRoot, ["update-ref", "-d", this.pendingRef, pending]);
  }

  private async moveLastRefToPending(last: string): Promise<void> {
    await this.updateRefs(`update ${this.pendingRef} ${last}\ndelete ${this.manifestRef} ${last}\n`);
  }

  private async restorePendingRefToLast(pending: string): Promise<void> {
    await this.updateRefs(`update ${this.manifestRef} ${pending}\ndelete ${this.pendingRef} ${pending}\n`);
  }

  private async readManifest(): Promise<string> {
    const last = await this.readRef(this.manifestRef);
    if (!last) fail("UNDO_NOT_FOUND", "There is no aqfmt change to undo");
    try {
      return (await runGit(this.projectRoot, ["show", `${this.manifestRef}:manifest.json`])).toString("utf8");
    } catch (error) {
      throw new AquariusError("UNDO_RECORD_INVALID", `Cannot read the pinned undo manifest: ${String(error)}`);
    }
  }

  async begin(plan: FileChangePlan, createdDirectories: readonly string[]): Promise<GitUndoTransaction> {
    if (plan.projectRoot !== this.projectRoot) fail("PROJECT_ROOT_CHANGED", "Undo store and file plan roots differ");
    const lock = await this.acquireLock();
    try {
      if (await this.hasPending()) {
        fail("UNDO_INCOMPLETE", `An incomplete aqfmt transaction must be recovered first: ${this.pendingPath}`);
      }
      const files: StoredFile[] = [];
      for (const file of plan.files) {
        files.push({
          path: file.path,
          before: await this.storeState(file.before),
          after: await this.storeState(file.after),
        });
      }
      const manifest: UndoManifest = {
        version: 1,
        projectRoot: this.projectRoot,
        files,
        createdDirectories: [...createdDirectories],
      };
      await writeJsonAtomic(this.pendingPath, manifest);
      await this.pinPending(manifest);
      return new GitUndoTransaction(this, manifest, lock);
    } catch (error) {
      await unlink(this.pendingPath).catch(() => undefined);
      await this.deletePendingRef().catch(() => undefined);
      await this.releaseLock(lock);
      throw error;
    }
  }

  async undo(): Promise<string[]> {
    const lock = await this.acquireLock();
    try {
      if (await this.hasPending()) {
        fail("UNDO_INCOMPLETE", `An incomplete aqfmt transaction must be recovered first: ${this.pendingPath}`);
      }
      const raw = await this.readManifest();
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        fail("UNDO_RECORD_INVALID", `Undo record is not valid JSON: ${this.manifestPath}`);
      }
      const manifest = parseUndoManifest(decoded, this.projectRoot);
      const files = [];
      for (const file of manifest.files) {
        files.push({
          path: file.path,
          before: await this.loadState(file.before),
          after: await this.loadState(file.after),
        });
      }
      const plan: FileChangePlan = { projectRoot: this.projectRoot, files };
      await assertFilePlanState(plan, "after");
      const last = await this.readRef(this.manifestRef);
      if (!last) fail("UNDO_NOT_FOUND", "There is no aqfmt change to undo");
      await writeJsonAtomic(this.pendingPath, manifest);
      try {
        await this.moveLastRefToPending(last);
      } catch (error) {
        await unlink(this.pendingPath).catch(() => undefined);
        throw error;
      }
      await unlink(this.manifestPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      try {
        await transitionFilePlan(plan, "after", "before");
        await removeEmptyDirectories(this.projectRoot, manifest.createdDirectories);
        await unlink(this.pendingPath);
        await this.deletePendingRef();
      } catch (error) {
        if (error instanceof AquariusError && error.code === "FILE_TRANSACTION_INCOMPLETE") {
          fail(
            "UNDO_ROLLBACK_INCOMPLETE",
            `Undo could not be restored automatically (${error.message}). Recovery data remains at ${this.pendingPath}`,
          );
        }
        try {
          if (!(error instanceof FileTransitionRecoveredError)) {
            await transitionFilePlan(plan, "before", "after", true);
          }
          const pending = await this.readRef(this.pendingRef);
          if (pending) await this.restorePendingRefToLast(pending);
          await writeJsonAtomic(this.manifestPath, manifest);
          await unlink(this.pendingPath).catch((caught: NodeJS.ErrnoException) => {
            if (caught.code !== "ENOENT") throw caught;
          });
        } catch (rollbackError) {
          fail(
            "UNDO_ROLLBACK_INCOMPLETE",
            `Undo failed (${String(error)}) and rollback was incomplete (${String(rollbackError)}). Recovery data remains at ${this.pendingPath}`,
          );
        }
        throw error instanceof FileTransitionRecoveredError ? error.original : error;
      }
      return plan.files.map((file) => file.path);
    } finally {
      await this.releaseLock(lock);
    }
  }
}

export const createGitUndoStore = async (root: string): Promise<GitUndoStore | null> => {
  const projectRoot = await canonicalProjectRoot(root);
  let inside: string;
  let gitDirectory: string;
  try {
    inside = (await runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"])).toString("utf8").trim();
    gitDirectory = (await runGit(projectRoot, ["rev-parse", "--path-format=absolute", "--git-dir"]))
      .toString("utf8")
      .trim();
  } catch {
    return null;
  }
  if (inside !== "true" || !gitDirectory) return null;
  const canonicalGitDirectory = await realpath(gitDirectory);
  const store = new GitUndoStore(projectRoot, path.join(canonicalGitDirectory, "aquarius", "aqfmt-undo"));
  if (await store.hasPending()) {
    fail("UNDO_INCOMPLETE", `An incomplete aqfmt transaction must be recovered first: ${store.pendingPath}`);
  }
  return store;
};

export const undoLastFileChanges = async (root: string): Promise<string[]> => {
  const store = await createGitUndoStore(root);
  if (!store) fail("UNDO_UNAVAILABLE", "Git undo is unavailable because the project is not in a Git worktree");
  return await store.undo();
};
