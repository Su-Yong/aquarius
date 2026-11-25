import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import { AquariusError, errorMessage } from "@aqtools/core/runtime";

import {
  absolutePath,
  assertFilePlanState,
  assertNoAlternateDataStreams,
  assertSafePath,
  assertStableParent,
  canonicalProjectRoot,
  currentStates,
  fileIdentity,
  fileStatesAndIdentityEqual,
  fileStatesEqual,
  pathKey,
  readAbsoluteFileState,
  readProjectFileState,
  slash,
} from "./state";
import type { FileChangePlan, FileState, PlannedFile, PlanSide, UndoStore } from "./types";

export class FileTransitionRecoveredError extends Error {
  constructor(readonly original: unknown) {
    super(`File transition failed and was restored: ${String(original)}`);
    this.name = "FileTransitionRecoveredError";
  }
}

export const applyFileChanges = async (
  plan: FileChangePlan,
  store: UndoStore | null,
): Promise<{ changedFiles: string[]; undoAvailable: boolean }> => {
  if (plan.files.length === 0) return { changedFiles: [], undoAvailable: store !== null };

  await assertFilePlanState(plan, "before");
  const directoryCandidates = await missingParentDirectories(plan.projectRoot, plan.files, "after");
  const transaction = store ? await store.begin(plan, directoryCandidates) : null;
  const createdDirectories: string[] = [];

  try {
    await transitionFilePlan(plan, "before", "after", false, createdDirectories);
    if (transaction) await transaction.commit(createdDirectories);
  } catch (error) {
    if (transaction?.committed) throw error;

    if (error instanceof FileTransitionRecoveredError) {
      try {
        await removeEmptyDirectories(plan.projectRoot, createdDirectories);
        if (transaction) await transaction.abort();
      } catch (cleanupError) {
        if (transaction) await transaction.preserve().catch(() => undefined);
        throw new AquariusError(
          "APPLY_ROLLBACK_INCOMPLETE",
          `File change was restored but cleanup failed (${String(cleanupError)}). Recovery data was preserved.`,
        );
      }
      throw error.original;
    }

    if (error instanceof AquariusError && error.code === "FILE_TRANSACTION_INCOMPLETE") {
      if (transaction) await transaction.preserve().catch(() => undefined);
      throw new AquariusError(
        "APPLY_ROLLBACK_INCOMPLETE",
        `${error.message}${transaction ? " Recovery data was preserved." : " Git recovery data is unavailable."}`,
      );
    }

    try {
      await transitionFilePlan(plan, "after", "before", true);
      await removeEmptyDirectories(plan.projectRoot, createdDirectories);
      if (transaction) await transaction.abort();
    } catch (rollbackError) {
      if (transaction) await transaction.preserve();
      throw new AquariusError(
        "APPLY_ROLLBACK_INCOMPLETE",
        `File change failed (${String(error)}) and rollback was incomplete (${String(rollbackError)}).${
          transaction ? " Recovery data was preserved." : " Git recovery data is unavailable."
        }`,
      );
    }
    throw error;
  }

  return { changedFiles: plan.files.map((file) => file.path), undoAvailable: store !== null };
};

