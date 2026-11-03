import { describe, expect, test } from "vitest";
import type { LintInstructions, RulePlugin } from "@aquarius/core";
import { prepareRules } from "@aquarius/core/internal";
import type { LoadedConfig, RuleSelection } from "@aquarius/core/internal";
import { eventRules } from "../src/lint/section-20-event";

// Specification and preparation tests do not claim live-model detection quality.
const expected = [
  {
    "id": "event/distinguish-events-and-commands",
    "description": "메시지가 사실 통지인지 수행 요청인지 소비·실패·응답 계약으로 구분하고, 이름이나 전송 방식만으로 판정하지 않습니다."
  },
  {
    "id": "event/explicit-schema-version",
    "description": "이벤트 payload의 호환성·형식 식별 전략을 확인하고, envelope 표준 버전과 업무 데이터 스키마 버전을 구분합니다."
  },
  {
    "id": "event/stable-event-identity",
    "description": "동일 사건의 재전달을 안정적으로 식별하면서 서로 다른 사건을 구분하도록, 발행 범위와 식별자 재사용 계약을 확인합니다."
  },
  {
    "id": "event/carry-business-correlation",
    "description": "업무 흐름 연결에 필요한 식별 관계를 최소 정보로 유지하고, 이벤트 identity·업무 correlation·추적 context의 목적과 수명을 구분합니다."
  },
  {
    "id": "event/handle-delivery-semantics",
    "description": "중복·유실·재전달 가능성에 대한 메시징 계약을 소비자 구현에 반영합니다."
  },
  {
    "id": "event/acknowledge-after-durable-work",
    "description": "요구되는 처리 결과 또는 검증된 내구성 인계가 확정된 뒤 수신 확인하고, publisher confirm·consumer ack·offset commit의 보장 범위를 구분합니다."
  },
  {
    "id": "event/explicit-ordering-requirements",
    "description": "순서 보장이 필요한 범위와 순서가 달라도 되는 범위를 구분합니다."
  },
  {
    "id": "event/separate-occurrence-processing-time",
    "description": "사건 시각·수신 시각·처리 시각의 의미를 필요한 용도에서 구분하고, 시계 오차나 지연을 무시해 순서·신선도를 단정하지 않습니다."
  },
  {
    "id": "event/bounded-consumer-retries",
    "description": "메시지의 큐 이동·재발행·재전달을 포함한 처리 생애에서 시도·시간·부하 예산과 격리·보류 정책을 확인하여, 카운터 초기화나 재처리 순환이 다른 작업의 진행을 막지 않도록 합니다."
  },
  {
    "id": "event/explicit-dead-letter-policy",
    "description": "최종 실패를 보존·재처리해야 하는 메시지에 대해 실제 격리 전달·보존 기한·담당자·조사·수정·안전한 재처리 경로를 확인하고, 전달 실패·만료·순환과 계약상 허용된 폐기를 구분합니다."
  },
  {
    "id": "event/replay-safe-consumers",
    "description": "운영 재전달과 의도된 과거 재생을 구분해 projection 재구성은 허용하고, 외부 부작용의 중복 실행은 replay 목적에 맞게 제어합니다."
  },
  {
    "id": "event/no-hidden-synchronous-dependency",
    "description": "비동기 전달 계약을 가진 이벤트 경계가 소비자의 즉시 실행·완료를 암묵적으로 요구하지 않도록 검사합니다."
  },
  {
    "id": "event/persist-long-running-workflow-state",
    "description": "재시작 후 이어져야 하는 업무의 진행·결과·중복 방지 정보를 내구화하거나 검증된 재구성 방식으로 복원합니다."
  },
  {
    "id": "event/explicit-compensation-contract",
    "description": "다단계 업무의 되돌릴 수 있는 효과·비가역 지점·보상·수동 조정과 그 실패·재시도 계약을 명시합니다."
  },
  {
    "id": "event/handle-late-out-of-order-events",
    "description": "늦거나 순서가 바뀐 이벤트를 업무의 버전·순서·합성 계약에 맞게 처리하고, 필요한 과거 사실을 단순 최신값 비교로 버리지 않습니다."
  },
  {
    "id": "event/preserve-durable-workflow-replay-compatibility",
    "description": "결정론적 기록 재생을 쓰는 워크플로의 코드 변경이 호환 유지 대상 기록 및 런타임의 명령 일치·버전 라우팅·패치 계약과 맞는지 확인합니다. 해당 런타임과 기록 근거가 없는 경우에는 적용 대상 아님 또는 판단 불가로 구분합니다. 신규 검토 후보이며 자동 수정은 제안하지 않습니다."
  }
];
const rules = eventRules;
const specifier = "aquarius-section-20-fixture";
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

describe("section 20: event", () => {
  test("preserves every canonical ID and description without enabling rules", async () => {
    expect(rules.map(({ id, description }) => ({ id, description }))).toEqual(expected);
    expect(new Set(rules.map(({ id }) => id)).size).toBe(16);
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
    "explicit-schema-version",
    "exceptions",
    "CloudEvents specversion"
  ],
  [
    "stable-event-identity",
    "exceptions",
    "source+id"
  ],
  [
    "acknowledge-after-durable-work",
    "exceptions",
    "인계"
  ],
  [
    "bounded-consumer-retries",
    "examples",
    "0으로 초기화"
  ],
  [
    "replay-safe-consumers",
    "exceptions",
    "historical replay"
  ],
  [
    "no-hidden-synchronous-dependency",
    "exceptions",
    "EventEmitter"
  ],
  [
    "preserve-durable-workflow-replay-compatibility",
    "criteria",
    "Do not propose or apply automatic fixes"
  ],
  [
    "preserve-durable-workflow-replay-compatibility",
    "criteria",
    "새 실행 테스트"
  ]
] as const)("preserves the boundary for %s", async (id, field, fragment) => {
    const rule = rules.find((rule) => rule.id === `event/${id}`)!;
    const instructions = await rule.buildPrompt({ options: {} });
    expect(JSON.stringify(instructions[field as keyof LintInstructions])).toContain(fragment);
  });
});
