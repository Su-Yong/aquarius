export { loadConfig } from "./config/load";
export { prepareRules } from "./rules/prepare";
export { importProjectModule } from "./rules/modules";
export { selectTargets } from "./files/targets";
export { resolveBridge, callBridge } from "./ai/bridge";
export { buildTaskPrompt } from "./ai/prompt";
export {
  errorSchema, parseResultItem, resultEnvelope, references, nonempty,
  normalizedPath, collectErrors, checkCompletion,
} from "./ai/results";
export { AquariusError, toRunError } from "./shared/errors";
export type * from "./ai/types";
export type * from "./config/types";
export type * from "./files/types";
export type * from "./rules/types";
export type * from "./shared/types";

export * from "./changes/apply";
export type * from "./changes/types";
export { fileChangeSchema, type FileChange } from "./changes/schema";
export * from "./undo/store";
export * from "./undo/schema";

export { startProgress, statusText, terminalColors } from "./shared/progress";
