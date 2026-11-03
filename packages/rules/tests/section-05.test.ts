import { describe, expect, test } from "vitest";
import { prepareRules } from "../../core/src/rules/prepare";
import type { LoadedConfig } from "../../core/src/config/types";
import { section05Rules } from "../src/lint/section-05";

const rules = section05Rules;
const ids = [
  "cohesion/single-source-of-business-policy",
  "cohesion/separate-orchestration-from-policy",
  "cohesion/separate-validation-from-effects",
  "cohesion/separate-query-from-command",
  "cohesion/separate-formatting-from-computation",
  "cohesion/separate-domain-from-transport-mapping",
  "cohesion/separate-mapping-from-persistence",
  "cohesion/separate-authorization-from-presentation",
  "cohesion/separate-workflow-from-notification-policy",
  "cohesion/separate-retry-from-business-operation",
  "cohesion/separate-feature-selection-from-implementation",
  "cohesion/split-read-write-models-when-justified",
  "cohesion/co-locate-change-coupled-code",
  "cohesion/no-shotgun-policy-change",
  "cohesion/no-business-policy-in-generic-helpers"
];

const config = (selected: LoadedConfig["rules"]): LoadedConfig => ({
  tool: "lint",
  cwd: process.cwd(),
  projectRoot: process.cwd(),
  configDirectory: process.cwd(),
  files: [],
  ignore: [],
  plugins: ["section"],
  ai: { adapter: "codex", options: {}, timeoutMs: 30_000 },
  rules: selected,
});
const plugins = { section: { namespace: "aquarius", lintRules: rules } };

describe("section 05 rule definitions", () => {
  test("preserves the canonical independent IDs and report-only defaults", () => {
    expect(rules.map((rule) => rule.id)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rules.every((rule) => rule.defaultSeverity === "warn")).toBe(true);
  });

  test("prepares every rule through the existing engine API", async () => {
    const prepared = await prepareRules(config(ids.map((id) => ({ rule: `aquarius/${id}` }))), plugins);
    expect(prepared.errors).toEqual([]);
    expect(prepared.rules.map((rule) => rule.id)).toEqual(ids.map((id) => `aquarius/${id}`));
    for (const rule of rules) {
      const prompt = await rule.buildPrompt({ options: {} });
      expect(prompt.criteria).toContain(rule.description);
      expect(prompt.applicability).not.toBe("");
      expect(prompt.evidenceRequirements.length).toBeGreaterThanOrEqual(2);
      expect(prompt.exceptions?.length).toBeGreaterThan(0);
      expect(prompt.procedure?.join(" ")).toContain("비활성화");
      expect(prompt.examples?.some((example) => example.expected === "pass")).toBe(true);
      expect(prompt.examples?.some((example) => example.expected === "unknown")).toBe(true);
      expect(prompt.criteria).toContain("보고 전용");
    }
  });

  test("selection is explicit and an off neighbor does not suppress an active rule", async () => {
    expect(await prepareRules(config([]), plugins)).toEqual({ rules: [], errors: [] });
    for (let index = 0; index < ids.length; index += 1) {
      const current = ids[index]!;
      const neighbor = ids[(index + 1) % ids.length]!;
      const alone = await prepareRules(config([{ rule: `aquarius/${current}` }]), plugins);
      const withOff = await prepareRules(config([
        { rule: `aquarius/${neighbor}`, severity: "off" },
        { rule: `aquarius/${current}` },
      ]), plugins);
      expect(withOff).toEqual(alone);
      expect(alone.errors).toEqual([]);
      expect(alone.rules).toHaveLength(1);
    }
  });

  test("rejects invented options without dropping other selected rules", async () => {
    const prepared = await prepareRules(config([
      { rule: `aquarius/${ids[0]}`, options: { invented: true } },
      { rule: `aquarius/${ids[1]}` },
    ]), plugins);
    expect(prepared.errors.map((error) => error.code)).toEqual(["RULE_OPTIONS_INVALID"]);
    expect(prepared.rules.map((rule) => rule.id)).toEqual([`aquarius/${ids[1]}`]);
  });

  test("returns independent prompt objects without changing caller options", async () => {
    for (const rule of rules) {
      const options = Object.freeze({});
      const first = await rule.buildPrompt({ options });
      first.evidenceRequirements.push("mutated by caller");
      first.exceptions?.push("unapproved exception");
      const second = await rule.buildPrompt({ options });
      expect(second.evidenceRequirements).not.toContain("mutated by caller");
      expect(second.exceptions).not.toContain("unapproved exception");
      expect(options).toEqual({});
    }
  });
});

describe("section 05 semantic boundaries", () => {
  test("cohesion/single-source-of-business-policy", async () => {
    const rule = rules.find((candidate) => candidate.id === "cohesion/single-source-of-business-policy")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("유효 시점");
    expect(text).toContain("생성");
    expect(text).toContain("독립 정책 버전");
    expect(text).toContain("enforce-invariants-at-mutation");
  });

  test("cohesion/separate-validation-from-effects", async () => {
    const rule = rules.find((candidate) => candidate.id === "cohesion/separate-validation-from-effects")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("예약");
    expect(text).toContain("검증 실패");
    expect(text).toContain("부분 부작용");
  });

  test("cohesion/separate-query-from-command", async () => {
    const rule = rules.find((candidate) => candidate.id === "cohesion/separate-query-from-command")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("조회");
    expect(text).toContain("캐시");
    expect(text).toContain("관측");
  });

  test("cohesion/separate-authorization-from-presentation", async () => {
    const rule = rules.find((candidate) => candidate.id === "cohesion/separate-authorization-from-presentation")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("서버 권한");
    expect(text).toContain("UI표시");
  });

  test("cohesion/separate-workflow-from-notification-policy", async () => {
    const rule = rules.find((candidate) => candidate.id === "cohesion/separate-workflow-from-notification-policy")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("원자적");
    expect(text).toContain("트랜잭션");
  });

  test("cohesion/no-shotgun-policy-change", async () => {
    const rule = rules.find((candidate) => candidate.id === "cohesion/no-shotgun-policy-change")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("snapshot");
    expect(text).toContain("관찰 시점");
    expect(text).toContain("single-source-of-business-policy");
  });

  test("cohesion/co-locate-change-coupled-code", async () => {
    const rule = rules.find((candidate) => candidate.id === "cohesion/co-locate-change-coupled-code")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("자동 생성");
    expect(text).toContain("formatting");
    expect(text).toContain("소유권");
  });

});
