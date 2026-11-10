import { describe, expect, test } from "vitest";
import { allRulesPreset } from "../src/presets";
import { prepareRules } from "../../core/src/rules/prepare";
import type { LoadedConfig } from "../../core/src/config/types";
import { persistenceRules } from "../src/lint/section-13-persistence";

const rules = persistenceRules;
const expectedDescriptions: Record<string, string> = {
  "persistence/explicit-transaction-boundaries":
    "함께 원자적으로 확정되어야 하는 변경과 그 저장소 범위를 확인합니다. 부분 상태를 허용하는 업무는 별도의 분산 일관성·보상·복구 계약을 검증하며, 보상을 원자성의 일반적인 대체로 간주하지 않습니다.",
  "persistence/propagate-transaction-context":
    "하나의 업무 처리 중 일부 저장만 다른 연결이나 트랜잭션으로 빠져나가지 않도록 합니다.",
  "persistence/preserve-write-invariants":
    "문서·스키마·테스트·호출 계약으로 확인한 데이터 불변식마다 변경 경로와 동시성·제약 조건을 연결해 보존 여부를 검사하고, 데이터베이스 기능의 보장 범위를 넘겨 추정하지 않습니다.",
  "persistence/no-premature-external-effects":
    "롤백 가능한 변경을 확정 사실로 노출하는 외부 효과를 찾고, 명시적 예약·보상 프로토콜은 계약에 따라 평가합니다.",
  "persistence/atomic-state-event-publication":
    "상태 변경과 필요한 이벤트의 발행 의도가 함께 내구화되고, 이후 전달·중복·순서·실패 복구가 요구 계약을 만족하는지 검사합니다.",
  "persistence/no-blind-lost-updates":
    "다른 작업의 변경을 확인하지 않고 이전 값으로 덮어쓰지 않도록 합니다.",
  "persistence/enforce-required-uniqueness":
    "업무상 유일성의 범위를 명시하고, 동시 요청에서도 해당 범위를 보장하는 원자적 제약과 충돌 처리를 확인합니다.",
  "persistence/consistent-soft-delete":
    "논리 삭제의 공개·관리·복구·유일성 계약을 확인한 범위에서 조회와 변경의 일관성을 검사합니다.",
  "persistence/explicit-cascade-policy":
    "부모 데이터 삭제가 관련 데이터에 미치는 영향을 명확히 합니다.",
  "persistence/backward-compatible-migrations":
    "구·신 버전 공존과 롤백 요구가 있는 배포에서 스키마·코드 전환 순서가 지원 계약을 유지하는지 검사합니다.",
  "persistence/resumable-data-migrations":
    "중단될 수 있는 대규모 데이터 변경에 재개·안전한 재실행·롤백 중 요구되는 복구 방식을 마련합니다.",
  "persistence/parameterize-data-queries":
    "비신뢰 값을 쿼리 구문과 분리해 전달하고, 동적 식별자·정렬·연산자는 해당 엔진의 허용 목록과 안전한 구성 API로 제한합니다.",
  "persistence/no-unrelated-domain-policy":
    "프로젝트가 선언한 저장소 책임을 벗어난 업무 정책 결정을 검사하고, 데이터 불변식·보안·원자성을 위한 정책 배치는 허용합니다.",
  "persistence/explicit-upsert-semantics":
    "데이터 존재 여부에 따라 어떤 필드를 생성·유지·덮어쓰는지 명확히 합니다.",
  "persistence/preserve-audit-metadata":
    "생성·수정·감사 메타데이터의 불변·갱신·정정 계약을 정의하고, 일반 변경 경로가 이를 위반하지 않도록 합니다.",
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
  preset: [],
  rules: selections,
});
const plugins = { "section-rules": { namespace: "aquarius", lintRules: rules } };

