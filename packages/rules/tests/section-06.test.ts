import { describe, expect, test } from "vitest";
import { prepareRules } from "../../core/src/rules/prepare";
import type { LoadedConfig } from "../../core/src/config/types";
import { section06Rules } from "../src/lint/section-06";

const rules = section06Rules;
const ids = [
  "domain/model-valid-states",
  "domain/enforce-invariants-at-mutation",
  "domain/explicit-entity-identity",
  "domain/explicit-value-equality",
  "domain/explicit-money-unit",
  "domain/explicit-rounding-policy",
  "domain/explicit-time-semantics",
  "domain/explicit-time-zone",
  "domain/encode-measurement-units",
  "domain/distinguish-missing-unknown-and-zero",
  "domain/explicit-state-transitions",
  "domain/no-identity-type-mixing",
  "domain/explicit-collection-semantics",
  "domain/explicit-numeric-range",
  "domain/enforce-aggregate-boundaries"
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

describe("section 06 rule definitions", () => {
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

describe("section 06 semantic boundaries", () => {
  test("domain/enforce-invariants-at-mutation", async () => {
    const rule = rules.find((candidate) => candidate.id === "domain/enforce-invariants-at-mutation")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("관찰·커밋 경계");
    expect(text).toContain("일시적 불일치");
  });

  test("domain/explicit-value-equality", async () => {
    const rule = rules.find((candidate) => candidate.id === "domain/explicit-value-equality")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("정규 직렬화");
    expect(text).toContain("객체 참조");
    expect(text).toContain("속성 순서");
  });

  test("domain/explicit-money-unit", async () => {
    const rule = rules.find((candidate) => candidate.id === "domain/explicit-money-unit")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("모든 통화");
    expect(text).toContain("정밀도");
    expect(text).toContain("단위");
  });

  test("domain/explicit-time-zone", async () => {
    const rule = rules.find((candidate) => candidate.id === "domain/explicit-time-zone")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("비교 이전");
    expect(text).toContain("현지 날짜·마감");
    expect(text).toContain("순수 시점 비교");
  });

  test("domain/explicit-collection-semantics", async () => {
    const rule = rules.find((candidate) => candidate.id === "domain/explicit-collection-semantics")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("JavaScript Set");
    expect(text).toContain("업무 ID");
    expect(text).toContain("별도 참조");
  });

  test("domain/explicit-numeric-range", async () => {
    const rule = rules.find((candidate) => candidate.id === "domain/explicit-numeric-range")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("NaN");
    expect(text).toContain("Infinity");
    expect(text).toContain("유한성");
  });

  test("domain/enforce-aggregate-boundaries", async () => {
    const rule = rules.find((candidate) => candidate.id === "domain/enforce-aggregate-boundaries")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("최종 일관성");
    expect(text).toContain("원자성");
    expect(text).toContain("소유권");
  });

  test("JavaScript reference equality and numeric guards support the stated counterexamples", () => {
    const first = { id: "same" };
    const second = { id: "same" };
    expect(first === second).toBe(false);
    expect(new Set([first, second]).size).toBe(2);
    expect(Number.NaN < 0 || Number.NaN > 100).toBe(false);
    expect(Number.isFinite(Number.NaN)).toBe(false);
  });
});
