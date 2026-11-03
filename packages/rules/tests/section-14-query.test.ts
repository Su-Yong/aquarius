import { describe, expect, test } from "vitest";
import { prepareRules } from "../../core/src/rules/prepare";
import type { LoadedConfig } from "../../core/src/config/types";
import { queryRules } from "../src/lint/section-14-query";

const rules = queryRules;
const expectedDescriptions: Record<string, string> = {
  "query/no-n-plus-one-access": "목록 크기에 따라 증가하는 추가 I/O와 실제 비용을 확인하고, 항목별 계약·배치·캐시를 고려해 과도한 접근을 검사합니다.",
  "query/bounded-result-sets": "성장 가능한 결과의 반환·적재·소비와 총 작업량·시간·취소 계약을 확인하여 자원 예산을 넘는 무제한 처리를 방지합니다. 제한된 버퍼의 스트리밍·커서를 허용하되, 버퍼 한도만으로 전체 처리 계약이 충족된다고 간주하지 않습니다.",
  "query/stable-pagination-order": "페이지 조회에 일관된 정렬 기준과 필요한 동률 처리 기준을 사용합니다.",
  "query/pagination-consistency-under-writes": "조회 중 변경에 대한 중복·누락·스냅샷 계약을 정하고, 정렬 키 변경과 커서·격리 수준의 실제 보장을 비교합니다.",
  "query/select-required-fields": "사용 목적 대비 불필요한 대용량·민감 필드의 조회와 허용되지 않은 정보 흐름을 검사하고, 필요한 최소 범위의 조회를 유지합니다. 작은 안정된 레코드의 전체 조회는 계약에 따라 허용합니다.",
  "query/guard-bulk-mutations": "조건 누락이나 범위 오류로 전체 데이터가 수정·삭제될 수 있는 경로를 보호합니다.",
  "query/no-unbounded-client-filtering": "조회 후 폐기되는 데이터의 규모·비용을 확인하고, 저장소에서 같은 의미로 처리할 수 있는 경우에 한해 필터 이동을 제안합니다.",
  "query/no-hidden-lazy-load": "문서·테스트·호출 계약으로 확인한 렌더링·직렬화의 I/O 경계를 암묵적 lazy load가 넘는지 검사하고, 명시된 비동기 로딩·허용 비용 계약은 구분합니다.",
  "query/index-aware-access-paths": "스키마·데이터 분포·검증된 실행 계획과 비용 예산이 있는 경우에만 주요 조회의 접근 경로 문제를 보고합니다.",
  "query/avoid-index-defeating-hot-paths": "실제 스키마·표현식 인덱스·연산자 클래스·정렬 규칙·실행 계획·비용을 근거로 조건식의 접근 경로 문제를 검사합니다. 순차 스캔 자체를 결함으로 단정하지 않으며 일반 접근 경로 검사와 같은 발견만 묶고 독립 설정을 유지합니다.",
  "query/no-redundant-round-trips": "동일 의미와 실패·권한 계약을 유지한 채 줄일 수 있는 불필요한 왕복을 확인하고, 배치 부작용을 함께 평가합니다.",
  "query/consistent-count-and-data-filters": "목록과 개수의 각 의미·필터·스냅샷 계약을 확인하고, 같은 집합을 뜻한다고 약속한 경우의 불일치만 보고합니다.",
  "query/bounded-batch-size": "대상 엔진·전송·메모리·잠금의 한도와 항목 크기를 근거로 배치 크기와 실패·재시도 단위를 정합니다.",
  "query/scale-appropriate-pagination": "데이터 규모와 페이지 접근 패턴·실행 비용을 근거로 페이지 방식을 검토하고, 임의 페이지 이동 등 요구 계약을 보존합니다.",
  "query/explicit-read-consistency": "조회에 필요한 최신성·자기 쓰기 반영·스냅샷 일관성과 허용 지연을 구분하고, 캐시·복제본·격리 수준의 실제 보장이 해당 계약을 만족하는지 확인합니다."
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

describe("section 14: query", () => {
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
  "query/bounded-result-sets": [
    "총 작업",
    "시간",
    "취소",
    "버퍼"
  ],
  "query/pagination-consistency-under-writes": [
    "keyset",
    "snapshot",
    "mutable sort key"
  ],
  "query/avoid-index-defeating-hot-paths": [
    "표현식 인덱스",
    "operator",
    "collation",
    "순차 스캔"
  ],
  "query/consistent-count-and-data-filters": [
    "같은 집합",
    "faceted total",
    "스냅샷"
  ],
  "query/scale-appropriate-pagination": [
    "임의 페이지",
    "작은 데이터",
    "offset"
  ]
};

test.each(Object.entries(semanticDetails))("preserves reviewed semantic boundaries for %s", async (id, details) => {
  const rule = rules.find((candidate) => candidate.id === id)!;
  const prompt = JSON.stringify(await rule.buildPrompt({ options: {} }));
  for (const detail of details) expect(prompt).toContain(detail);
});
