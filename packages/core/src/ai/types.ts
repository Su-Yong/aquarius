import type { IgnoreRule } from "../files/types";
import type { JsonObject } from "../shared/types";

export interface BridgeInput {
  projectRoot: string;
  readableFiles: readonly string[];
  ignore: readonly IgnoreRule[];
  prompt: string;
  outputSchema: JsonObject;
  options: JsonObject;
  signal: AbortSignal;
}

export interface AiBridge {
  id: string;
  run: (input: BridgeInput) => Promise<unknown>;
}
