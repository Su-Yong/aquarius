import { describe, expect, test } from "vitest";
import type { LintInstructions, RulePlugin } from "@aquarius/core";
import { prepareRules } from "@aquarius/core/internal";
import type { LoadedConfig, RuleSelection } from "@aquarius/core/internal";
import { cacheRules } from "../src/lint/section-16-cache";

// Specification and preparation tests do not claim live-model detection quality.
const expected = [
  {
    "id": "cache/explicit-cache-ownership",
    "description": "캐시의 생성·갱신·무효화를 어느 모듈이 책임지는지 명확히 합니다."
  },
  {
    "id": "cache/complete-cache-key",
    "description": "결과의 허용된 차이를 구분하는 유효 캐시 identity가 입력·권한·범위·버전 조건을 빠뜨리지 않는지 검사합니다."
  },
  {
    "id": "cache/tenant-isolated-keys",
    "description": "테넌트별 보호 데이터가 유효 캐시 범위에서 격리되는지 확인하고, 별도 저장소·namespace·공개 공용 데이터 계약을 인정합니다."
  },
  {
    "id": "cache/consistent-key-normalization",
    "description": "서로 다른 의미의 입력이 같은 키로 충돌하지 않도록 하고, 동등 입력의 키 통합은 비용 근거가 있을 때 별도 개선으로 평가합니다."
  },
  {
    "id": "cache/explicit-invalidation-triggers",
    "description": "캐시된 값의 변경·버전·만료 계약에 맞는 무효화 또는 갱신 경로를 확인하고, 불변·버전 키 등 대체 전략을 인정합니다."
  },
  {
    "id": "cache/explicit-freshness-budget",
    "description": "업무적으로 허용되는 신선도와 버전 계약을 정하고, 원본 데이터의 나이·저장 지연·갱신 실패를 포함한 실제 제공 상태가 이를 만족하는지 확인합니다."
  },
  {
    "id": "cache/no-stale-writeback",
    "description": "조회·갱신·무효화의 순서와 버전·신선도 계약을 지켜, 늦게 끝난 이전 조회가 최신 값을 덮어쓰거나 무효화된 값을 다시 삽입하지 않도록 합니다."
  },
  {
    "id": "cache/prevent-stampede",
    "description": "동시 miss가 원본 부하 예산을 넘는 근거가 있는 키에 대해 병합·분산 갱신·stale 허용 등의 정책을 평가합니다."
  },
  {
    "id": "cache/bounded-storage",
    "description": "키 수·값 크기·TTL·eviction과 실제 저장 예산을 함께 평가하고, 제거 가능한 캐시와 제거하면 보장이 깨지는 상태 저장소를 구분합니다."
  },
  {
    "id": "cache/explicit-negative-caching",
    "description": "없음·권한 거절·일시 장애를 구분해 캐시 여부·유지 기간·무효화 조건을 정하고, 실패를 확정된 없음으로 저장하지 않습니다."
  },
  {
    "id": "cache/version-serialized-values",
    "description": "배포 간 캐시 형식의 호환·식별·폐기 전략을 확인하고, 명시적 버전 필드 외의 안전한 전환 방식도 인정합니다."
  },
  {
    "id": "cache/no-mutable-reference-leak",
    "description": "읽기 전용·격리된 결과를 약속한 캐시가 가변 참조를 통해 다른 호출자 상태를 바꾸는지 검사하고, 의도된 공유 상태 계약은 구분합니다."
  },
  {
    "id": "cache/explicit-failure-policy",
    "description": "캐시의 역할에 따라 장애 시 원본 조회·실패·제한 응답 경로를 정하고, 필수 권한·정확성 조건과 원본의 부하 예산을 유지합니다."
  },
  {
    "id": "cache/reflect-permission-changes",
    "description": "권한 변경의 반영 기한과 재검사·버전·무효화 경로를 확인하여, 이전 권한 기준의 결과가 허용 범위를 넘어 제공되지 않도록 합니다."
  },
  {
    "id": "cache/no-unintended-command-caching",
    "description": "부작용 작업의 새 논리 실행을 조회 캐시처럼 생략하는지 검사하고, 명시적인 멱등 요청·중복 제거 프로토콜은 별도 계약으로 인정합니다."
  }
];
const rules = cacheRules;
const specifier = "aquarius-section-16-fixture";
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

describe("section 16: cache", () => {
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
    "complete-cache-key",
    "exceptions",
    "partition"
  ],
  [
    "tenant-isolated-keys",
    "exceptions",
    "공개 공용"
  ],
  [
    "no-stale-writeback",
    "evidenceRequirements",
    "재삽입"
  ],
  [
    "consistent-key-normalization",
    "exceptions",
    "정확성 위반과 구분"
  ],
  [
    "prevent-stampede",
    "applicability",
    "부하 예산"
  ],
  [
    "bounded-storage",
    "exceptions",
    "dedup"
  ],
  [
    "explicit-negative-caching",
    "examples",
    "timeout"
  ],
  [
    "no-unintended-command-caching",
    "exceptions",
    "멱등키"
  ]
] as const)("preserves the boundary for %s", async (id, field, fragment) => {
    const rule = rules.find((rule) => rule.id === `cache/${id}`)!;
    const instructions = await rule.buildPrompt({ options: {} });
    expect(JSON.stringify(instructions[field as keyof LintInstructions])).toContain(fragment);
  });
});
