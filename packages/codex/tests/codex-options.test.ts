import { expect, test } from "vitest";
import { resolveAdapter } from "../../core/src/adapter/resolve";
import { codexAdapter, codexOptionsSchema } from "../src/index";
import { tomlValue } from "../src/toml";

const resolveOptions = (options: Record<string, unknown>) =>
  resolveAdapter(
    {
      tool: "lint",
      cwd: process.cwd(),
      projectRoot: process.cwd(),
      configDirectory: process.cwd(),
      files: [],
      ignore: [],
      plugins: [],
      preset: [],
      rules: {},
      ai: { options, timeoutMs: 5_000 },
    },
    codexAdapter,
  );

test("trims and accepts nonempty future string options", () => {
  expect(
    codexOptionsSchema.parse({
      model: " future-model ",
      serviceTier: " future-tier ",
      verbosity: " future-verbosity ",
      reasoning: { effort: " future-effort ", summary: " future-summary " },
      context: { window: Number.MAX_SAFE_INTEGER, autoCompactTokenLimitScope: " future-scope " },
      features: { hooks: false },
    }),
  ).toEqual({
    ephemeral: true,
    model: "future-model",
    serviceTier: "future-tier",
    verbosity: "future-verbosity",
    reasoning: { effort: "future-effort", summary: "future-summary" },
    context: { window: Number.MAX_SAFE_INTEGER, autoCompactTokenLimitScope: "future-scope" },
    features: { hooks: false },
  });
});

test.each([
  { model: " " },
  { serviceTier: " " },
  { verbosity: " " },
  { reasoning: { effort: " " } },
  { reasoning: { summary: " " } },
  { context: { autoCompactTokenLimitScope: " " } },
  { context: { window: 0 } },
  { context: { window: Number.MAX_SAFE_INTEGER + 1 } },
  { context: { autoCompactTokenLimit: -1 } },
  { context: { autoCompactTokenLimit: 1.5 } },
  { reasoningEffort: "high" },
  { features: { "": true } },
  { features: { "feature=name": true } },
  { features: { candidate: "true" } },
  { config: { example: null } },
  { config: { example: [true, { nested: null }] } },
  { config: { example: [Number.NaN] } },
  { config: { example: Number.POSITIVE_INFINITY } },
  { config: { example: "\ud800" } },
  { config: { "not a dotted key": true } },
  { config: { "example..nested": true } },
  { config: { '"features".hooks': true } },
])("rejects invalid option values %o through the adapter resolver", async (options) => {
  await expect(resolveOptions(options)).rejects.toMatchObject({
    code: "AI_ADAPTER_OPTIONS_INVALID",
  });
});

test.each([
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
])("rejects enabling the protected %s feature", async (feature) => {
  await expect(resolveOptions({ features: { [feature]: true } })).rejects.toMatchObject({
    code: "AI_ADAPTER_OPTIONS_INVALID",
    message: expect.stringContaining(feature),
  });
});

test.each([
  "default_permissions",
  "permissions",
  "permissions.aquarius-read.filesystem",
  "projects",
  "projects.fixture.trust_level",
  "project_doc_max_bytes",
  "web_search",
  "mcp_servers",
  "mcp_servers.fixture.command",
  "sandbox_mode",
  "sandbox_workspace_write",
  "sandbox_workspace_write.network_access",
  "approval_policy",
  "approvals_reviewer",
  "analytics",
  "notify",
  "shell_environment_policy",
  "shell_environment_policy.inherit",
  "model_provider",
  "features",
  "features.hooks",
  "windows",
  "windows.sandbox",
  "openai_base_url",
  "model_instructions_file",
  "otel.exporter",
  "tools.web_search",
  "tools.web_search.result_limit",
])("rejects protected config key %s", async (key) => {
  await expect(resolveOptions({ config: { [key]: true } })).rejects.toMatchObject({
    code: "AI_ADAPTER_OPTIONS_INVALID",
    message: expect.stringContaining(key),
  });
});

test("rejects the nested web search settings without blocking unrelated tools", async () => {
  await expect(
    resolveOptions({ config: { tools: { web_search: { result_limit: 10 } } } }),
  ).rejects.toMatchObject({ code: "AI_ADAPTER_OPTIONS_INVALID" });
  await expect(resolveOptions({ config: { "tools.update_plan": true } })).resolves.toMatchObject({
    options: { config: { "tools.update_plan": true } },
  });
});

test.each([
  ["model", "model"],
  ["service_tier", "serviceTier"],
  ["model_reasoning_effort", "reasoning.effort"],
  ["model_reasoning_summary", "reasoning.summary"],
  ["model_verbosity", "verbosity"],
  ["model_context_window", "context.window"],
  ["model_auto_compact_token_limit", "context.autoCompactTokenLimit"],
  ["model_auto_compact_token_limit_scope", "context.autoCompactTokenLimitScope"],
])("directs %s to its dedicated option", async (key, option) => {
  await expect(resolveOptions({ config: { [key]: "value" } })).rejects.toMatchObject({
    code: "AI_ADAPTER_OPTIONS_INVALID",
    message: expect.stringContaining(`ai.options.${option}`),
  });
});

test("serializes safe TOML scalars and recursive literals", () => {
  expect(tomlValue('한글 "q" \\ path\n\t\u0000\u007f')).toBe(
    '"한글 \\"q\\" \\\\ path\\n\\t\\u0000\\u007f"',
  );
  expect(tomlValue(73)).toBe("73");
  expect(tomlValue(-0.125)).toBe("-0.125");
  expect(tomlValue(1e20)).toBe("1e+20");
  expect(tomlValue(false)).toBe("false");
  expect(tomlValue([1, { "literal.key": [true, ["x"]] }])).toMatch(
    /^\[\s*1\s*,\s*\{\s*"literal\.key"\s*=\s*\[\s*true\s*,\s*\[\s*"x"\s*\]\s*\]\s*\}\s*\]$/u,
  );
});
