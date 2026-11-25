import { z } from "zod";
import { tomlValueSchema, type TomlValue } from "./toml";

type Hint<Values extends string> = Values | (string & {});

export type ServiceTierHint = Hint<"fast" | "ultrafast" | "standard" | "flex">;
export type VerbosityHint = Hint<"low" | "medium" | "high">;
export type ReasoningEffortHint = Hint<"minimal" | "low" | "medium" | "high" | "xhigh">;
export type ReasoningSummaryHint = Hint<"auto" | "concise" | "detailed" | "none">;
export type AutoCompactScopeHint = Hint<"total" | "body_after_prefix">;

export interface CodexOptions {
  executable?: string;
  ephemeral?: boolean;
  model?: string | null;
  serviceTier?: ServiceTierHint | null;
  verbosity?: VerbosityHint | null;
  reasoning?: {
    effort?: ReasoningEffortHint | null;
    summary?: ReasoningSummaryHint | null;
  };
  context?: {
    window?: number | null;
    autoCompactTokenLimit?: number | null;
    autoCompactTokenLimitScope?: AutoCompactScopeHint | null;
  };
  features?: Record<string, boolean>;
  config?: Record<string, TomlValue>;
}

export interface CodexSettings {
  model?: string;
  serviceTier?: string;
  verbosity?: string;
  reasoningEffort?: string;
  reasoningSummary?: string;
  contextWindow?: number;
  autoCompactTokenLimit?: number;
  autoCompactTokenLimitScope?: string;
}

export const DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "hooks",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "plugins",
  "recommended_plugins",
  "remote_plugin",
  "skill_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "view_image",
  "workspace_dependencies",
] as const;

const protectedFeatures = new Set<string>(DISABLED_FEATURES);

const protectedConfig = new Set([
  "default_permissions",
  "permissions",
  "projects",
  "project_doc_max_bytes",
  "web_search",
  "mcp_servers",
  "sandbox_mode",
  "sandbox_workspace_write",
  "approval_policy",
  "approvals_reviewer",
  "analytics",
  "notify",
  "shell_environment_policy",
  "model_provider",
  "features",
  "windows",
  // These settings can route data or open files outside the command sandbox.
  "chatgpt_base_url",
  "openai_base_url",
  "model_providers",
  "apps_mcp_product_sku",
  "experimental_realtime_webrtc_call_base_url",
  "experimental_realtime_ws_base_url",
  "otel",
  "profile",
  "profiles",
  "experimental_instructions_file",
  "model_instructions_file",
  "experimental_compact_prompt_file",
  "model_catalog_json",
  "log_dir",
  "sqlite_home",
  "project_root_markers",
  "hooks",
]);

const firstClassPaths = new Map([
  ["model", "model"],
  ["service_tier", "serviceTier"],
  ["model_verbosity", "verbosity"],
  ["model_reasoning_effort", "reasoning.effort"],
  ["model_reasoning_summary", "reasoning.summary"],
  ["model_context_window", "context.window"],
  ["model_auto_compact_token_limit", "context.autoCompactTokenLimit"],
  ["model_auto_compact_token_limit_scope", "context.autoCompactTokenLimitScope"],
]);

const featuresSchema = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/u, "Expected a Codex feature name."),
    z.boolean(),
  )
  .superRefine((features, context) => {
    for (const [name, enabled] of Object.entries(features)) {
      if (enabled && protectedFeatures.has(name)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "This feature must stay disabled.",
        });
      }
    }
  });

const configSchema = z
  .record(
    z.string().regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u, "Expected a bare TOML dotted key."),
    tomlValueSchema,
  )
  .superRefine((config, context) => {
    for (const [key, value] of Object.entries(config)) {
      const root = key.split(".", 1)[0]!;
      const path = firstClassPaths.get(root);
      const webSearchOverride =
        key === "tools.web_search" ||
        key.startsWith("tools.web_search.") ||
        (key === "tools" && typeof value === "object" && Object.hasOwn(value, "web_search"));
      if (path) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `Use ai.options.${path} instead of ai.options.config.${key}.`,
        });
      } else if (protectedConfig.has(root) || webSearchOverride) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "This setting is controlled by Aquarius.",
        });
      }
    }
  });

const textOption = z.string().trim().min(1).nullish();
const tokenCount = z.number().int().positive().nullish();

export const codexOptionsSchema = z.strictObject({
  executable: z.string().trim().min(1).optional(),
  ephemeral: z.boolean().default(true),
  model: textOption,
  serviceTier: textOption,
  verbosity: textOption,
  reasoning: z.strictObject({ effort: textOption, summary: textOption }).optional(),
  context: z
    .strictObject({
      window: tokenCount,
      autoCompactTokenLimit: tokenCount,
      autoCompactTokenLimitScope: textOption,
    })
    .optional(),
  features: featuresSchema.optional(),
  config: configSchema.optional(),
}) satisfies z.ZodType<CodexOptions & { ephemeral: boolean }, CodexOptions>;

export const featureArguments = (features?: CodexOptions["features"]): string[] => [
  ...DISABLED_FEATURES.flatMap((name) => ["--disable", name]),
  ...Object.entries(features ?? {}).flatMap(([name, enabled]) =>
    protectedFeatures.has(name) ? [] : [enabled ? "--enable" : "--disable", name],
  ),
];
