import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";

import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { AquariusError, errorMessage, isNodeError } from "../shared/errors";
import { formatZodIssues } from "../shared/zod";
import type { RuleSettings } from "../rules/types";
import type { ToolKind } from "../shared/types";

import { formatConfigSchema, lintConfigSchema } from "./schemas";
import type { LoadedConfig, ProjectConfig } from "./types";

const CONFIG_NAMES: Record<ToolKind, readonly string[]> = {
  lint: [".aqlintrc.json", ".aqlintrc.jsonc"],
  format: [".aqfmtrc.json", ".aqfmtrc.jsonc"],
};

const DEFAULT_TIMEOUT_MS = 600_000;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:\//;
const LINE_BREAK = /\r\n|\r|\n/;

export const loadConfig = async (
  tool: ToolKind,
  options: { cwd: string; configPath?: string },
): Promise<LoadedConfig> => {
  const cwd = await resolveDirectory(options.cwd);
  const configPath = options.configPath
    ? await resolveConfigPath(cwd, options.configPath)
    : await findConfig(cwd, CONFIG_NAMES[tool]);

  if (!configPath) {
    throw new AquariusError(
      "CONFIG_NOT_FOUND",
      `No ${CONFIG_NAMES[tool].join(" or ")} configuration found from ${cwd}.`,
    );
  }

  const projectRoot = dirname(configPath);
  const rawConfig = await readConfig(configPath);
  const config = validateConfig(tool, rawConfig);

  return {
    tool,
    cwd,
    projectRoot,
    configPath,
    configDirectory: projectRoot,
    files: config.files ?? ["**/*"],
    ignore: config.ignore ?? [],
    plugins: config.plugins ?? [],
    preset: config.preset ?? [],
    ai: {
      ...config.ai,
      adapter: config.ai?.adapter,
      options: config.ai?.options ?? {},
      timeoutMs: config.ai?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
    rules: config.rules ?? {},
  };
};

const resolveDirectory = async (directory: string): Promise<string> => {
  const absolute = resolve(directory);

  try {
    const resolved = await realpath(absolute);
    const stats = await lstat(resolved);
    if (!stats.isDirectory()) {
      throw new AquariusError("CONFIG_CWD_INVALID", `Not a directory: ${directory}`);
    }

    return resolved;
  } catch (error) {
    if (error instanceof AquariusError) throw error;
    throw new AquariusError(
      "CONFIG_CWD_INVALID",
      `Cannot access working directory ${directory}: ${errorMessage(error)}`,
    );
  }
};

const findConfig = async (cwd: string, names: readonly string[]): Promise<string | undefined> => {
  let directory = cwd;

  while (true) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (await pathExists(candidate)) return realpath(candidate);
    }

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

const resolveConfigPath = async (cwd: string, configPath: string): Promise<string> => {
  const absolute = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);

  try {
    const resolved = await realpath(absolute);
    const stats = await lstat(resolved);
    if (!stats.isFile()) {
      throw new AquariusError("CONFIG_NOT_FOUND", `Configuration is not a file: ${configPath}`);
    }

    return resolved;
  } catch (error) {
    if (error instanceof AquariusError) throw error;
    throw new AquariusError(
      "CONFIG_NOT_FOUND",
      `Cannot find configuration ${configPath}: ${errorMessage(error)}`,
    );
  }
};

const readConfig = async (configPath: string): Promise<unknown> => {
  let configText: string;
  try {
    configText = await readFile(configPath, "utf8");
  } catch (error) {
    throw new AquariusError(
      "CONFIG_READ_FAILED",
      `Cannot read ${configPath}: ${errorMessage(error)}`,
    );
  }

  const errors: ParseError[] = [];
  const parsedConfig = parse(configText, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const firstError = errors[0];
    const { line, column } = lineAndColumn(configText, firstError.offset);
    throw new AquariusError(
      "CONFIG_PARSE_FAILED",
      `${configPath}:${line}:${column}: ${printParseErrorCode(firstError.error)}`,
    );
  }

  return parsedConfig;
};

const validateConfig = (tool: ToolKind, input: unknown): ProjectConfig => {
  const schema = tool === "lint" ? lintConfigSchema : formatConfigSchema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) invalid(formatZodIssues(parsed.error));
  const config = parsed.data;

  const patterns = [...(config.files ?? []), ...(config.ignore ?? [])];
  for (const pattern of patterns) validateRelativePattern(pattern);

  if (config.plugins) rejectDuplicates(config.plugins, "plugins");

  for (const [index, preset] of (config.preset ?? []).entries()) {
    if (!isRuleReference(preset)) {
      invalid(`preset[${index}] must be a namespace/preset-name string`);
    }
  }
  validateRules(config.rules ?? {});

  return config;
};

const validateRules = (rules: RuleSettings): void => {
  for (const rule of Object.keys(rules)) {
    if (!isRuleReference(rule)) {
      invalid(`rules key must be a namespace/rule-id string: ${rule}`);
    }
  }
};

const rejectDuplicates = (values: string[], name: string): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalid(`${name} contains duplicate value: ${value}`);
    seen.add(value);
  }
};

const validateRelativePattern = (pattern: string): void => {
  const unnegatedPattern = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  const normalized = unnegatedPattern.replaceAll("\\", "/");
  const withoutAnchor = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  const escapesBaseDirectory =
    normalized.startsWith("//") ||
    WINDOWS_DRIVE_PREFIX.test(normalized) ||
    parsePath(withoutAnchor).root !== "" ||
    withoutAnchor.split("/").includes("..");

  if (escapesBaseDirectory) {
    invalid(`patterns must stay within their base directory: ${pattern}`);
  }
};

const isRuleReference = (value: string): boolean => {
  const slash = value.indexOf("/");
  const hasRulePath =
    slash > 0 && slash < value.length - 1 && !value.split("/").some((part) => part.trim() === "");
  return hasRulePath;
};

const invalid: (message: string) => never = (message) => {
  throw new AquariusError("CONFIG_INVALID", message);
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }

  return true;
};

const lineAndColumn = (text: string, offset: number): { line: number; column: number } => {
  const textBeforeOffset = text.slice(0, offset);
  const linesBeforeOffset = textBeforeOffset.split(LINE_BREAK);
  const lastLine = linesBeforeOffset.at(-1)!;
  return { line: linesBeforeOffset.length, column: lastLine.length + 1 };
};
