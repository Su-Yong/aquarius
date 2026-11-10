import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { formatInstructionsSchema, lintInstructionsSchema } from "../rules/schemas";
import { AquariusError } from "../shared/errors";
import type { PreparedRule } from "../rules/types";
import type { ToolKind } from "../shared/types";
import type { PreparedRuleResources, RuleResourceFile } from "./types";

const TEMP_PREFIX = "aquarius-rule-resources-";

interface ResourceOptions {
  projectRoot: string;
  tool: ToolKind;
  rules: readonly PreparedRule[];
  signal?: AbortSignal;
  onWarning?: (message: string) => void;
}

interface DirectoryIdentity {
  path: string;
  stat: BigIntStats;
}

interface CacheDirectory {
  path: string;
  directories: DirectoryIdentity[];
}

const hasCode = (error: unknown, code: string): boolean => {
  return error instanceof Error && "code" in error && error.code === code;
};

const assertActive = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new AquariusError("AI_ABORTED", "Rule resource preparation was cancelled.");
  }
};

const hash = (content: string | Uint8Array): string => {
  return createHash("sha256").update(content).digest("hex");
};

const inspectDirectory = async (path: string): Promise<DirectoryIdentity> => {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path) {
    throw new Error("Rule cache directory is not a regular canonical directory.");
  }
  return { path, stat };
};

const assertDirectories = async (directories: readonly DirectoryIdentity[]): Promise<void> => {
  for (const directory of directories) {
    const current = await inspectDirectory(directory.path);
    if (current.stat.dev !== directory.stat.dev || current.stat.ino !== directory.stat.ino) {
      throw new Error("Rule cache directory changed during access.");
    }
  }
};

const prepareCacheDirectory = async (projectRoot: string): Promise<CacheDirectory | undefined> => {
  const directories = [await inspectDirectory(projectRoot)];
  let path = join(projectRoot, "node_modules");
  try {
    directories.push(await inspectDirectory(path));
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }

  for (const segment of [".cache", "aquarius"]) {
    await assertDirectories(directories);
    path = join(path, segment);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
    }
    directories.push(await inspectDirectory(path));
  }
  return { path, directories };
};

const readCachedContent = async (
  cache: CacheDirectory,
  fileName: string,
): Promise<Buffer | undefined> => {
  await assertDirectories(cache.directories);
  const path = join(cache.path, fileName);
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Rule cache entry is not a regular file.");
  }

  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Rule cache entry changed before reading.");
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      BigInt(content.length) !== after.size
    ) {
      throw new Error("Rule cache entry changed while reading.");
    }
    await assertDirectories(cache.directories);
    return content;
  } finally {
    await handle.close();
  }
};

const writeCachedContent = async (
  cache: CacheDirectory,
  fileName: string,
  content: Buffer,
  signal?: AbortSignal,
): Promise<void> => {
  assertActive(signal);
  await assertDirectories(cache.directories);
  const destination = join(cache.path, fileName);
  const temporary = join(cache.path, `.${fileName}.${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    assertActive(signal);
    await assertDirectories(cache.directories);
    try {
      const target = await lstat(destination);
      if (!target.isFile() || target.isSymbolicLink()) {
        throw new Error("Rule cache replacement target is not a regular file.");
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    }
    await rename(temporary, destination);
    await assertDirectories(cache.directories);
  } finally {
    try {
      await assertDirectories(cache.directories);
      await rm(temporary, { force: true });
    } catch {
      // A replaced directory is no longer ours to clean through this path.
    }
  }
};

export const prepareRuleResources = async (
  options: ResourceOptions,
): Promise<PreparedRuleResources> => {
  assertActive(options.signal);
  const schema = z.strictObject({
    ruleId: z.string().trim().min(1),
    scope: z.enum(["file", "module", "project"]),
    instructions: options.tool === "lint" ? lintInstructionsSchema : formatInstructionsSchema,
  });
  const seen = new Set<string>();
  const serializedRules = options.rules.map((rule) => {
    assertActive(options.signal);
    const parsed = schema.safeParse({
      ruleId: rule.id,
      scope: rule.scope,
      instructions: rule.instructions,
    });
    if (!parsed.success || parsed.data.ruleId !== rule.id || seen.has(rule.id)) {
      throw new AquariusError("INVALID_RULE_RESOURCE", `Invalid or repeated rule: ${rule.id}`);
    }
    seen.add(rule.id);
    const content = Buffer.from(`${JSON.stringify(parsed.data, null, 2)}\n`);
    return {
      detail: parsed.data,
      content,
      contentHash: hash(content),
      fileName: `${options.tool}-${hash(rule.id)}.json`,
    };
  });

  const projectRoot = await realpath(options.projectRoot);
  await inspectDirectory(projectRoot);
  const createdDirectory = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const createdStat = await lstat(createdDirectory, { bigint: true });
  const warn = (message: string): void => {
    try {
      options.onWarning?.(message);
    } catch {
      // A warning callback must not replace the analysis result or its original error.
    }
  };
  const dispose = async (): Promise<void> => {
    try {
      const current = await lstat(createdDirectory, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== createdStat.dev ||
        current.ino !== createdStat.ino
      ) {
        warn("Temporary rule resource directory changed; refusing to remove its replacement.");
        return;
      }
      await rm(createdDirectory, { recursive: true, force: true });
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        warn("Temporary rule resources could not be removed.");
      }
    }
  };

  try {
    const directory = await realpath(createdDirectory);
    const prefix = `.aquarius-rules-${basename(directory).slice(TEMP_PREFIX.length)}`;
    await mkdir(join(directory, prefix), { mode: 0o700 });
    let cache: CacheDirectory | undefined;
    if (serializedRules.length > 0) {
      try {
        cache = await prepareCacheDirectory(projectRoot);
      } catch {
        warn("Rule cache is unavailable; using temporary rule resources.");
      }
    }

    const files: RuleResourceFile[] = [];
    for (const rule of serializedRules) {
      assertActive(options.signal);
      let content: Buffer = rule.content;
      if (cache) {
        try {
          const cached = await readCachedContent(cache, rule.fileName);
          if (cached && hash(cached) === rule.contentHash) {
            content = cached;
          } else {
            if (cached) {
              let valid = false;
              try {
                const parsed = schema.safeParse(JSON.parse(cached.toString("utf8")));
                valid = parsed.success && parsed.data.ruleId === rule.detail.ruleId;
              } catch {
                valid = false;
              }
              if (!valid) {
                warn(`Rule cache is invalid for ${rule.detail.ruleId}; rebuilding its resource.`);
              }
            }
            await writeCachedContent(cache, rule.fileName, content, options.signal);
          }
        } catch {
          assertActive(options.signal);
          warn(
            `Rule cache could not be used for ${rule.detail.ruleId}; using temporary rule data.`,
          );
        }
      }
      assertActive(options.signal);
      const detailsPath = `${prefix}/${rule.fileName}`;
      await writeFile(join(directory, detailsPath), content, {
        flag: "wx",
        mode: 0o400,
        signal: options.signal,
      });
      files.push({
        ruleId: rule.detail.ruleId,
        scope: rule.detail.scope,
        applicability: rule.detail.instructions.applicability,
        detailsPath,
        contentHash: rule.contentHash,
      });
    }
    assertActive(options.signal);
    return { resources: { directory, files }, dispose };
  } catch (error) {
    await dispose();
    assertActive(options.signal);
    throw error;
  }
};
