import type { JsonObject, ToolKind } from "../shared/types";
import type { RuleSettings } from "../rules/types";

export interface ProjectConfig {
  files?: string[];
  ignore?: string[];
  plugins?: string[];
  preset?: string[];
  ai?: {
    adapter: string;
    options?: JsonObject;
    timeoutMs?: number;
    fileBatchSize?: number;
    maxConcurrency?: number;
  };
  rules?: RuleSettings;
}

export interface LoadedConfig {
  tool: ToolKind;
  cwd: string;
  projectRoot: string;
  configPath?: string;
  configDirectory: string;
  files: string[];
  ignore: string[];
  plugins: string[];
  preset: string[];
  ai: {
    adapter?: string;
    options: JsonObject;
    timeoutMs: number;
    fileBatchSize?: number;
    maxConcurrency?: number;
  };
  rules: RuleSettings;
}
