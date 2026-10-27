import type { JsonObject, ToolKind } from "../shared/types";
import type { RuleSelection } from "../rules/types";

export interface ProjectConfig {
  files?: string[];
  ignore?: string[];
  plugins?: string[];
  ai?: { adapter?: string; options?: JsonObject; timeoutMs?: number };
  rules?: RuleSelection[];
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
  ai: { adapter: string; options: JsonObject; timeoutMs: number };
  rules: RuleSelection[];
}
