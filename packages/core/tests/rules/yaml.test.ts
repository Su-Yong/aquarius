import { describe, expect, test } from "vitest";
import { formatRuleFromYaml, lintRuleFromYaml } from "../../src/rules/yaml";

describe("YAML rule helpers", () => {
  test("creates a lint rule and substitutes only option paths once", async () => {
    const rule = lintRuleFromYaml(`
id: contracts/check
description: Check a contract
scope: module
defaultSeverity: error
optionsSchema:
  type: object
  properties:
    enabled: { type: boolean }
    label: { type: string }
    nested: { type: object }
    nullable: { type: [string, "null"] }
    literal: { type: string }
  additionalProperties: false
defaultOptions:
  enabled: false
prompt:
  applicability: "Code with {{options.label}}"
  criteria: "enabled={{options.enabled}}; nested={{options.nested}}; value={{options.nullable}}"
  evidenceRequirements:
    - "literal {{options.literal}}"
`);

    const instructions = await rule.buildPrompt({
      options: {
        label: "{{options.enabled}}",
        enabled: true,
        nested: { count: 2 },
        nullable: null,
        literal: "evidence",
      },
    });

    expect(rule).toMatchObject({ id: "contracts/check", scope: "module", defaultSeverity: "error" });
    expect(rule.optionsSchema?.safeParse({ enabled: "true" }).success).toBe(false);
    expect(instructions).toEqual({
      applicability: "Code with {{options.enabled}}",
      criteria: `enabled=true; nested={"count":2}; value=null`,
      evidenceRequirements: ["literal evidence"],
    });
  });

  test("creates a format rule with examples", async () => {
    const rule = formatRuleFromYaml(`
id: style/early-return
description: Prefer early returns
scope: file
prompt:
  applicability: nested branches
  transformation: return {{options.direction}} first
  constraints: []
  examples:
    - before: nested
      after: flat
      reason: preserves behavior
`);

    expect(await rule.buildPrompt({ options: { direction: "failure" } })).toEqual({
      applicability: "nested branches",
      transformation: "return failure first",
      constraints: [],
      examples: [{ before: "nested", after: "flat", reason: "preserves behavior" }],
    });
  });

  test("reports a missing option when the prompt is built", async () => {
    const rule = lintRuleFromYaml(`
id: contracts/check
description: Check
scope: file
defaultSeverity: warn
prompt:
  applicability: code
  criteria: "{{options.missing}}"
  evidenceRequirements: []
`);
    await expect(Promise.resolve().then(() => rule.buildPrompt({ options: {} }))).rejects.toMatchObject({
      code: "YAML_TEMPLATE_MISSING",
    });
  });

  test.each([
    ["{{context.file}}", "only options dot paths"],
    ["{{options.value", "malformed"],
  ])("rejects unsupported template syntax %s", (template, message) => {
    expect(() => lintRuleFromYaml(`
id: contracts/check
description: Check
scope: file
defaultSeverity: warn
prompt:
  applicability: code
  criteria: "${template}"
  evidenceRequirements: []
`)).toThrow(expect.objectContaining({ code: "YAML_RULE_INVALID", message: expect.stringContaining(message) }));
  });

  test("rejects invalid YAML and unknown rule fields", () => {
    expect(() => lintRuleFromYaml("id: [")).toThrow(expect.objectContaining({ code: "YAML_PARSE_FAILED" }));
    expect(() => formatRuleFromYaml(`
id: style/check
description: Check
scope: file
unknown: true
prompt:
  applicability: code
  transformation: transform
  constraints: []
`)).toThrow(expect.objectContaining({ code: "YAML_RULE_INVALID" }));
  });
});
