import type { IgnoreRule } from "../files/types";
import type { RuleScope } from "../rules/types";
import type { JsonObject } from "../shared/types";

export interface RuleReference {
  ruleId: string;
  scope: RuleScope;
  applicability: string;
  detailsPath: string;
}

export interface RuleResourceFile extends RuleReference {
  contentHash: string;
}

export interface RuleResources {
  directory: string;
  files: readonly RuleResourceFile[];
}

export interface PreparedRuleResources {
  resources: RuleResources;
  dispose: () => Promise<void>;
}

export interface BridgeInput {
  projectRoot: string;
  readableFiles: readonly string[];
  ignore: readonly IgnoreRule[];
  prompt: string;
  ruleResources: RuleResources;
  outputSchema: JsonObject;
  options: JsonObject;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
  onAnalysisUpdate?: (update: unknown) => void;
}

export interface AiBridge {
  id: string;
  run: (input: BridgeInput) => Promise<unknown>;
}