describe("section 13: persistence", () => {
  test("preserves every canonical ID and full criterion independently", () => {
    expect(rules.map((rule) => rule.id)).toEqual(Object.keys(expectedDescriptions));
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(15);
    for (const rule of rules) {
      expect(rule.description).toBe(expectedDescriptions[rule.id]);
      expect(allRulesPreset[`aquarius/${rule.id}`]).toBe("warn");
    }
  });

  test("prepares all definitions through the existing strict engine API", async () => {
    const selections = Object.fromEntries(
      rules.map(({ id }) => [`aquarius/${id}`, allRulesPreset[`aquarius/${id}`]]),
    );
    const result = await prepareRules(config(selections), plugins);
    expect(result.errors).toEqual([]);
    expect(result.rules.map((rule) => rule.id)).toEqual(rules.map((rule) => `aquarius/${rule.id}`));
    for (const rule of result.rules) expect(rule.severity).toBe("warn");
  });

  test("registration leaves rules inactive and selected rules can be disabled", async () => {
    expect(await prepareRules(config({}), plugins)).toEqual({ rules: [], errors: [] });
    const selections = Object.fromEntries(
      rules.map(({ id }) => [`aquarius/${id}`, allRulesPreset[`aquarius/${id}`]]),
    );
    const active = await prepareRules(config(selections), plugins);
    expect(active.errors).toEqual([]);
    expect(active.rules.map(({ id }) => id)).toEqual(rules.map(({ id }) => `aquarius/${id}`));
    const disabled = Object.fromEntries(rules.map(({ id }) => [`aquarius/${id}`, "off" as const]));
    const result = await prepareRules(config(disabled), plugins);
    expect(result).toEqual({ rules: [], errors: [] });
  });

  test("keeps each rule independently selectable when other rules are disabled", async () => {
    for (const selected of rules) {
      const selections = Object.fromEntries(
        rules.map(({ id }) => [
          `aquarius/${id}`,
          id === selected.id ? ("error" as const) : ("off" as const),
        ]),
      );
      const result = await prepareRules(config(selections), plugins);
      expect(result.errors).toEqual([]);
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0]?.id).toBe(`aquarius/${selected.id}`);
      expect(result.rules[0]?.severity).toBe("error");
    }
  });

  test("rejects unsupported options without breaking other selected rules", async () => {
    const result = await prepareRules(
      config({
        [`aquarius/${rules[0]!.id}`]: ["warn", { inventedThreshold: 1 }],
        [`aquarius/${rules[1]!.id}`]: "warn",
      }),
      plugins,
    );
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
      expect(prompt.criteria).toContain("reach a conclusion from the inspected scope");
      expect(prompt.criteria).toContain("Pass requires sufficient inspection");
      expect(prompt.evidenceRequirements.length).toBeGreaterThanOrEqual(3);
      expect(prompt.exceptions?.length).toBeGreaterThan(0);
      expect(prompt.procedure?.join(" ")).toContain("Preserve independent rule activation");
      expect(prompt.examples?.map((example) => example.expected)).toEqual([
        "violation",
        "pass",
        "not_applicable",
      ]);
      expect(
        prompt.examples?.every((example) => example.scenario.trim() && example.reason.trim()),
      ).toBe(true);
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
      expect(rule).not.toHaveProperty("defaultOptions");
    }
  });
});

const semanticDetails: Record<string, string[]> = {
  "persistence/explicit-transaction-boundaries": ["보상", "원자성", "부분 상태"],
  "persistence/propagate-transaction-context": ["같은 client", "pool.query", "AsyncLocalStorage"],
  "persistence/atomic-state-event-publication": ["발행 의도", "exactly-once", "outbox"],
  "persistence/enforce-required-uniqueness": ["tenant", "null", "collation", "soft-delete"],
  "persistence/parameterize-data-queries": ["식별자", "allowlist", "driver parameter"],
  "persistence/no-unrelated-domain-policy": ["프로젝트", "stored procedure", "DB 제약"],
};

test.each(Object.entries(semanticDetails))(
  "preserves reviewed semantic boundaries for %s",
  async (id, details) => {
    const rule = rules.find((candidate) => candidate.id === id)!;
    const prompt = JSON.stringify(await rule.buildPrompt({ options: {} }));
    for (const detail of details) expect(prompt).toContain(detail);
  },
);
