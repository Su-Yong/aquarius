import { describe, expect, test } from "vitest";
import type { LintInstructions, RulePlugin } from "@aquarius/core";
import { prepareRules } from "@aquarius/core/internal";
import type { LoadedConfig, RuleSelection } from "@aquarius/core/internal";
import { privacyRules } from "../src/lint/section-18-privacy";

// Specification and preparation tests do not claim live-model detection quality.
const expected = [
  {
    "id": "privacy/minimize-personal-data-collection",
    "description": "처리 목적과 필요한 범위에 비추어 개인정보 수집을 검토하고, 목적·필요성의 근거가 없으면 이를 설계 위험으로 드러내되 과잉 수집 여부를 임의로 단정하지 않습니다."
  },
  {
    "id": "privacy/explicit-sensitive-data-flow",
    "description": "민감 데이터가 어느 모듈과 외부 서비스로 전달되는지 추적 가능하게 합니다."
  },
  {
    "id": "privacy/redact-sensitive-logs",
    "description": "로그 목적·분류·접근 정책상 허용되지 않은 민감 정보가 메시지·구조화 필드·오류 원인에 남지 않도록 제거·마스킹하거나 승인된 보호 방식으로 처리합니다."
  },
  {
    "id": "privacy/no-secrets-in-urls",
    "description": "장기 자격증명이나 의도하지 않은 비밀값이 URL로 노출되지 않도록 하며, 승인된 서명·일회성 URL은 권한 범위·수명·기록 및 재전달 정책을 확인합니다."
  },
  {
    "id": "privacy/no-production-data-in-tests",
    "description": "운영 유래 개인정보가 승인된 목적·보호·보존 범위 없이 테스트 코드·자료·외부 테스트 서비스로 복제되지 않도록 합니다."
  },
  {
    "id": "privacy/explicit-retention-policy",
    "description": "데이터별 보존·만료·보류 정책과 집행 책임을 명시하고, 정책 미정·확인 불가와 구현의 정책 위반을 구분해 보고합니다. 근거 없는 일률적 보존 기간은 요구하지 않습니다."
  },
  {
    "id": "privacy/complete-deletion-propagation",
    "description": "승인된 삭제 정책에 따라 원본·파생 데이터·캐시·검색 인덱스·복제본·백업 복원 경로의 삭제 또는 접근 차단과 완료 조건이 연결되도록 합니다."
  },
  {
    "id": "privacy/consistent-data-classification",
    "description": "같은 의미·표현과 정책 범위의 데이터가 경계를 지나며 근거 없이 덜 민감하게 분류되거나 보호가 약해지지 않도록 하고, 검증된 변환과 처리 맥락의 차이는 구분합니다."
  },
  {
    "id": "privacy/protected-sensitive-storage",
    "description": "민감 데이터의 저장·키 관리·접근 보호가 애플리케이션 또는 인프라의 실제 집행 경로에서 충족되는지 확인하고, 보호 정책이나 배포 보장의 누락·확인 불가는 별도 위험으로 남깁니다."
  },
  {
    "id": "privacy/least-privilege-data-projection",
    "description": "응답·내보내기의 실제 직렬화 결과가 호출자와 목적에 허용된 필드 범위를 넘지 않도록 합니다. 타입 축소만을 필드 제거로 간주하지 않고, 전체 모델 반환도 보호 필드 변경 시 공개 계약을 확인합니다."
  },
  {
    "id": "privacy/no-sensitive-metric-identifiers",
    "description": "개인 식별값이나 비밀값이 측정 지표의 이름·태그에 포함되지 않도록 합니다."
  },
  {
    "id": "privacy/scrub-exported-artifacts",
    "description": "CSV·보고서·오류 덤프 등 산출물이 승인된 목적·수신자·필드 범위를 넘는 민감 정보를 포함하지 않도록 합니다."
  },
  {
    "id": "privacy/separate-consent-state",
    "description": "동의가 필요한 기능에서 동의 여부를 일반 활동 상태나 로그인 여부와 혼동하지 않도록 합니다."
  },
  {
    "id": "privacy/filter-third-party-telemetry",
    "description": "외부 관측 서비스로 전송되기 전에 승인된 수신자·목적·필드 정책을 적용하고, 필터 실패나 재시도 경로에서도 민감 정보가 그대로 전송되지 않도록 합니다. 변환 후의 식별 가능성도 확인합니다."
  },
  {
    "id": "privacy/no-cross-user-response-reuse",
    "description": "개인화 응답의 HTTP 및 애플리케이션 재사용이 사용자·테넌트·권한 경계를 넘지 않도록 캐시 범위·키·재검증 및 무효화 계약을 검사합니다."
  }
];
const rules = privacyRules;
const specifier = "aquarius-section-18-fixture";
const plugin: RulePlugin = { namespace: "aquarius", lintRules: rules };
const config = (selections: RuleSelection[]): LoadedConfig => ({
  tool: "lint",
  cwd: import.meta.dirname,
  projectRoot: import.meta.dirname,
  configDirectory: import.meta.dirname,
  files: [],
  ignore: [],
  plugins: [specifier],
  ai: { adapter: "unused", options: {}, timeoutMs: 1_000 },
  rules: selections,
});
const prepare = (selections: RuleSelection[]) => prepareRules(config(selections), { [specifier]: plugin });

