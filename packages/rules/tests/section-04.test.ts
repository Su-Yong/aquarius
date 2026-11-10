import { describe, expect, test } from "vitest";
import { allRulesPreset } from "../src/presets";
import { prepareRules } from "../../core/src/rules/prepare";
import type { LoadedConfig } from "../../core/src/config/types";
import { section04Rules } from "../src/lint/section-04";

const rules = section04Rules;
const ids = [
  "abstraction/evidence-based-abstraction",
  "abstraction/no-unrelated-concept-sharing",
  "abstraction/no-policy-boolean-flags",
  "abstraction/no-stringly-typed-policy",
  "abstraction/no-empty-strategy-objects",
  "abstraction/prefer-data-for-static-variation",
  "abstraction/preserve-semantic-differences",
  "abstraction/separate-mechanism-and-policy",
  "abstraction/no-inheritance-only-for-reuse",
  "abstraction/no-subclass-type-switches",
  "abstraction/no-fragile-base-hooks",
  "abstraction/no-unused-generic-variation",
  "abstraction/justified-abstraction-depth",
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
  preset: [],
  rules: selected,
});
const plugins = { section: { namespace: "aquarius", lintRules: rules } };

describe("section 04 rule definitions", () => {
  test("preserves the canonical independent IDs and report-only defaults", () => {
    expect(rules.map((rule) => rule.id)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => allRulesPreset[`aquarius/${id}`] === "warn")).toBe(true);
  });

  test("prepares every rule through the existing engine API", async () => {
    const selections = Object.fromEntries(
      ids.map((id) => [`aquarius/${id}`, allRulesPreset[`aquarius/${id}`]]),
    );
    const prepared = await prepareRules(config(selections), plugins);
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
      expect(prompt.examples?.map((example) => example.expected)).not.toContain("unknown");
      expect(prompt.criteria).toContain("보고 전용");
    }
  });

  test("registration leaves rules inactive and off disables only the selected rule", async () => {
    expect(await prepareRules(config({}), plugins)).toEqual({ rules: [], errors: [] });
    const selections = Object.fromEntries(
      ids.map((id) => [`aquarius/${id}`, allRulesPreset[`aquarius/${id}`]]),
    );
    const active = await prepareRules(config(selections), plugins);
    expect(active.errors).toEqual([]);
    expect(active.rules.map(({ id }) => id)).toEqual(ids.map((id) => `aquarius/${id}`));

    for (const disabled of ids) {
      const withOff = await prepareRules(
        config({ ...selections, [`aquarius/${disabled}`]: "off" }),
        plugins,
      );
      expect(withOff.errors).toEqual([]);
      expect(withOff.rules).toEqual(active.rules.filter(({ id }) => id !== `aquarius/${disabled}`));
    }
  });

  test("rejects invented options without dropping other selected rules", async () => {
    const prepared = await prepareRules(
      config({
        [`aquarius/${ids[0]}`]: ["warn", { invented: true }],
        [`aquarius/${ids[1]}`]: "warn",
      }),
      plugins,
    );
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

describe("section 04 semantic boundaries", () => {
  test("abstraction/evidence-based-abstraction", async () => {
    const rule = rules.find(
      (candidate) => candidate.id === "abstraction/evidence-based-abstraction",
    )!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("비공유");
    expect(text).toContain("확인된 목적 없는 확장 도입");
    expect(text).toContain("독립 이점 없는 전달 계층");
    expect(text).toContain("목적 자료를 못 찾은 것");
    expect(text).toContain("실제 플러그인 요구");
    expect(text).toContain("공개 호환·권한 제한·관측·수명 소유");
  });

  test("abstraction/no-stringly-typed-policy", async () => {
    const rule = rules.find(
      (candidate) => candidate.id === "abstraction/no-stringly-typed-policy",
    )!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("JavaScript");
    expect(text).toContain("문자열 태그");
    expect(text).toContain("enum");
    expect(text).toContain("기본·오류");
  });

  test("abstraction/no-empty-strategy-objects", async () => {
    const rule = rules.find(
      (candidate) => candidate.id === "abstraction/no-empty-strategy-objects",
    )!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("식별");
    expect(text).toContain("수명");
    expect(text).toContain("권한");
    expect(text).toContain("독립 배포");
    expect(text).toContain("본문");
  });

  test("abstraction/no-unused-generic-variation", async () => {
    const rule = rules.find(
      (candidate) => candidate.id === "abstraction/no-unused-generic-variation",
    )!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("브랜딩");
    expect(text).toContain("JSDoc generic");
    expect(text).toContain("일반 JavaScript");
    expect(text).toContain("정적 타입");
  });

  test("abstraction/justified-abstraction-depth", async () => {
    const rule = rules.find(
      (candidate) => candidate.id === "abstraction/justified-abstraction-depth",
    )!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("호출 경로");
    expect(text).toContain("깊이 수치만으로");
    expect(text).toContain("독립 계약");
  });

  test("historical abstraction IDs are not registered or silently migrated", async () => {
    const previous = [
      "abstraction/no-speculative-extension",
      "abstraction/no-empty-pass-through-layer",
    ];
    for (const id of previous) expect(ids).not.toContain(id);
    const selections = Object.fromEntries(
      previous.map((id) => [`aquarius/${id}`, "warn" as const]),
    );
    const prepared = await prepareRules(config(selections), plugins);
    expect(prepared.rules).toEqual([]);
    expect(prepared.errors.map((error) => error.code)).toEqual([
      "RULE_NOT_FOUND",
      "RULE_NOT_FOUND",
    ]);
  });

  test("optional simplification is not emitted as a confirmed contract violation", async () => {
    for (const id of [
      "abstraction/evidence-based-abstraction",
      "abstraction/no-empty-strategy-objects",
    ]) {
      const prompt = await rules.find((rule) => rule.id === id)!.buildPrompt({ options: {} });
      expect(prompt.examples?.[0]?.expected).toBe("pass");
      expect(prompt.criteria).toContain("선택적 설계 개선은 계약 위반과 구분");
    }
    const typed = await rules
      .find((rule) => rule.id === "abstraction/no-unused-generic-variation")!
      .buildPrompt({ options: {} });
    expect(typed.examples?.some((example) => example.expected === "not_applicable")).toBe(true);
  });
});
