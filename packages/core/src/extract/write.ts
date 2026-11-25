import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { CONFIG_NAMES, readConfig, validateConfig } from "../config/load";
import { AquariusError, isNodeError } from "../shared/errors";
import type { ProjectConfig } from "../config/types";
import type { RuleSettings } from "../rules/types";
import type { ToolKind } from "../shared/types";

interface AssemblyOptions {
  tool: ToolKind;
  existing?: ProjectConfig;
  ai: NonNullable<ProjectConfig["ai"]>;
  plugins: string[];
  preset: string[];
  rules: RuleSettings;
}

interface SaveOptions {
  cwd: string;
  write?: boolean;
  output?: string;
  force?: boolean;
  merge?: boolean;
  observedRules?: RuleSettings;
  signal?: AbortSignal;
}

export const assembleExtractedConfig = ({
  tool,
  existing,
  ai,
  plugins,
  preset,
  rules,
}: AssemblyOptions): ProjectConfig =>
  validateConfig(tool, {
    ...(existing?.files !== undefined && { files: existing.files }),
    ...(existing?.ignore !== undefined && { ignore: existing.ignore }),
    plugins,
    preset,
    rules,
    ai,
  });

export const serializeExtractedConfig = (config: ProjectConfig): string =>
  `${JSON.stringify(config, null, 2)}\n`;

export const preflightExtractedConfigOutput = async (
  tool: ToolKind,
  options: SaveOptions,
): Promise<void> => {
  await inspectOutput(tool, options);
};

export const saveExtractedConfig = async (
  tool: ToolKind,
  config: ProjectConfig,
  options: SaveOptions,
): Promise<{ config: ProjectConfig; outputPath?: string }> => {
  assertNotAborted(options.signal);
  const extracted = validateConfig(tool, config);
  const destination = await inspectOutput(tool, options);
  if (!destination) return { config: extracted };

  const { outputPath, existing, current, parentExists } = destination;
  const updated = existing ? mergeConfig(existing, extracted, options.observedRules) : extracted;
  const validated = validateConfig(tool, updated);
  assertNotAborted(options.signal);

  try {
    if (!parentExists) {
      await mkdir(dirname(outputPath), { recursive: true }).catch((error: unknown) => {
        if (isNodeError(error, "EEXIST")) throw invalidOutputParent(outputPath);
        throw error;
      });
    }
    await publishConfig(outputPath, serializeExtractedConfig(validated), current, options.signal);
  } catch (error) {
    if (isInvalidPath(error)) throw invalidOutputParent(outputPath);
    throw error;
  }
  return { config: validated, outputPath };
};

const inspectOutput = async (tool: ToolKind, options: SaveOptions) => {
  assertNotAborted(options.signal);
  if (options.force && options.merge) {
    throw new AquariusError("EXTRACT_CONFIG_WRITE_MODE", "Choose either --force or --merge.");
  }

  const destination = options.output ?? (options.write ? CONFIG_NAMES[tool][0] : undefined);
  if (destination === undefined) return undefined;

  const outputPath = resolve(options.cwd, destination);
  if (options.merge && extname(outputPath).toLowerCase() === ".jsonc") {
    throw new AquariusError(
      "EXTRACT_CONFIG_JSONC_MERGE",
      `Cannot merge into ${outputPath} because comments may be lost. Use --force by itself to overwrite it or choose a .json path.`,
    );
  }
  const parentExists = await checkOutputParent(outputPath);
  let current: OutputState | undefined;
  try {
    current = await readOutputState(outputPath);
  } catch (error) {
    if (isInvalidPath(error)) throw invalidOutputParent(outputPath);
    throw error;
  }
  if (current && !current.isFile()) {
    throw new AquariusError(
      "EXTRACT_CONFIG_OUTPUT_INVALID",
      `Expected a regular configuration file at ${outputPath}.`,
    );
  }
  if (current && !options.force && !options.merge) throw outputConflict(outputPath);
  const existing =
    options.merge && current ? validateConfig(tool, await readConfig(outputPath)) : undefined;
  return { outputPath, current, existing, parentExists };
};

