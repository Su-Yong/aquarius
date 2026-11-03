import { describe, expect, test } from "vitest";
import { prepareRules } from "../../core/src/rules/prepare";
import type { LoadedConfig } from "../../core/src/config/types";
import { asyncRules } from "../src/lint/section-11-async";

const rules = asyncRules;
const expectedDescriptions: Record<string, string> = {
  "async/await-owned-work": "완료를 책임지는 비동기 작업이 await·반환·완료와 오류 처리가 보장된 수집 또는 검증된 감독자로의 이전 없이 책임 범위를 벗어나지 않도록 하며, 오류 처리·정리 범위의 수명도 보존합니다.",
  "async/explicit-detached-work-policy": "분리 실행 작업의 실패 처리·수명·종료·완료 추적 책임을 확인하고, 런타임이 지원하는 감독·수명 확장 계약을 인정합니다.",
  "async/bounded-concurrency": "입력 규모와 자원 예산에 비해 과도한 동시 실행을 막고, 상위 제한·고정 크기·라이브러리 제한을 함께 고려합니다.",
  "async/parallelize-independent-work": "실제 병렬 실행이 작업의 선후 관계·공유 상태·부작용 순서·자원 제약을 위반하는지 검사하며, 독립 작업의 직렬 실행만으로 위반을 만들지 않습니다.",
  "async/no-blocking-on-async-path": "지연 민감 경로의 실제 실행 컨텍스트에서 긴 동기 작업이 다른 작업의 진행 예산을 침해하는지 검사합니다.",
  "async/propagate-cancellation": "하위 작업의 소유권과 취소 지원을 확인해 취소를 전달하고, 공유·비가역·정리 작업의 별도 종료 정책은 명시합니다.",
  "async/cancel-obsolete-work": "더 이상 소유자가 필요로 하지 않는 작업은 지원되는 취소·중단 정책을 적용하고, 취소 불가 또는 공유 작업은 결과 반영과 수명을 따로 관리합니다.",
  "async/no-stale-result-overwrite": "늦게 끝난 이전 작업이 더 최신 결과를 덮어쓰지 않도록 합니다.",
  "async/synchronize-read-modify-write": "공유 상태의 읽기–계산–쓰기 사이에 실제로 개입 가능한 작업을 확인하고, 해당 범위에 맞는 원자성·직렬화·충돌 처리를 사용합니다.",
  "async/minimize-critical-section-awaits": "잠금이 보호하는 불변식에 필요하지 않은 대기만 식별하고, 잠금 범위를 줄일 때 원자성과 순서 계약을 보존합니다.",
  "async/consistent-lock-order": "동시에 실행될 수 있는 경로가 동일 잠금을 획득하는 관계에서 교착 가능성을 검사하고, 일관된 순서 또는 검증된 회피·복구 계약을 확인합니다.",
  "async/no-check-then-act-race": "확인과 실행 사이의 조건 변경 가능성을 입증하고, 실행 시점의 원자적 조건 검사·제약·충돌 처리를 평가합니다.",
  "async/explicit-fanout-failure-policy": "팬아웃 실패 시 반환 시점, 남은 작업의 취소·완료·오류 관측·자원 정리 책임을 계약에 맞게 확인합니다.",
  "async/cooperative-task-shutdown": "종료 대상 범위의 새 업무 수락을 멈추고, 그 범위의 소유 작업을 합의된 drain·취소·인계 방식으로 정리하며 종료 예산 초과를 처리합니다. 필요한 정리 하위 작업과 다른 소유자의 작업은 구분합니다.",
  "async/bounded-pending-work": "실행 대기 중인 작업이 무제한 누적되지 않도록 대기열 한도와 초과 정책을 둡니다."
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

describe("section 11: async", () => {
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
  "async/await-owned-work": [
    "join",
    "try/catch/finally/using",
    "Node의 boolean·drain"
  ],
  "async/parallelize-independent-work": [
    "실제 병렬",
    "직렬",
    "외부 효과"
  ],
  "async/synchronize-read-modify-write": [
    "단일",
    "동기 n++",
    "shared memory",
    "Atomics"
  ],
  "async/explicit-fanout-failure-policy": [
    "Promise.all",
    "나머지를 취소",
    "allSettled",
    "감독자"
  ],
  "async/cooperative-task-shutdown": [
    "소유",
    "정리 하위 작업",
    "waitUntil"
  ],
  "async/bounded-pending-work": [
    "동시 실행은 5개",
    "대기열",
    "backpressure"
  ]
};

test.each(Object.entries(semanticDetails))("preserves reviewed semantic boundaries for %s", async (id, details) => {
  const rule = rules.find((candidate) => candidate.id === id)!;
  const prompt = JSON.stringify(await rule.buildPrompt({ options: {} }));
  for (const detail of details) expect(prompt).toContain(detail);
});

test("Promise.all rejection does not complete or cancel its remaining child", async () => {
  let release!: () => void;
  let childCompleted = false;
  const child = new Promise<void>((resolve) => { release = resolve; }).then(() => {
    childCompleted = true;
  });
  const failure = new Error("first child failed");
  await expect(Promise.all([Promise.reject(failure), child])).rejects.toBe(failure);
  expect(childCompleted).toBe(false);
  release();
  await child;
  expect(childCompleted).toBe(true);
});

test("returning a Promise alone does not extend a finally-owned resource lifetime", async () => {
  const order: string[] = [];
  let release!: () => void;
  const work = new Promise<void>((resolve) => { release = resolve; }).then(() => {
    order.push("work completed");
  });
  const owner = async () => {
    try { return work; } finally { order.push("resource released"); }
  };
  const returned = owner();
  expect(order).toEqual(["resource released"]);
  release();
  await returned;
  expect(order).toEqual(["resource released", "work completed"]);
});

test("a generation guard rejects an older result even if cancellation cannot stop it", () => {
  let generation = 0;
  let value = "initial";
  const start = () => {
    const current = ++generation;
    return (result: string) => {
      if (current === generation) value = result;
    };
  };
  const completeA = start();
  const completeB = start();
  completeB("new");
  completeA("old");
  expect(value).toBe("new");
});