describe("section 18: privacy", () => {
  test("preserves every canonical ID and description without enabling rules", async () => {
    expect(rules.map(({ id, description }) => ({ id, description }))).toEqual(expected);
    expect(new Set(rules.map(({ id }) => id)).size).toBe(15);
    expect(await prepare([])).toEqual({ rules: [], errors: [] });
  });

  test.each(rules)("$id builds the six-field instructions through the actual engine API", async (rule) => {
    const result = await prepare([{ rule: `aquarius/${rule.id}` }]);
    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]!.id).toBe(`aquarius/${rule.id}`);
    expect(result.rules[0]!.scope).toBe("project");
    expect(result.rules[0]!.severity).toBe("warn");
    const instructions = result.rules[0]!.instructions as LintInstructions;
    expect(Object.keys(instructions).sort()).toEqual([
      "applicability", "criteria", "evidenceRequirements", "examples", "exceptions", "procedure",
    ]);
    expect(instructions.criteria).toContain(rule.description);
    expect(instructions.criteria).toContain("unknown");
    expect(instructions.criteria).toContain("설정·문서·전용 검사기 부재를 pass나 결함의 자동 근거로 삼지 않는다");
    expect(instructions.evidenceRequirements.length).toBeGreaterThanOrEqual(3);
    expect(instructions.exceptions!.length).toBeGreaterThan(0);
    expect(instructions.procedure!.length).toBeGreaterThanOrEqual(4);
    expect(instructions.examples!.map(({ expected }) => expected)).toEqual([
      "violation", "pass", "unknown", "not_applicable",
    ]);
    for (const example of instructions.examples!) {
      expect(example.scenario.length).toBeGreaterThan(20);
      expect(example.reason.length).toBeGreaterThan(20);
    }
  });

  test.each(rules)("$id remains independent of disabled neighbors and validates options", async (rule) => {
    const neighbor = rules.find(({ id }) => id !== rule.id)!;
    const result = await prepare([
      { rule: `aquarius/${neighbor.id}`, severity: "off" },
      { rule: `aquarius/${rule.id}`, severity: "error" },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.rules.map(({ id, severity }) => ({ id, severity }))).toEqual([
      { id: `aquarius/${rule.id}`, severity: "error" },
    ]);
    const invalid = await prepare([{ rule: `aquarius/${rule.id}`, options: { inventedPolicy: true } }]);
    expect(invalid.rules).toEqual([]);
    expect(invalid.errors.map(({ code }) => code)).toEqual(["RULE_OPTIONS_INVALID"]);
  });

  test.each(rules)("$id returns fresh instructions without retaining caller mutations", async (rule) => {
    const first = await rule.buildPrompt({ options: Object.freeze({}) });
    const second = await rule.buildPrompt({ options: Object.freeze({}) });
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first.evidenceRequirements.push("caller mutation");
    first.exceptions!.push("caller mutation");
    first.examples![0]!.reason = "caller mutation";
    expect(await rule.buildPrompt({ options: {} })).toEqual(second);
  });

  test("retains all independent selections when the section is enabled together", async () => {
    const result = await prepare(rules.map(({ id }) => ({ rule: `aquarius/${id}` })));
    expect(result.errors).toEqual([]);
    expect(result.rules.map(({ id }) => id)).toEqual(expected.map(({ id }) => `aquarius/${id}`));
  });

  test.each([
  [
    "minimize-personal-data-collection",
    "examples",
    "설계 위험"
  ],
  [
    "redact-sensitive-logs",
    "evidenceRequirements",
    "Error.cause"
  ],
  [
    "no-secrets-in-urls",
    "exceptions",
    "capability URL"
  ],
  [
    "complete-deletion-propagation",
    "exceptions",
    "백업"
  ],
  [
    "least-privilege-data-projection",
    "exceptions",
    "Pick"
  ],
  [
    "filter-third-party-telemetry",
    "examples",
    "원문을 fallback"
  ],
  [
    "no-sensitive-metric-identifiers",
    "exceptions",
    "cardinality"
  ],
  [
    "no-cross-user-response-reuse",
    "exceptions",
    "no-cache"
  ]
] as const)("preserves the boundary for %s", async (id, field, fragment) => {
    const rule = rules.find((rule) => rule.id === `privacy/${id}`)!;
    const instructions = await rule.buildPrompt({ options: {} });
    expect(JSON.stringify(instructions[field as keyof LintInstructions])).toContain(fragment);
  });
});
