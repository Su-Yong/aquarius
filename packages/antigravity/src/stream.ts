import {
  AquariusError,
  isPlainObject,
  toPosix,
  type AdapterExecuteRequest,
  type JsonObject,
} from "@aqtools/core/adapter";

const BLOCKED_TOOLS = new Set([
  "write_file",
  "write_to_file",
  "create_file",
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content",
  "sed_file",
  "notebook_edit",
  "notebook_execution",
  "delete_file",
  "remove_file",
  "move_file",
  "rename_file",
  "delete_knowledge",
  "search_web",
  "read_url_content",
  "read_url",
  "fetch_url",
  "call_mcp_tool",
  "list_resources",
  "read_resource",
  "list_plugin_accounts",
  "search_marketplace",
  "invoke_subagent",
  "start_subagent",
  "define_subagent",
  "manage_subagents",
  "manage_inbox",
  "send_message",
  "swarm",
  "run_workflow",
  "schedule",
  "generate_image",
]);
const MAX_VISIBLE_REFERENCES = 3;
const COMMAND_TOKEN_START = /[\s"'`=(:,;|&<>[]/u;
const COMMAND_TOKEN_END = /[\s"'`:),;|&<>\]]/u;

const isBlockedTool = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const name = value.trim().toLowerCase();
  return BLOCKED_TOOLS.has(name) || /(?:^|_)browser|(?:^|_)mcp(?:[_/:-]|$)|mcp:/u.test(name);
};

export const createStepHandler = (
  input: AdapterExecuteRequest,
  viewRoot: string,
): ((step: JsonObject) => void) => {
  const { onProgress } = input;
  const activeTools = new Map<number, string>();
  let lastReferences = "";

  return (step) => {
    const { state, step_index: index, step_type: type } = step;
    const tool = isPlainObject(step.tool_info) ? step.tool_info : undefined;
    const forbiddenAction =
      step.subagent_info != null || isBlockedTool(step.tool_name) || isBlockedTool(tool?.name);
    if (forbiddenAction) {
      throw new AquariusError(
        "ANTIGRAVITY_TOOL_VIOLATION",
        "Antigravity attempted a disabled tool or subagent.",
      );
    }

    if (typeof index !== "number" || (state !== "ACTIVE" && state !== "DONE")) return;

    if (type === "tool" && onProgress) {
      const references = toolReferences(tool?.parameters, input, viewRoot);
      if (references) lastReferences = references;

      if (state === "ACTIVE") {
        activeTools.set(
          index,
          references
            ? `Inspecting ${references}`
            : (activeTools.get(index) ?? "Inspecting project"),
        );
      } else {
        activeTools.delete(index);
      }

      const active = [...activeTools.values()].at(-1);
      onProgress(
        active ??
          (lastReferences ? `AI analyzing; last referenced: ${lastReferences}` : "AI analyzing"),
      );
    }
  };
};

const toolReferences = (
  parameters: unknown,
  input: AdapterExecuteRequest,
  viewRoot: string,
): string => {
  const values: string[] = [];
  const normalizePath = (path: string) => {
    const posix = toPosix(path);
    return process.platform === "win32" ? posix.toLowerCase() : posix;
  };
  const pending = [parameters];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") values.push(normalizePath(value));
    else if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (isPlainObject(value)) {
      for (const item of Object.values(value)) pending.push(item);
    }
  }
  if (values.length === 0) return "";

  const root = normalizePath(viewRoot);
  const isReferenced = (path: string) => {
    const relative = normalizePath(path);
    const candidates = [relative, `./${relative}`, `${root}/${relative}`];
    return values.some((value) => candidates.some((candidate) => mentionsPath(value, candidate)));
  };
  const references = [
    ...input.readableFiles.filter(isReferenced),
    ...input.ruleResources
      .filter(({ detailsPath }) => isReferenced(detailsPath))
      .map(({ ruleId }) => `rule ${ruleId}`),
  ];
  const visible = references.slice(0, MAX_VISIBLE_REFERENCES).join(", ");
  const omitted = references.length - MAX_VISIBLE_REFERENCES;
  return omitted > 0 ? `${visible} (+${omitted} more)` : visible;
};

const mentionsPath = (value: string, path: string): boolean => {
  let index = value.indexOf(path);
  while (index !== -1) {
    const before = value[index - 1];
    const after = value[index + path.length];
    if ((!before || COMMAND_TOKEN_START.test(before)) && (!after || COMMAND_TOKEN_END.test(after)))
      return true;
    index = value.indexOf(path, index + path.length);
  }
  return false;
};

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const assertNoSnapshotPath = (value: unknown, paths: RegExp | undefined): void => {
  if (!paths) return;

  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string" && paths.test(current)) {
      throw new AquariusError(
        "ANTIGRAVITY_RESPONSE_INVALID",
        "Antigravity response exposed an internal snapshot path.",
      );
    }
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
    } else if (isPlainObject(current)) {
      for (const [key, item] of Object.entries(current)) pending.push(key, item);
    }
  }
};
