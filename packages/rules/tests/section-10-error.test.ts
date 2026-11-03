import { describe, expect, test } from "vitest";
import { prepareRules } from "../../core/src/rules/prepare";
import type { LoadedConfig } from "../../core/src/config/types";
import { errorRules } from "../src/lint/section-10-error";

const rules = errorRules;
const expectedDescriptions: Record<string, string> = {
  "error/no-swallowed-errors": "오류를 처리하는 경로가 합의된 전파·복구·의도적 무시 계약을 지키는지 검사하고, 기록만으로 처리 완료로 간주하지 않습니다.",
  "error/catch-at-recoverable-boundary": "오류를 복구·변환·관측하거나 자원을 정리할 책임이 있는 경계에서 처리하고, 의미 없는 중간 catch를 구분합니다.",
  "error/preserve-original-cause": "오류 변환 시 필요한 원인과 맥락을 내부 진단 경로에 보존하되, 외부 응답에는 허용된 정보만 전달합니다.",
  "error/distinguish-failure-kinds": "복구·재시도·업무 판단에 필요한 실패 종류를 유지하되, 보안·프로토콜 계약상 의도적인 외부 통합 응답은 허용합니다.",
  "error/no-failure-as-success": "필수 처리가 실패했거나 결과가 불확실한데 빈 값·정상 상태로 성공을 가장하지 않도록 하며, 계약상 허용된 없음·접수·열화 결과는 구분합니다.",
  "error/explicit-partial-failure": "부분 성공을 허용하는 작업은 항목별 완료·실패·결과 불확실 범위와 재처리 계약을 드러내고, 원자성이 필요한 작업은 부분 결과를 성공으로 노출하지 않습니다.",
  "error/consistent-boundary-translation": "동일한 외부 계약·버전·소비자 범위에서 같은 실패가 모순된 의미로 변환되지 않도록 합니다.",
  "error/no-retry-of-permanent-failure": "입력·권한·업무 조건이 바뀌지 않는 실패의 무의미한 반복을 막고, 조건을 갱신한 뒤의 제한된 재시도는 별도로 평가합니다.",
  "error/do-not-mask-cancellation": "지원 API의 취소 신호와 원인을 일반 장애·재시도로 바꾸지 않고, 취소 책임 경계에서 합의된 종료 상태로 처리합니다.",
  "error/justified-fallback": "대체값이나 대체 경로가 업무적으로 허용되는 경우에만 실패를 대신하도록 합니다.",
  "error/bounded-fallback-chain": "대체 경로에 진행·종료 근거 없는 순환이나 무제한 대기가 생기지 않도록 전체 시도·시간 예산을 확인하며, 계약상 제한된 재방문은 허용합니다.",
  "error/preserve-primary-cleanup-failure": "작업 실패와 정리 실패가 함께 발생하면 두 실패의 관계와 원인을 보존하고, 대상 런타임의 정리 오류 전파 규약을 존중합니다.",
  "error/no-unrelated-exception-control-flow": "프로젝트가 금지한 예외 기반 제어 흐름만 검사하며, 프레임워크가 문서화한 제어 신호는 허용합니다.",
  "error/no-sensitive-client-details": "외부 오류 응답에 내부 경로·비밀값·민감한 구현 정보를 노출하지 않도록 합니다.",
  "error/distinguish-missing-from-unavailable": "데이터가 없다는 확정 결과와 조회를 완료하지 못한 상태를 구분하고, 계약상 허용된 외부 은닉 응답은 내부 진단에서 구별합니다."
};

const config = (selections: LoadedConfig["rules"]): LoadedConfig => ({
  tool: "lint",
  cwd: process.cwd(),
  projectRoot: process.cwd(),
  configDirectory: process.cwd(),
  files: [],
  ignore: [],
  plugins: ["section-rules"],
  ai: { adapter: "unused", options: {}, timeoutMs: 1_000 },
  rules: selections,
});
const plugins = { "section-rules": { namespace: "aquarius", lintRules: rules } };

