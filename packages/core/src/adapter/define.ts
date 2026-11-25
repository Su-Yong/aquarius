import type { JsonObject } from "../shared/types";
import type { AiAdapter, SessionAdapter, StandaloneAdapter } from "./types";

export function defineAdapter<Options extends JsonObject = JsonObject>(
  adapter: SessionAdapter<Options>,
): SessionAdapter<Options>;
export function defineAdapter<Options extends JsonObject = JsonObject>(
  adapter: StandaloneAdapter<Options>,
): StandaloneAdapter<Options>;
export function defineAdapter(adapter: AiAdapter): AiAdapter {
  return adapter;
}
