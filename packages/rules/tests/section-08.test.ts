import { describe, expect, test } from "vitest";
import { prepareRules } from "../../core/src/rules/prepare";
import type { LoadedConfig } from "../../core/src/config/types";
import { section08Rules } from "../src/lint/section-08";

const rules = section08Rules;
const ids = [
  "contract/document-public-behavior",
  "contract/validate-untrusted-runtime-inputs",
  "contract/separate-transport-domain-types",
  "contract/no-unjustified-boundary-casts",
  "contract/explicit-error-results",
  "contract/preserve-nullability-semantics",
  "contract/separate-input-output-schemas",
  "contract/explicit-optional-field-semantics",
  "contract/explicit-mutability",
  "contract/no-unintended-vendor-type-leak",
  "contract/stable-serialization",
  "contract/match-sync-async-behavior",
  "contract/explicit-cancellation-semantics",
  "contract/consumer-compatible-changes",
  "contract/explicit-result-ordering"
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

describe("section 08 rule definitions", () => {
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

describe("section 08 semantic boundaries", () => {
  test("contract/document-public-behavior", async () => {
    const rule = rules.find((candidate) => candidate.id === "contract/document-public-behavior")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("독자");
    expect(text).toContain("내부 테스트");
    expect(text).toContain("필수 설명");
  });

  test("contract/validate-untrusted-runtime-inputs", async () => {
    const rule = rules.find((candidate) => candidate.id === "contract/validate-untrusted-runtime-inputs")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("사용 경로를 지배");
    expect(text).toContain("별칭 변경");
    expect(text).toContain("같은 값");
    expect(text).toContain("모든 계층");
  });

  test("contract/no-unjustified-boundary-casts", async () => {
    const rule = rules.find((candidate) => candidate.id === "contract/no-unjustified-boundary-casts")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("Number");
    expect(text).toContain("NaN");
    expect(text).toContain("JSDoc");
    expect(text).toContain("유한성");
  });

  test("contract/explicit-optional-field-semantics", async () => {
    const rule = rules.find((candidate) => candidate.id === "contract/explicit-optional-field-semantics")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("own property");
    expect(text).toContain("Object.hasOwn");
    expect(text).toContain("patch");
    expect(text).toContain("nullability");
  });

  test("contract/stable-serialization", async () => {
    const rule = rules.find((candidate) => candidate.id === "contract/stable-serialization")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("BigInt");
    expect(text).toContain("undefined");
    expect(text).toContain("prototype");
    expect(text).toContain("transfer");
  });

  test("contract/match-sync-async-behavior", async () => {
    const rule = rules.find((candidate) => candidate.id === "contract/match-sync-async-behavior")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("즉시 throw");
    expect(text).toContain("Promise 거부");
    expect(text).toContain("EventEmitter");
    expect(text).toContain("EventTarget");
    expect(text).toContain("write");
  });

  test("contract/consumer-compatible-changes", async () => {
    const rule = rules.find((candidate) => candidate.id === "contract/consumer-compatible-changes")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("이전 계약");
    expect(text).toContain("지원 버전");
    expect(text).toContain("주 버전");
    expect(text).toContain("ESM");
  });

  test("contract/explicit-cancellation-semantics", async () => {
    const rule = rules.find((candidate) => candidate.id === "contract/explicit-cancellation-semantics")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("이미 커밋");
    expect(text).toContain("signal.aborted");
    expect(text).toContain("reason");
    expect(text).toContain("API·버전");
  });

  test("field existence and JSON preservation are distinct from value reads", () => {
    const absent: { value?: undefined } = {};
    const present = { value: undefined };
    expect(absent.value).toBe(present.value);
    expect(Object.hasOwn(absent, "value")).toBe(false);
    expect(Object.hasOwn(present, "value")).toBe(true);
    expect(Object.hasOwn(JSON.parse(JSON.stringify(present)), "value")).toBe(false);
    expect(() => JSON.stringify({ value: 1n })).toThrow(TypeError);
  });
});
