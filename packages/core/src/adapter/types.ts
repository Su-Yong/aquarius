import type { z } from "zod";

import type { RuleScope } from "../rules/types";
import type { JsonObject } from "../shared/types";

export interface RuleResource {
  ruleId: string;
  scope: RuleScope;
  applicability: string;
  detailsPath: string;
  content: string;
  contentHash: string;
}

export type RuleReference = Omit<RuleResource, "content" | "contentHash">;

export interface AdapterSessionContext<Options extends JsonObject = JsonObject> {
  projectRoot: string;
  readableFiles: readonly string[];
  ruleResources: readonly RuleResource[];
  options: Options;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface AdapterExecuteRequest<
  Options extends JsonObject = JsonObject,
> extends AdapterSessionContext<Options> {
  prompt: string;
  outputSchema: JsonObject;
  onAnalysisUpdate?: (update: unknown) => void;
}

export interface AdapterRunInfo {
  adapter: string;
  model?: string;
  details?: Record<string, string>;
}

export interface AdapterSession {
  info?: AdapterRunInfo;
  execute(request: AdapterExecuteRequest): unknown;
  dispose(): void | Promise<void>;
}

interface AdapterDefinition<Options extends JsonObject> {
  id: string;
  optionsSchema?: z.ZodType<Options>;
}

export interface SessionAdapter<
  Options extends JsonObject = JsonObject,
> extends AdapterDefinition<Options> {
  createSession(context: AdapterSessionContext<Options>): AdapterSession | Promise<AdapterSession>;
  run?: never;
}

export interface StandaloneAdapter<
  Options extends JsonObject = JsonObject,
> extends AdapterDefinition<Options> {
  run(request: AdapterExecuteRequest<Options>): unknown;
  createSession?: never;
}

export type AiAdapter<Options extends JsonObject = JsonObject> =
  | SessionAdapter<Options>
  | StandaloneAdapter<Options>;
