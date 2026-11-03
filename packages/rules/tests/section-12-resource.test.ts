import { describe, expect, test } from "vitest";
import { prepareRules } from "../../core/src/rules/prepare";
import type { LoadedConfig } from "../../core/src/config/types";
import { resourceRules } from "../src/lint/section-12-resource";

const rules = resourceRules;
const expectedDescriptions: Record<string, string> = {
  "resource/release-owned-resources": "소유한 자원의 획득부터 해제 또는 검증된 소유권 이전까지 추적하고, API·런타임의 자동 정리 계약을 인정합니다.",
  "resource/do-not-close-borrowed-resources": "외부에서 빌려 받은 자원을 계약 없이 종료하지 않도록 합니다.",
  "resource/cleanup-on-all-exit-paths": "정상 반환·예외·지원되는 협력적 취소 경로에서 정리를 보장하고, 강제 종료 후 잔여 자원은 별도 복구 정책으로 다룹니다.",
  "resource/pair-register-unregister": "구독·리스너·타이머의 소유 수명에 맞는 실제 해제 또는 자동 종료를 확인하고, 대상·콜백 identity·등록 횟수·API별 해제 조건을 맞춥니다. unref나 결과 무시는 해제로 간주하지 않습니다.",
  "resource/bounded-pools": "자원 풀의 활성 자원에 유효 상한을 두고 포화 시 대기·거절·시간 초과 정책을 확인합니다. 대기열 한도와 인스턴스별·시스템 전체 자원 예산도 구분합니다.",
  "resource/explicit-idle-and-lease-timeouts": "유휴·대여·획득 대기·작업 실행의 시간 한도와 회수 조건을 구분하고, 요구되는 회수 경로와 회수 후 이전 소유자의 사용을 막는 계약을 확인합니다.",
  "resource/no-acquisition-at-import-time": "재사용·테스트·선택 로딩 계약을 깨는 import 시 자원 획득을 찾고, 명시된 애플리케이션 초기화 진입점은 예외로 인정합니다.",
  "resource/idempotent-disposal": "정리 경로가 중복 실행될 수 있다면 멱등성 또는 정확히 한 번 실행을 보장하고, 진행 중·성공·실패 상태를 구분하여 정리 실패를 완료로 숨기지 않습니다. 재시도는 자원 API 계약에 따릅니다.",
  "resource/no-use-after-disposal": "종료되거나 반환된 자원을 API가 허용하지 않는 방식으로 다시 사용하지 않도록 하며, alias와 미완료 작업도 수명 범위에 포함합니다.",
  "resource/exception-safe-acquisition": "여러 자원 중 일부 획득에 실패했을 때 앞서 얻은 자원을 남기지 않도록 합니다.",
  "resource/no-unrelated-io-while-holding": "자원 점유 목적과 무관한 고지연 I/O가 희소 자원 예산을 침해하는지 검사하되, 원자성에 필요한 작업은 보존합니다.",
  "resource/stream-large-payloads": "입력 상한과 메모리 예산을 근거로 전체 적재 위험을 평가하고, 계약을 보존할 수 있는 경우 스트리밍을 제안합니다.",
  "resource/respect-backpressure": "실제 producer–consumer API의 역압력 신호가 생산 중단·재개에 반영되는지 검사하고, 버퍼 임계값을 절대 메모리 한도로 오인하지 않습니다.",
  "resource/clean-temporary-artifacts": "임시 산출물의 소유권·보존 목적·만료와 성공·실패·재시작 후의 실제 제거·회수 경로를 확인하고, 필요한 재개·조사 자료는 합의된 기간 동안 보존합니다.",
  "resource/stop-on-consumer-exit": "소비자 종료 시 전용 producer·stream을 계약대로 정리하고, 공유·재사용 producer는 남은 소유자와 iterator 종료 정책을 존중합니다."
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

describe("section 12: resource", () => {
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
  "resource/pair-register-unregister": [
    "unref",
    "capture",
    "EventEmitter",
    "EventTarget"
  ],
  "resource/bounded-pools": [
    "활성",
    "대기열",
    "인스턴스"
  ],
  "resource/idempotent-disposal": [
    "closing",
    "failed",
    "재시도",
    "실패"
  ],
  "resource/respect-backpressure": [
    "false/drain",
    "writer.ready",
    "절대 메모리",
    "write"
  ],
  "resource/clean-temporary-artifacts": [
    "재시작",
    "회수",
    "실제"
  ],
  "resource/stop-on-consumer-exit": [
    "destroyOnReturn:false",
    "preventCancel:true",
    "다음 소유자"
  ]
};

test.each(Object.entries(semanticDetails))("preserves reviewed semantic boundaries for %s", async (id, details) => {
  const rule = rules.find((candidate) => candidate.id === id)!;
  const prompt = JSON.stringify(await rule.buildPrompt({ options: {} }));
  for (const detail of details) expect(prompt).toContain(detail);
});

test("EventEmitter and EventTarget have different duplicate registration semantics", async () => {
  const { EventEmitter } = await import("node:events");
  let calls = 0;
  const callback = () => { calls += 1; };
  const emitter = new EventEmitter();
  emitter.on("data", callback);
  emitter.on("data", callback);
  emitter.off("data", callback);
  emitter.emit("data");
  expect(calls).toBe(1);
  emitter.off("data", callback);

  calls = 0;
  const target = new EventTarget();
  target.addEventListener("data", callback);
  target.addEventListener("data", callback);
  target.removeEventListener("data", callback);
  target.dispatchEvent(new Event("data"));
  expect(calls).toBe(0);
});

test("awaiting Node Writable.write's boolean is not waiting for completion or drain", async () => {
  const { Writable } = await import("node:stream");
  let finishWrite!: (error?: Error | null) => void;
  let completed = false;
  const stream = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) { finishWrite = callback; },
  });
  try {
    const accepted = await stream.write("payload", () => { completed = true; });
    expect(accepted).toBe(false);
    expect(completed).toBe(false);
    finishWrite();
    expect(completed).toBe(true);
  } finally {
    stream.destroy();
  }
});