const checkOutputParent = async (outputPath: string): Promise<boolean> => {
  const parent = dirname(outputPath);
  let directory = parent;
  try {
    while (true) {
      const entry = await readOutputState(directory);
      if (
        entry?.isDirectory() ||
        (entry?.isSymbolicLink() && (await stat(directory)).isDirectory())
      ) {
        return directory === parent;
      }
      const ancestor = dirname(directory);
      if (entry || ancestor === directory) break;
      directory = ancestor;
    }
  } catch (error) {
    if (!isInvalidPath(error)) throw error;
  }
  throw invalidOutputParent(outputPath);
};

const mergeConfig = (
  existing: ProjectConfig,
  extracted: ProjectConfig,
  observedRules = extracted.rules ?? {},
): ProjectConfig => {
  const rules = { ...existing.rules, ...extracted.rules };
  for (const [id, setting] of Object.entries(existing.rules ?? {})) {
    // A newly observed rule can have moved into a preset during compression.
    rules[id] = Object.hasOwn(observedRules, id) ? observedRules[id]! : setting;
  }

  return {
    ...existing,
    plugins: [...new Set([...(existing.plugins ?? []), ...(extracted.plugins ?? [])])],
    preset: [...new Set([...(existing.preset ?? []), ...(extracted.preset ?? [])])],
    rules,
  };
};

const readOutputState = async (path: string) => {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
};

type OutputState = NonNullable<Awaited<ReturnType<typeof readOutputState>>>;

const publishConfig = async (
  path: string,
  content: string,
  current: OutputState | undefined,
  signal?: AbortSignal,
): Promise<void> => {
  assertNotAborted(signal);
  const temporary = join(dirname(path), `.aquarius-extract-${randomUUID()}.tmp`);
  const mode = current || process.platform === "win32" ? 0o600 : 0o666;
  const handle = await open(temporary, "wx", mode);

  try {
    try {
      await handle.writeFile(content, { encoding: "utf8", signal });
      if (current) await handle.chmod(Number(current.mode & 0o777n));
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
    await handle.close();

    assertNotAborted(signal);
    if (current) await replaceConfig(path, temporary, current, signal);
    else {
      // The hard link atomically publishes the complete file without replacing a concurrent create.
      await link(temporary, path);
    }
  } catch (error) {
    assertNotAborted(signal);
    if (isNodeError(error, "EEXIST")) throw outputConflict(path);
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
};

const replaceConfig = async (
  path: string,
  temporary: string,
  current: OutputState,
  signal?: AbortSignal,
): Promise<void> => {
  const nameHash = createHash("sha256").update(basename(path).toLowerCase()).digest("hex");
  const pending = join(dirname(path), `.aquarius-extract-${nameHash}.pending`);

  // One writer can hold the staged name, and renaming it also releases that name.
  try {
    await link(temporary, pending);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
    throw new AquariusError(
      "EXTRACT_CONFIG_OUTPUT_BUSY",
      `A write is already staged for ${path} at ${pending}.`,
    );
  }

  try {
    const latest = await readOutputState(path);
    const changed =
      !latest ||
      latest.ino !== current.ino ||
      latest.dev !== current.dev ||
      latest.ctimeNs !== current.ctimeNs ||
      latest.mtimeNs !== current.mtimeNs;
    if (changed) {
      throw new AquariusError(
        "EXTRACT_CONFIG_OUTPUT_CHANGED",
        `Configuration changed while preparing the write: ${path}. Retry the extraction.`,
      );
    }
    assertNotAborted(signal);
    await rename(pending, path);
  } catch (error) {
    await unlink(pending).catch(() => {});
    throw error;
  }
};

const isInvalidPath = (error: unknown): boolean =>
  isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR") || isNodeError(error, "ELOOP");

const invalidOutputParent = (path: string): AquariusError =>
  new AquariusError(
    "EXTRACT_CONFIG_OUTPUT_INVALID",
    `Cannot use ${dirname(path)} as the output directory for ${path}.`,
  );

const outputConflict = (path: string): AquariusError =>
  new AquariusError(
    "EXTRACT_CONFIG_OUTPUT_EXISTS",
    `Configuration already exists at ${path}. Use --force to overwrite it or --merge to combine it.`,
  );

const assertNotAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
};
