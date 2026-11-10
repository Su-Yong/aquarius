import { describe, expect, test } from "vitest";
import { allRulesPreset } from "../src/presets";
import { prepareRules } from "../../core/src/rules/prepare";
import type { LoadedConfig } from "../../core/src/config/types";
import { section03Rules } from "../src/lint/section-03";

const rules = section03Rules;
const ids = [
  "dependency/explicit-dependencies",
  "dependency/no-service-locator",
  "dependency/compose-at-boundary",
  "dependency/consumer-owned-ports",
  "dependency/narrow-injected-capabilities",
  "dependency/explicit-dependency-lifetime",
  "dependency/no-lifetime-inversion",
  "dependency/inject-nondeterministic-sources",
  "dependency/no-redundant-injection",
  "dependency/isolate-optional-integrations",
  "dependency/no-hidden-fallback-resolution",
  "dependency/explicit-resource-ownership",
  "dependency/deterministic-wiring",
  "dependency/no-circular-construction",
  "dependency/contract-preserving-decorators",
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

describe("section 03 rule definitions", () => {
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

describe("section 03 semantic boundaries", () => {
  test("dependency/explicit-dependencies", async () => {
    const rule = rules.find((candidate) => candidate.id === "dependency/explicit-dependencies")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("명시적");
    expect(text).toContain("순수 함수");
    expect(text).toContain("교체·격리");
    expect(text).toContain("AsyncLocalStorage");
  });

  test("dependency/no-service-locator", async () => {
    const rule = rules.find((candidate) => candidate.id === "dependency/no-service-locator")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("불변 로케이터");
    expect(text).toContain("금지 범위");
    expect(text).toContain("Map.get");
  });

  test("dependency/narrow-injected-capabilities", async () => {
    const rule = rules.find(
      (candidate) => candidate.id === "dependency/narrow-injected-capabilities",
    )!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("Pick·Omit");
    expect(text).toContain("런타임 메서드");
    expect(text).toContain("허용 기능·권한");
    expect(text).toContain("this");
  });

  test("dependency/no-lifetime-inversion", async () => {
    const rule = rules.find((candidate) => candidate.id === "dependency/no-lifetime-inversion")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("프록시·팩터리");
    expect(text).toContain("실제 보유·사용");
    expect(text).toContain("요청");
  });

  test("dependency/inject-nondeterministic-sources", async () => {
    const rule = rules.find(
      (candidate) => candidate.id === "dependency/inject-nondeterministic-sources",
    )!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("보안");
    expect(text).toContain("고정 입력");
    expect(text).toContain("가상 시계");
  });

  test("dependency/explicit-resource-ownership", async () => {
    const rule = rules.find(
      (candidate) => candidate.id === "dependency/explicit-resource-ownership",
    )!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("실제");
    expect(text).toContain("누수");
    expect(text).toContain("소유권");
  });

  test("dependency/no-circular-construction", async () => {
    const rule = rules.find((candidate) => candidate.id === "dependency/no-circular-construction")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("즉시 생성");
    expect(text).toContain("지연 참조");
    expect(text).toContain("모듈 import 순환");
  });

  test("dependency/contract-preserving-decorators", async () => {
    const rule = rules.find(
      (candidate) => candidate.id === "dependency/contract-preserving-decorators",
    )!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("this");
    expect(text).toContain("취소");
    expect(text).toContain("부작용 횟수");
  });
});