export const transitionFilePlan = async (
  plan: FileChangePlan,
  from: PlanSide,
  to: PlanSide,
  allowMixedKnownStates = false,
  createdDirectoriesOutput: string[] = [],
): Promise<string[]> => {
  const canonical = await canonicalProjectRoot(plan.projectRoot);
  if (canonical !== plan.projectRoot)
    fail("PROJECT_ROOT_CHANGED", "The project root changed after planning");

  const verifySource = async (): Promise<Map<string, FileState | null>> => {
    const current = await currentStates(plan);
    for (const file of plan.files) {
      const actual = current.get(pathKey(file.path)) ?? null;
      const matchesFrom = fileStatesAndIdentityEqual(actual, file[from]);
      const matchesTo = fileStatesEqual(actual, file[to]);
      const sourceChanged = !matchesFrom && (!allowMixedKnownStates || !matchesTo);
      if (sourceChanged) {
        fail("FILE_CHANGED", `File changed while applying the transaction: ${file.path}`);
      }
    }
    return current;
  };

  await verifySource();
  const directoryCandidates = await missingParentDirectories(plan.projectRoot, plan.files, to);
  const createdStart = createdDirectoriesOutput.length;
  await createDirectories(plan.projectRoot, directoryCandidates, createdDirectoriesOutput);
  const createdDirectories = createdDirectoriesOutput.slice(createdStart);

  const staged = new Map<string, string>();
  const backups = new Map<string, string>();
  const installed = new Map<string, string>();
  let activeFiles: PlannedFile[] = [];
  let finalStateVerified = false;

  try {
    for (const file of plan.files) {
      const target = file[to];
      if (target !== null)
        staged.set(pathKey(file.path), await stageFile(plan.projectRoot, file.path, target));
    }

    const current = await verifySource();
    activeFiles = plan.files.filter(
      (file) => !fileStatesEqual(current.get(pathKey(file.path)) ?? null, file[to]),
    );

    for (const file of activeFiles) {
      const source = file[from];
      if (source === null) continue;
      const target = absolutePath(plan.projectRoot, file.path);
      const backup = siblingArtifact(plan.projectRoot, file.path, "backup");
      await assertStableParent(plan.projectRoot, file.path);
      await rename(target, backup);
      backups.set(pathKey(file.path), backup);

      await assertStableParent(plan.projectRoot, file.path);
      const moved = await readAbsoluteFileState(backup, file.path);
      if (!fileStatesAndIdentityEqual(moved, source)) {
        fail("FILE_CHANGED", `File changed while it was being secured for update: ${file.path}`);
      }
    }
    const backupPaths = [...backups.values()].map((backup) =>
      slash(path.relative(plan.projectRoot, backup)),
    );
    await assertNoAlternateDataStreams(plan.projectRoot, backupPaths);

    for (const file of activeFiles) {
      const temporary = staged.get(pathKey(file.path));
      if (!temporary) continue;
      const stagedState = await readAbsoluteFileState(temporary, file.path);
      const stagedIdentity = stagedState && fileIdentity(stagedState);
      if (!stagedIdentity)
        fail("FILE_IDENTITY_UNAVAILABLE", `Cannot identify staged file: ${file.path}`);

      await assertStableParent(plan.projectRoot, file.path);
      await link(temporary, absolutePath(plan.projectRoot, file.path));
      installed.set(pathKey(file.path), stagedIdentity);
      await assertStableParent(plan.projectRoot, file.path);

      await unlink(temporary);
      staged.delete(pathKey(file.path));
    }

    await cleanupTemporaryFiles(staged.values());
    staged.clear();

    await assertNoAlternateDataStreams(plan.projectRoot, [
      ...backupPaths,
      ...plan.files.map(({ path }) => path),
    ]);
    for (const file of activeFiles) {
      const backup = backups.get(pathKey(file.path));
      if (!backup) continue;
      const secured = await readAbsoluteFileState(backup, file.path);
      if (!fileStatesAndIdentityEqual(secured, file[from])) {
        fail("FILE_CHANGED", `The secured source was edited during the transaction: ${file.path}`);
      }
    }
    await assertPlanContentState(plan, to);
    finalStateVerified = true;

    for (const backup of backups.values()) await unlink(backup);
  } catch (error) {
    let cleanupError: unknown;
    try {
      await cleanupTemporaryFiles(staged.values());
      if (!finalStateVerified) {
        await restoreMovedSources(plan, activeFiles, from, to, backups, installed);
        await removeEmptyDirectories(plan.projectRoot, createdDirectories);
      }
    } catch (caught) {
      cleanupError = caught;
    }

    if (cleanupError) {
      throw new AquariusError(
        "FILE_TRANSACTION_INCOMPLETE",
        `File transition failed (${String(error)}) and local recovery failed (${errorMessage(cleanupError)}).`,
      );
    }
    if (!finalStateVerified) throw new FileTransitionRecoveredError(error);
    throw error;
  }

  return createdDirectories;
};

export const removeEmptyDirectories = async (
  root: string,
  directories: readonly string[],
): Promise<void> => {
  const sortedDirectories = [...new Set(directories)].sort(
    (left, right) => right.split("/").length - left.split("/").length,
  );

  for (const relativePath of sortedDirectories) {
    try {
      const absolute = await assertSafePath(root, relativePath);
      await rmdir(absolute);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const unexpectedRemovalError =
        code !== "ENOENT" &&
        code !== "ENOTEMPTY" &&
        code !== "EEXIST" &&
        code !== "SYMLINK_UNSUPPORTED";
      if (unexpectedRemovalError) {
        throw error;
      }
    }
  }
};

const fail: (code: string, message: string) => never = (code, message) => {
  throw new AquariusError(code, message);
};

const missingParentDirectories = async (
  root: string,
  files: readonly PlannedFile[],
  side: PlanSide,
): Promise<string[]> => {
  const missing = new Map<string, string>();
  for (const file of files) {
    if (file[side] === null) continue;
    let parent = path.posix.dirname(file.path);
    while (parent !== ".") {
      const key = pathKey(parent);
      if (missing.has(key)) {
        parent = path.posix.dirname(parent);
        continue;
      }

      const absolute = await assertSafePath(root, parent);
      try {
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink())
          fail("SYMLINK_UNSUPPORTED", `Symbolic links are not supported: ${parent}`);
        if (!stat.isDirectory())
          fail("PATH_PARENT_INVALID", `Path parent is not a directory: ${parent}`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing.set(key, parent);
      }
      parent = path.posix.dirname(parent);
    }
  }

  return [...missing.values()].sort(
    (left, right) => left.split("/").length - right.split("/").length,
  );
};

