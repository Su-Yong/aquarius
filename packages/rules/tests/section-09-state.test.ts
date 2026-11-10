import { describe, expect, test } from "vitest";
import { allRulesPreset } from "../src/presets";
import { prepareRules } from "../../core/src/rules/prepare";
import type { LoadedConfig } from "../../core/src/config/types";
import { stateRules } from "../src/lint/section-09-state";

const rules = stateRules;
const expectedDescriptions: Record<string, string> = {
  "state/single-owner-for-shared-state":
    "공유 상태의 변경 권한과 조정 책임이 명확하고 충돌 처리 계약이 지켜지는지 검사합니다. 여러 작성자가 있는 설계도 합의·버전·병합 규칙이 명확하면 허용하며, 단일 작성자나 단일 객체를 일괄 강제하지 않습니다.",
  "state/derive-instead-of-duplicate":
    "파생값을 따로 저장할 때 원본·계산 규칙·갱신·무효화 계약이 없거나 실제 계산·갱신·무효화가 그 계약을 어겨 값이 어긋나는 경로가 있는지 검사합니다. 성능 목적의 캐시·구체화 뷰, 과거 시점의 스냅샷, 독립적인 사용자 초안은 허용 조건을 구분하고 무조건 재계산으로 바꾸지 않습니다.",
  "state/no-competing-sources-of-truth":
    "같은 업무 사실과 같은 범위·시점에 대해 둘 이상의 표현이 권위와 충돌 해결 계약 없이 최종 기준으로 사용되는지 검사합니다. 읽기 전용 사본도 현재의 권위로 오인되면 대상이 될 수 있습니다. 명시된 원본·신선도·충돌 처리 계약을 따르는 읽기 모델·캐시·복제본은 개수만으로 위반이 아닙니다.",
  "state/no-cross-request-leak":
    "요청·사용자·테넌트별로 격리되어야 하는 상태가 다른 범위의 처리나 응답에 노출되는 경로를 검사합니다. 공유 캐시·컨텍스트 관리도 실제 격리·공개 범위 계약에 따라 평가합니다.",
  "state/localize-mutable-state":
    "변경 가능한 상태의 접근·변경 권한이 필요한 소유 범위를 넘어 불변조건을 우회하는지 검토하며, 의도된 공유 소유·동기화 경계는 인정합니다.",
  "state/no-shared-mutable-defaults":
    "인수가 생략되거나 undefined일 때 적용되는 기본값이 동일한 변경 가능 참조를 재사용해 호출 간 변경을 누출하는지 확인합니다. JavaScript의 기본값 []·{}는 평가할 때 새 바깥 객체를 만들지만, 그 안에 외부 객체 참조가 있으면 중첩 상태는 공유될 수 있습니다. 문법만으로 위반을 만들지 않습니다.",
  "state/copy-at-ownership-boundaries":
    "소유권·변경 권한 경계에서 공유 참조가 내부 불변조건의 우회 변경을 허용하는지 검사합니다. 복사·불변 데이터·제한된 API·소유권 이전 중 계약에 맞는 방식을 선택하며 복사를 일괄 강제하지 않습니다. 얕은 복사·얕은 freeze와 중첩 참조, 객체 정체성·프로토타입·자원 수명을 고려합니다.",
  "state/atomic-related-updates":
    "함께 관찰되어야 하는 상태 변경이 await·콜백·getter·이벤트·공유 메모리 등의 관찰 경계에서 불완전하게 노출되는지 검사하고, 선언된 단계적 상태는 구분합니다.",
  "state/explicit-reset-semantics":
    "초기화·로그아웃·재사용 시 유지·폐기해야 하는 상태와 진행 중 작업의 결과 반영 정책을 확인하고, 실제 전이가 이를 지키는지 검사합니다.",
  "state/no-stale-snapshot-decisions":
    "현재성·버전 일치를 요구하는 결정이 그 조건을 잃은 과거 읽기를 확정 근거로 사용하는지 검사하며, 의도된 역사적 스냅샷과 검증된 낙관적 결정을 구분합니다.",
  "state/deterministic-transitions":
    "결정론·재현성이 요구된 상태 전이가 선언되지 않은 시간·난수·환경·공유 상태에 의존하는지 검사하고, 명시된 입력이나 런타임 제어를 인정합니다.",
  "state/separate-transient-persistent-state":
    "임시 진행·세션 상태와 재시작 후 보존할 업무 상태의 수명·복원 계약을 구분하고, 저장·유실·오복원 경로가 이를 위반하는지 검사합니다.",
  "state/safe-mutation-during-iteration":
    "사용 중인 컬렉션·순회 API의 실제 변경 의미를 기준으로 필요한 방문·순서·종료 계약이 깨지는지 검사하며, 안전한 삭제·스냅샷 순회·의도된 작업 확장은 허용합니다.",
  "state/no-hidden-global-reconfiguration":
    "개별 기능의 전역 설정·prototype·라이브러리 동작 변경이 다른 소유 범위의 약속을 의도치 않게 바꾸는지 검사하고, 승인된 초기화·격리·복원 계약을 인정합니다.",
  "state/validate-restored-state":
    "복원한 상태가 사용될 버전·형식·업무 불변조건·신뢰 수준에 맞는지 검증하거나 검증된 마이그레이션을 거치게 하고, 같은 보장의 중복 검증은 강제하지 않습니다.",
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

describe("section 9: state", () => {
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
  "state/single-owner-for-shared-state": ["여러 작성자", "충돌", "worker"],
  "state/derive-instead-of-duplicate": ["계산·갱신·무효화", "스냅샷", "초안"],
  "state/no-competing-sources-of-truth": ["같은 업무 사실", "읽기 전용 사본", "권위 충돌"],
  "state/no-shared-mutable-defaults": ["undefined", "새 바깥 객체", "중첩", "Python"],
  "state/copy-at-ownership-boundaries": ["Map", "setter", "live view", "prototype", "소유권 이전"],
  "state/atomic-related-updates": ["setter", "관찰", "재진입"],
  "state/validate-restored-state": ["migration", "JSON 구문 분석", "타입 단언"],
};

test.each(Object.entries(semanticDetails))(
  "preserves reviewed semantic boundaries for %s",
  async (id, details) => {
    const rule = rules.find((candidate) => candidate.id === id)!;
    const prompt = JSON.stringify(await rule.buildPrompt({ options: {} }));
    for (const detail of details) expect(prompt).toContain(detail);
  },
);

test("JavaScript fresh defaults differ from defaults with shared nested references", () => {
  const fresh = (items: number[] = []) => {
    items.push(1);
    return items;
  };
  expect(fresh()).toEqual([1]);
  expect(fresh(undefined)).toEqual([1]);
  expect(fresh()).not.toBe(fresh());

  const shared: number[] = [];
  const nested = (value = { items: shared }) => {
    value.items.push(1);
    return value;
  };
  const first = nested();
  const second = nested();
  expect(first).not.toBe(second);
  expect(first.items).toBe(second.items);
  expect(first.items).toEqual([1, 1]);
});

test("shallow freeze does not revoke Map or accessor mutation authority", () => {
  const frozenMap = Object.freeze(new Map([["balance", 1]]));
  frozenMap.set("balance", 2);
  expect(frozenMap.get("balance")).toBe(2);
  let balance = 1;
  const view = Object.freeze({
    get balance() {
      return balance;
    },
    set balance(value: number) {
      balance = value;
    },
  });
  expect(Reflect.set(view, "balance", 3)).toBe(true);
  expect(balance).toBe(3);
});

test("iteration mutation follows each collection API rather than a blanket prohibition", () => {
  const array = [1, 2, 3];
  const seen: number[] = [];
  array.forEach((value, index) => {
    seen.push(value);
    if (index === 0) array.splice(0, 1);
  });
  expect(seen).toEqual([1, 3]);
  const map = new Map([
    [1, true],
    [2, true],
    [3, true],
  ]);
  const visited: number[] = [];
  for (const [key] of map) {
    visited.push(key);
    map.delete(key);
  }
  expect(visited).toEqual([1, 2, 3]);
  expect(map.size).toBe(0);
});
