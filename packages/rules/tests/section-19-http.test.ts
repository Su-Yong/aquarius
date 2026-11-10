import { describe, expect, test } from "vitest";
import { allRulesPreset } from "../src/presets";
import type { LintInstructions, RulePlugin } from "@aquarius/core";
import { prepareRules } from "@aquarius/core/internal";
import type { LoadedConfig, RuleSettings } from "@aquarius/core/internal";
import { httpRules } from "../src/lint/section-19-http";

// Specification and preparation tests do not claim live-model detection quality.
const expected = [
  {
    id: "http/align-method-and-effects",
    description:
      "요청 메서드가 표준과 API 계약에서 선언한 안전성·의도된 효과와 구현이 일치하도록 하며, 조회 중 허용된 기록 같은 보조 효과는 구분합니다.",
  },
  {
    id: "http/accurate-status-semantics",
    description:
      "HTTP 상태와 헤더가 해당 프로토콜·API 계약의 완료·입력·권한·장애 의미를 정확히 표현하도록 하며, 전송 결과와 업무 결과가 분리된 프로토콜을 구분합니다.",
  },
  {
    id: "http/consistent-error-envelope",
    description: "오류 응답의 코드·설명·추적 정보 구조를 API 계약에 맞게 통일합니다.",
  },
  {
    id: "http/validate-content-type",
    description:
      "요청·응답의 실제 매체 형식과 선언된 Content-Type·협상 계약이 맞는지 검사하고, raw body·multipart·stream 등 프로토콜별 처리를 인정합니다.",
  },
  {
    id: "http/bounded-request-payloads",
    description:
      "요청 수신·압축 해제·파싱·검증 단계의 크기·깊이·개수·시간 제한이 실제 경로에서 작동하는지 확인합니다. 상위 경계의 제한은 우회 불가능성과 적용 범위가 확인된 경우 인정하며, 제한 미정·확인 불가는 공백으로 보고합니다.",
  },
  {
    id: "http/explicit-pagination-contract",
    description: "페이지 크기·커서·종료 조건·정렬 기준을 소비자가 이해할 수 있게 정의합니다.",
  },
  {
    id: "http/preserve-idempotency-contract",
    description:
      "동일한 논리 요청의 반복이 메서드와 API가 약속한 의도된 효과를 보존하도록 하며, 응답 차이와 요청별 보조 기록은 별도로 판단합니다.",
  },
  {
    id: "http/conditional-update-contract",
    description:
      "오래된 데이터를 기준으로 한 수정 요청을 감지하거나 허용하는 정책을 명확히 합니다.",
  },
  {
    id: "http/explicit-timeout-cancellation-mapping",
    description:
      "시간 초과·연결 종료·취소가 응답과 내부 작업의 계속·중단·정리·결과 확인에 미치는 영향을 API의 소유권 및 내구성 계약에 맞게 정의합니다.",
  },
  {
    id: "http/verify-webhook-authenticity",
    description: "웹훅 요청이 신뢰하는 발신자로부터 왔는지 검증한 뒤 처리합니다.",
  },
  {
    id: "http/reject-replayed-webhooks",
    description:
      "공급자의 정상 재전송은 복구 가능하게 처리하되, 위조·유효기간 밖의 재사용과 이미 완료된 논리 이벤트의 중복 부작용을 계약에 맞게 막습니다.",
  },
  {
    id: "http/validate-redirect-targets",
    description:
      "외부 입력이 정한 리다이렉트가 해당 흐름의 목적지·스킴·자격증명 전달 정책을 지키도록 하며, 의도된 외부 이동과 인증 경계를 구분합니다.",
  },
  {
    id: "http/explicit-streaming-failure-behavior",
    description: "응답 전송이 시작된 뒤 실패했을 때 종료·오류 전달 방식을 명확히 합니다.",
  },
  {
    id: "http/validate-external-responses",
    description:
      "외부 응답의 상태·형식·사용할 필드가 소비자 계약을 실제 실행 시 만족하는지 확인합니다. 검증된 SDK·공통 adapter의 보장은 인정하되 타입 선언·단언만을 검증으로 간주하지 않고 허용된 확장 필드는 보존합니다.",
  },
  {
    id: "http/explicit-api-version-evolution",
    description:
      "HTTP API의 필드·동작·오류·직렬화 변경을 소비자 호환 정책에 맞게 관리합니다. contract/consumer-compatible-changes와 같은 위반은 묶되 HTTP 고유의 계약 근거와 독립 설정을 유지합니다.",
  },
];
const rules = httpRules;
const specifier = "aquarius-section-19-fixture";
const plugin: RulePlugin = { namespace: "aquarius", lintRules: rules };
const config = (selections: RuleSettings): LoadedConfig => ({
  tool: "lint",
  cwd: import.meta.dirname,
  projectRoot: import.meta.dirname,
  configDirectory: import.meta.dirname,
  files: [],
  ignore: [],
  plugins: [specifier],
  ai: { adapter: "unused", options: {}, timeoutMs: 1_000 },
  preset: [],
  rules: selections,
});
const prepare = (selections: RuleSettings) =>
  prepareRules(config(selections), { [specifier]: plugin });

