import { describe, expect, test } from "vitest";
import { prepareRules } from "../../core/src/rules/prepare";
import type { LoadedConfig } from "../../core/src/config/types";
import { section07Rules } from "../src/lint/section-07";

const rules = section07Rules;
const ids = [
  "function/names-reflect-effects",
  "function/explicit-input-output",
  "function/no-hidden-input-mutation",
  "function/no-unrelated-output-bundling",
  "function/clear-required-inputs",
  "function/no-confusable-positional-parameters",
  "function/no-implicit-call-order",
  "function/consistent-abstraction-level",
  "function/explicit-nonobvious-preconditions",
  "function/contractual-empty-input",
  "function/handle-boundary-values",
  "function/exhaustive-domain-branches",
  "function/intentional-default-behavior",
  "function/no-surprising-control-effects",
  "function/explicit-callback-contract"
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

describe("section 07 rule definitions", () => {
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

describe("section 07 semantic boundaries", () => {
  test("function/names-reflect-effects", async () => {
    const rule = rules.find((candidate) => candidate.id === "function/names-reflect-effects")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("getOrCreate");
    expect(text).toContain("명명 규약");
    expect(text).toContain("이름만으로");
  });

  test("function/no-hidden-input-mutation", async () => {
    const rule = rules.find((candidate) => candidate.id === "function/no-hidden-input-mutation")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("얕은 복사");
    expect(text).toContain("중첩");
    expect(text).toContain("소유권 이전");
    expect(text).toContain("in-place");
  });

  test("function/no-confusable-positional-parameters", async () => {
    const rule = rules.find((candidate) => candidate.id === "function/no-confusable-positional-parameters")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("좌표");
    expect(text).toContain("같은 타입");
    expect(text).toContain("공개 서명");
  });

  test("function/no-implicit-call-order", async () => {
    const rule = rules.find((candidate) => candidate.id === "function/no-implicit-call-order")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("connect 이전 send");
    expect(text).toContain("프로토콜");
    expect(text).toContain("실제 도달 가능한");
  });

  test("function/explicit-nonobvious-preconditions", async () => {
    const rule = rules.find((candidate) => candidate.id === "function/explicit-nonobvious-preconditions")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("이진 검색");
    expect(text).toContain("재검증");
    expect(text).toContain("호출자");
  });

  test("function/contractual-empty-input", async () => {
    const rule = rules.find((candidate) => candidate.id === "function/contractual-empty-input")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("거부해야 하는 API");
    expect(text).toContain("항등값");
    expect(text).toContain("숫자 경계값");
  });

  test("function/explicit-callback-contract", async () => {
    const rule = rules.find((candidate) => candidate.id === "function/explicit-callback-contract")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("여러 번");
    expect(text).toContain("this");
    expect(text).toContain("오류 책임");
  });

});
