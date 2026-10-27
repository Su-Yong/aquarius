import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { AquariusError } from "../shared/errors";
import type { ToolKind } from "../shared/types";
import type { RuleSelection } from "../rules/types";
import { formatZodIssues, projectConfigSchema } from "./schemas";
import type { LoadedConfig, ProjectConfig } from "./types";

const CONFIG_NAMES: Record<ToolKind, string> = {
  lint: ".aqlintrc.jsonc",
  format: ".aqfmtrc.jsonc",
};

const DEFAULT_TIMEOUT_MS = 600_000;

export const loadConfig = async (
  tool: ToolKind,
  options: { cwd: string; configPath?: string },
): Promise<LoadedConfig> => {
  const cwd = await resolveDirectory(options.cwd);
  const configPath = options.configPath
    ? await resolveConfigPath(cwd, options.configPath)
    : await findConfig(cwd, CONFIG_NAMES[tool]);
  const projectRoot = configPath ? dirname(configPath) : cwd;
  const configDirectory = projectRoot;
  const input = configPath ? await readConfig(configPath) : {};
  const config = validateConfig(tool, input);

  return {
    tool,
    cwd,
    projectRoot,
    configPath,
    configDirectory,
    files: config.files ?? ["**/*"],
    ignore: config.ignore ?? [],
    plugins: config.plugins ?? [],
    ai: {
      adapter: config.ai?.adapter ?? "codex",
      options: config.ai?.options ?? {},
      timeoutMs: config.ai?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
    rules: config.rules ?? [],
  };
};

const resolveDirectory = async (directory: string): Promise<string> => {
  const absolute = resolve(directory);
  try {
    const resolved = await realpath(absolute);
    if (!(await lstat(resolved)).isDirectory()) {
      throw new AquariusError("CONFIG_CWD_INVALID", `Not a directory: ${directory}`);
    }
    return resolved;
  } catch (error) {
    if (error instanceof AquariusError) throw error;
    throw new AquariusError("CONFIG_CWD_INVALID", `Cannot access working directory ${directory}: ${errorMessage(error)}`);
  }
};

const findConfig = async (cwd: string, name: string): Promise<string | undefined> => {
  let directory = cwd;
  while (true) {
    const candidate = join(directory, name);
    if (await pathExists(candidate)) return realpath(candidate);
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

const resolveConfigPath = async (cwd: string, configPath: string): Promise<string> => {
  const absolute = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
  try {
    const resolved = await realpath(absolute);
    if (!(await lstat(resolved)).isFile()) {
      throw new AquariusError("CONFIG_NOT_FOUND", `Configuration is not a file: ${configPath}`);
    }
    return resolved;
  } catch (error) {
    if (error instanceof AquariusError) throw error;
    throw new AquariusError("CONFIG_NOT_FOUND", `Cannot find configuration ${configPath}: ${errorMessage(error)}`);
  }
};

const readConfig = async (configPath: string): Promise<unknown> => {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    throw new AquariusError("CONFIG_READ_FAILED", `Cannot read ${configPath}: ${errorMessage(error)}`);
  }

  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    const { line, column } = lineAndColumn(text, first.offset);
    throw new AquariusError(
      "CONFIG_PARSE_FAILED",
      `${configPath}:${line}:${column}: ${printParseErrorCode(first.error)}`,
    );
  }
  return value;
};

const validateConfig = (tool: ToolKind, input: unknown): ProjectConfig => {
  const parsed = projectConfigSchema.safeParse(input);
  if (!parsed.success) invalid(formatZodIssues(parsed.error));
  const config = parsed.data;

  for (const pattern of [...(config.files ?? []), ...(config.ignore ?? [])]) validateRelativePattern(pattern);
  if (config.plugins) rejectDuplicates(config.plugins, "plugins");
  validateRules(tool, config.rules ?? []);
  return config;
};

const validateRules = (tool: ToolKind, rules: RuleSelection[]): void => {
  for (const [index, rule] of rules.entries()) {
    if (!isRuleReference(rule.rule)) invalid(`rules[${index}].rule must be a namespace/rule-id string`);
    if (tool === "format" && rule.severity !== undefined) {
      invalid(`rules[${index}].severity is only valid for aqlint`);
    }
  }
  rejectDuplicates(rules.map(({ rule }) => rule), "rules");
};

const rejectDuplicates = (values: string[], name: string): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalid(`${name} contains duplicate value: ${value}`);
    seen.add(value);
  }
};

const validateRelativePattern = (pattern: string): void => {
  const value = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  const normalized = value.replaceAll("\\", "/");
  const withoutAnchor = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  if (
    normalized.startsWith("//")
    || /^[A-Za-z]:\//.test(normalized)
    || parsePath(withoutAnchor).root !== ""
    || withoutAnchor.split("/").includes("..")
  ) {
    invalid(`patterns must stay within their base directory: ${pattern}`);
  }
};

const isRuleReference = (value: string): boolean => {
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1 && !value.split("/").some((part) => part.trim() === "");
};

const invalid: (message: string) => never = (message) => {
  throw new AquariusError("CONFIG_INVALID", message);
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
};

const lineAndColumn = (text: string, offset: number): { line: number; column: number } => {
  const before = text.slice(0, offset).split(/\r\n|\r|\n/);
  return { line: before.length, column: before.at(-1)!.length + 1 };
};

const isNodeError = (error: unknown, code: string): boolean => (
  error instanceof Error && "code" in error && error.code === code
);

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