describe("section 19: http", () => {
  test("preserves every canonical ID and description without activating registered rules", async () => {
    expect(rules.map(({ id, description }) => ({ id, description }))).toEqual(expected);
    expect(new Set(rules.map(({ id }) => id)).size).toBe(15);
    expect(await prepare({})).toEqual({ rules: [], errors: [] });
  });

  test.each(rules)(
    "$id builds the six-field instructions through the actual engine API",
    async (rule) => {
      const selections: RuleSettings = {
        [`aquarius/${rule.id}`]: allRulesPreset[`aquarius/${rule.id}`],
      };
      const result = await prepare(selections);
      expect(result.errors).toEqual([]);
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0]!.id).toBe(`aquarius/${rule.id}`);
      expect(result.rules[0]!.scope).toBe("project");
      expect(result.rules[0]!.severity).toBe("warn");
      const instructions = result.rules[0]!.instructions as LintInstructions;
      expect(Object.keys(instructions).sort()).toEqual([
        "applicability",
        "criteria",
        "evidenceRequirements",
        "examples",
        "exceptions",
        "procedure",
      ]);
      expect(instructions.criteria).toContain(rule.description);
      expect(instructions.criteria).toContain("검사 범위에서 입증된 위반이 없으면 pass");
      expect(instructions.criteria).toContain(
        "설정·문서·전용 검사기 부재를 pass나 결함의 자동 근거로 삼지 않는다",
      );
      expect(instructions.evidenceRequirements.length).toBeGreaterThanOrEqual(3);
      expect(instructions.exceptions!.length).toBeGreaterThan(0);
      expect(instructions.procedure!.length).toBeGreaterThanOrEqual(4);
      expect(instructions.examples!.map(({ expected }) => expected)).toEqual([
        "violation",
        "pass",
        "not_applicable",
      ]);
      for (const example of instructions.examples!) {
        expect(example.scenario.length).toBeGreaterThan(20);
        expect(example.reason.length).toBeGreaterThan(20);
      }
    },
  );

  test.each(rules)(
    "$id remains independent of disabled neighbors and validates options",
    async (rule) => {
      const disabled = Object.fromEntries(
        rules
          .filter(({ id }) => id !== rule.id)
          .map(({ id }) => [`aquarius/${id}`, "off" as const]),
      );
      const result = await prepare({
        ...disabled,
        [`aquarius/${rule.id}`]: "error",
      });
      expect(result.errors).toEqual([]);
      expect(result.rules.map(({ id, severity }) => ({ id, severity }))).toEqual([
        { id: `aquarius/${rule.id}`, severity: "error" },
      ]);
      const invalid = await prepare({
        ...disabled,
        [`aquarius/${rule.id}`]: ["warn", { inventedPolicy: true }],
      });
      expect(invalid.rules).toEqual([]);
      expect(invalid.errors.map(({ code }) => code)).toEqual(["RULE_OPTIONS_INVALID"]);
    },
  );

  test.each(rules)(
    "$id returns fresh instructions without retaining caller mutations",
    async (rule) => {
      const first = await rule.buildPrompt({ options: Object.freeze({}) });
      const second = await rule.buildPrompt({ options: Object.freeze({}) });
      expect(first).toEqual(second);
      expect(first).not.toBe(second);
      first.evidenceRequirements.push("caller mutation");
      first.exceptions!.push("caller mutation");
      first.examples![0]!.reason = "caller mutation";
      expect(await rule.buildPrompt({ options: {} })).toEqual(second);
    },
  );

  test("retains all independent selections when the section is enabled together", async () => {
    const selections = Object.fromEntries(
      rules.map(({ id }) => [`aquarius/${id}`, allRulesPreset[`aquarius/${id}`]]),
    );
    const result = await prepare(selections);
    expect(result.errors).toEqual([]);
    expect(result.rules.map(({ id }) => id)).toEqual(expected.map(({ id }) => `aquarius/${id}`));
  });

  test.each([
    ["align-method-and-effects", "exceptions", "보조 효과"],
    ["accurate-status-semantics", "exceptions", "GraphQL"],
    ["bounded-request-payloads", "examples", "chunked"],
    ["preserve-idempotency-contract", "examples", "204와 404"],
    ["verify-webhook-authenticity", "evidenceRequirements", "원본 bytes"],
    ["reject-replayed-webhooks", "exceptions", "독립 검증"],
    ["validate-external-responses", "exceptions", "runtime 검증"],
    ["explicit-api-version-evolution", "exceptions", "독립 활성"],
  ] as const)("preserves the boundary for %s", async (id, field, fragment) => {
    const rule = rules.find((rule) => rule.id === `http/${id}`)!;
    const instructions = await rule.buildPrompt({ options: {} });
    expect(JSON.stringify(instructions[field as keyof LintInstructions])).toContain(fragment);
  });
});