const createDirectories = async (
  root: string,
  directories: readonly string[],
  createdOutput: string[],
): Promise<void> => {
  const created: string[] = [];

  try {
    for (const relativePath of directories) {
      const absolute = await assertSafePath(root, relativePath);
      try {
        await mkdir(absolute);
        created.push(relativePath);
        createdOutput.push(relativePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          fail("PATH_PARENT_INVALID", `Path parent became unsafe: ${relativePath}`);
        }
      }
    }
  } catch (error) {
    try {
      await removeEmptyDirectories(root, created);
    } catch (cleanupError) {
      throw new AquariusError(
        "DIRECTORY_ROLLBACK_INCOMPLETE",
        `Directory creation failed (${String(error)}) and cleanup failed (${String(cleanupError)}).`,
      );
    }
    throw error;
  }
};

const stageFile = async (root: string, relativePath: string, state: FileState): Promise<string> => {
  const target = absolutePath(root, relativePath);
  const temporary = path.join(path.dirname(target), `.aqfmt-${randomUUID()}.tmp`);
  await assertStableParent(root, relativePath);

  const handle = await open(temporary, "wx", state.mode);
  try {
    await handle.writeFile(state.content);
    await handle.chmod(state.mode);
    await handle.sync();
    await handle.close();
    await assertStableParent(root, relativePath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }

  return temporary;
};

const cleanupTemporaryFiles = async (files: Iterable<string>): Promise<void> => {
  for (const file of files) {
    try {
      await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
};

const siblingArtifact = (root: string, relativePath: string, suffix: string): string => {
  const target = absolutePath(root, relativePath);
  return path.join(path.dirname(target), `.aqfmt-${randomUUID()}.${suffix}`);
};

const assertPlanContentState = async (plan: FileChangePlan, side: PlanSide): Promise<void> => {
  const current = await currentStates(plan);

  for (const file of plan.files) {
    if (!fileStatesEqual(current.get(pathKey(file.path)) ?? null, file[side])) {
      fail("FILE_CHANGED", `File no longer matches the expected ${side} content: ${file.path}`);
    }
  }
};

const restoreMovedSources = async (
  plan: FileChangePlan,
  activeFiles: readonly PlannedFile[],
  from: PlanSide,
  to: PlanSide,
  backups: ReadonlyMap<string, string>,
  installed: ReadonlyMap<string, string>,
): Promise<void> => {
  await assertNoAlternateDataStreams(
    plan.projectRoot,
    activeFiles.map(({ path }) => path),
  );

  for (const file of [...activeFiles].reverse()) {
    const key = pathKey(file.path);
    const target = absolutePath(plan.projectRoot, file.path);
    const backup = backups.get(key);
    const current = await readProjectFileState(plan.projectRoot, file.path);

    if (backup) {
      const selectRollbackPath = (): string | undefined => {
        if (current === null) return undefined;

        const installedIdentity = installed.get(key);
        const installedFileChanged =
          !installedIdentity ||
          fileIdentity(current) !== installedIdentity ||
          !fileStatesEqual(current, file[to]);
        if (installedFileChanged) {
          fail(
            "FILE_CHANGED",
            `A user file appeared while restoring ${file.path}; backup was preserved at ${backup}`,
          );
        }

        return siblingArtifact(plan.projectRoot, file.path, "rollback");
      };

      const displaced = selectRollbackPath();
      if (displaced) {
        await assertStableParent(plan.projectRoot, file.path);
        await rename(target, displaced);
        await assertStableParent(plan.projectRoot, file.path);
      }

      try {
        await link(backup, target);
        await assertStableParent(plan.projectRoot, file.path);
        await unlink(backup);
      } catch (error) {
        if (displaced && (await readProjectFileState(plan.projectRoot, file.path)) === null) {
          await link(displaced, target).catch(() => undefined);
        }
        throw error;
      }

      if (displaced) await unlink(displaced);
    } else if (file[from] === null && current !== null) {
      const installedIdentity = installed.get(key);
      const installedFileChanged =
        !installedIdentity ||
        fileIdentity(current) !== installedIdentity ||
        !fileStatesEqual(current, file[to]);
      if (installedFileChanged) {
        fail("FILE_CHANGED", `A user file replaced the created path during rollback: ${file.path}`);
      }

      const discarded = siblingArtifact(plan.projectRoot, file.path, "rollback");
      await assertStableParent(plan.projectRoot, file.path);
      await rename(target, discarded);
      await assertStableParent(plan.projectRoot, file.path);
      await unlink(discarded);
    }
  }

  await assertPlanContentState(plan, from);
};
