import { describe, expect, test } from "vitest";
import { allRulesPreset } from "../src/presets";
import { prepareRules } from "../../core/src/rules/prepare";
import type { LoadedConfig } from "../../core/src/config/types";
import { distributedRules } from "../src/lint/section-15-distributed";

const rules = distributedRules;
const expectedDescriptions: Record<string, string> = {
  "distributed/explicit-remote-timeout":
    "외부 호출의 연결·응답·본문·유휴·전체 수행 중 필요한 시간 한도를 확인하고, 시간 초과 후 남은 작업의 처리도 정의합니다.",
  "distributed/propagate-deadline-budget":
    "상위 요청의 남은 처리 시간을 고려해 하위 호출의 대기 시간을 정합니다.",
  "distributed/retry-safe-operations":
    "실패 후 결과가 불확실한 경우를 포함해 반복 실행의 업무 효과를 평가하고, 멱등성·중복 방지·조회 후 조정 계약이 있는 범위에서 재시도합니다.",
  "distributed/bounded-retry-budget":
    "초기 시도를 포함한 최대 시도와 전체 시간의 유효 한도를 확인하고, 상위 deadline·라이브러리 기본값·대기 시간을 함께 계산합니다.",
  "distributed/spread-retry-timing":
    "다수 호출자의 동시 재시도 위험이 있는 경로에서 분산된 대기 전략을 사용하고, 서버의 최소 재시도 시각과 전체 예산을 존중합니다.",
  "distributed/no-stacked-retries":
    "중첩 재시도의 실제 시도 상한·시간·오류 분류를 합성하고, 합의된 예산을 넘는 증폭 또는 책임 중복을 보고합니다.",
  "distributed/stable-idempotency-key":
    "동일한 논리 작업의 재시도에는 같은 중복 방지 키를 사용하도록 합니다.",
  "distributed/validate-idempotency-key-reuse":
    "같은 키로 서로 다른 내용을 요청했을 때 조용히 잘못된 결과를 반환하지 않도록 합니다.",
  "distributed/deduplicate-replayed-requests":
    "재전달 시 중복 효과와 처리 누락을 함께 막도록 중복 식별·기록·부작용의 원자성 또는 복구 계약을 확인합니다.",
  "distributed/explicit-circuit-breaker-policy":
    "장애 차단기를 채택한 경로에서 실패 분류·차단·시험 호출 동시성·복구·관측 정책이 선언된 요구와 일치하는지 검사합니다.",
  "distributed/isolate-failure-domains":
    "무관한 기능의 가용성 요구를 함께 무너뜨리는 공유 자원 경로를 찾고, 해당 장애 범위에 필요한 격리·상한 정책을 평가합니다.",
  "distributed/no-chatty-remote-protocol":
    "원격 왕복의 지연·비용과 순서·권한·부분 실패 계약을 확인한 뒤, 같은 의미를 유지하는 호출 통합을 제안합니다.",
  "distributed/explicit-degraded-mode":
    "외부 장애 시 제공할 축소 기능과 제공하지 않을 기능을 명확히 합니다.",
  "distributed/no-instance-local-global-assumption":
    "시스템 전체에서 보장해야 하는 상태·잠금·중복 방지를 인스턴스 메모리만으로 구현했는지 실제 배포 범위와 비교합니다.",
  "distributed/explicit-partition-behavior":
    "통신 단절에 노출된 핵심 경로에서 허용된 읽기·쓰기·대기·열화 계약을 확인하고, 증거 없는 일관성 선택을 강요하지 않습니다.",
  "distributed/reconcile-uncertain-outcomes":
    "외부 변경의 결과가 API 계약상 불확실할 때 미실행이나 확정 실패로 단정하지 않고, 조회·재조정·보류·수동 확인 경로를 유지합니다. 작업 식별자의 필요성과 오류 분류는 제공자 계약에 따릅니다. 신규 검토 후보이며 자동 수정은 제안하지 않습니다.",
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

describe("section 15: distributed", () => {
  test("preserves every canonical ID and full criterion independently", () => {
    expect(rules.map((rule) => rule.id)).toEqual(Object.keys(expectedDescriptions));
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(16);
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
  "distributed/explicit-remote-timeout": ["본문", "남은 작업", "Promise.race", "subscription"],
  "distributed/retry-safe-operations": ["불확실", "retention", "새 idempotency key"],
  "distributed/bounded-retry-budget": ["초기 시도", "상위 deadline", "maxAttempts"],
  "distributed/no-stacked-retries": ["SDK retry", "raw multiply", "합성"],
  "distributed/deduplicate-replayed-requests": ["먼저 쓰면", "나중에 쓰면", "crash", "retention"],
  "distributed/no-instance-local-global-assumption": ["worker", "approximate", "topology"],
  "distributed/reconcile-uncertain-outcomes": [
    "모든 timeout이나 5xx",
    "SDK",
    "수동 확인",
    "보고 전용",
    "자동 수정",
  ],
};

test.each(Object.entries(semanticDetails))(
  "preserves reviewed semantic boundaries for %s",
  async (id, details) => {
    const rule = rules.find((candidate) => candidate.id === id)!;
    const prompt = JSON.stringify(await rule.buildPrompt({ options: {} }));
    for (const detail of details) expect(prompt).toContain(detail);
  },
);