describe("section 10: error", () => {
  test("preserves every canonical ID and full criterion independently", () => {
    expect(rules.map((rule) => rule.id)).toEqual(Object.keys(expectedDescriptions));
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(15);
    for (const rule of rules) {
      expect(rule.description).toBe(expectedDescriptions[rule.id]);
      expect(rule.defaultSeverity).toBe("warn");
    }
  });

  test("prepares all definitions through the existing strict engine API", async () => {
    const result = await prepareRules(config(rules.map((rule) => ({ rule: `aquarius/${rule.id}` }))), plugins);
    expect(result.errors).toEqual([]);
    expect(result.rules.map((rule) => rule.id)).toEqual(rules.map((rule) => `aquarius/${rule.id}`));
    for (const rule of result.rules) expect(rule.severity).toBe("warn");
  });

  test("registration is opt-in and an off rule is not prepared", async () => {
    expect(await prepareRules(config([]), plugins)).toEqual({ rules: [], errors: [] });
    const result = await prepareRules(config(rules.map((rule) => ({ rule: `aquarius/${rule.id}`, severity: "off" }))), plugins);
    expect(result).toEqual({ rules: [], errors: [] });
  });

  test("keeps each rule selectable without activating related rules", async () => {
    for (const selected of rules) {
      const result = await prepareRules(config([{ rule: `aquarius/${selected.id}`, severity: "error" }]), plugins);
      expect(result.errors).toEqual([]);
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0]?.id).toBe(`aquarius/${selected.id}`);
      expect(result.rules[0]?.severity).toBe("error");
    }
  });

  test("rejects unsupported options without breaking another selected rule", async () => {
    const result = await prepareRules(config([
      { rule: `aquarius/${rules[0]!.id}`, options: { inventedThreshold: 1 } },
      { rule: `aquarius/${rules[1]!.id}` },
    ]), plugins);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("RULE_OPTIONS_INVALID");
    expect(result.rules.map((rule) => rule.id)).toEqual([`aquarius/${rules[1]!.id}`]);
    for (const rule of rules) {
      expect(rule.optionsSchema?.safeParse({}).success).toBe(true);
      expect(rule.optionsSchema?.safeParse({ inventedThreshold: 1 }).success).toBe(false);
    }
  });

  test("preserves evidence gates, exceptions, and all four semantic outcomes", async () => {
    for (const rule of rules) {
      const prompt = await rule.buildPrompt({ options: {} });
      expect(prompt.criteria).toContain(expectedDescriptions[rule.id]);
      expect(prompt.criteria).toContain("Missing or conflicting evidence is unknown");
      expect(prompt.criteria).toContain("Pass requires sufficient inspection");
      expect(prompt.evidenceRequirements.length).toBeGreaterThanOrEqual(3);
      expect(prompt.exceptions?.length).toBeGreaterThan(0);
      expect(prompt.procedure?.join(" ")).toContain("Preserve independent rule activation");
      expect(prompt.examples?.map((example) => example.expected)).toEqual(["violation", "pass", "unknown", "not_applicable"]);
      expect(prompt.examples?.every((example) => example.scenario.trim() && example.reason.trim())).toBe(true);
    }
  });

  test("returns independent prompt data and leaves caller options unchanged", async () => {
    for (const rule of rules) {
      const options = Object.freeze({});
      const first = await rule.buildPrompt({ options });
      const expected = structuredClone(first);
      first.evidenceRequirements.push("mutated by a consumer");
      first.exceptions?.push("unrelated exception");
      if (first.examples?.[0]) first.examples[0].scenario = "altered";
      expect(await rule.buildPrompt({ options })).toEqual(expected);
      expect(options).toEqual({});
      expect(rule.defaultOptions).toEqual({});
    }
  });
});

const semanticDetails: Record<string, string[]> = {
  "error/preserve-original-cause": [
    "내부",
    "외부",
    "serializer"
  ],
  "error/explicit-partial-failure": [
    "원자",
    "불확실",
    "allSettled"
  ],
  "error/do-not-mask-cancellation": [
    "reason",
    "API·버전",
    "인과관계",
    "signal.aborted"
  ],
  "error/preserve-primary-cleanup-failure": [
    "SuppressedError",
    "최상위",
    "finally"
  ],
  "error/no-unrelated-exception-control-flow": [
    "정책",
    "redirect",
    "프레임워크"
  ]
};

test.each(Object.entries(semanticDetails))("preserves reviewed semantic boundaries for %s", async (id, details) => {
  const rule = rules.find((candidate) => candidate.id === id)!;
  const prompt = JSON.stringify(await rule.buildPrompt({ options: {} }));
  for (const detail of details) expect(prompt).toContain(detail);
});
