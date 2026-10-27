export type ToolKind = "lint" | "format";
export type JsonObject = Record<string, unknown>;

export interface RunError {
  code: string;
  message: string;
  ruleIds: string[];
}
