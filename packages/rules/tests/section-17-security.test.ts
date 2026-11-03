import { describe, expect, test } from "vitest";
import type { LintInstructions, RulePlugin } from "@aquarius/core";
import { prepareRules } from "@aquarius/core/internal";
import type { LoadedConfig, RuleSelection } from "@aquarius/core/internal";
import { securityRules } from "../src/lint/section-17-security";

// Specification and preparation tests do not claim live-model detection quality.
const expected = [
  {
    "id": "security/authorize-at-trusted-boundary",
    "description": "보호된 동작의 모든 진입 경로가 프로젝트가 정한 신뢰 경계의 권한 집행을 거치며, 클라이언트 검증만으로 권한을 확정하지 않도록 합니다."
  },
  {
    "id": "security/resource-level-authorization",
    "description": "로그인 여부뿐 아니라 요청한 개별 자원에 접근할 권한도 확인합니다."
  },
  {
    "id": "security/tenant-scoped-data-access",
    "description": "테넌트 격리가 요구된 데이터 경로에서 조회·변경·집계·캐시가 허용된 테넌트 범위를 벗어나지 않도록 하며, DB 정책과 전용 저장소 등 동등한 집행을 인정합니다."
  },
  {
    "id": "security/default-deny-access",
    "description": "권한 규칙이 없거나 판정에 실패했을 때 임의로 접근을 허용하지 않도록 합니다."
  },
  {
    "id": "security/explicit-privilege-escalation",
    "description": "권한 상승·대리 실행·긴급 접근이 프로젝트가 승인한 주체·범위·수명·검증 및 감사 정책을 거치도록 합니다."
  },
  {
    "id": "security/no-mass-assignment",
    "description": "외부 데이터의 일괄 반영으로 호출자가 변경할 수 없는 보호 필드나 객체 동작이 바뀌지 않도록 하며, 검증된 허용 필드 투영을 인정합니다."
  },
  {
    "id": "security/constrain-remote-destinations",
    "description": "외부 입력이 결정하는 서버 연결 대상이 프로젝트의 허용 네트워크·스킴 정책을 지키도록 하며, 리다이렉트와 주소 해석 이후의 실제 연결 경계까지 검증합니다."
  },
  {
    "id": "security/constrain-file-paths",
    "description": "외부 입력에 따른 파일 접근이 프로젝트의 허용 경계를 벗어나지 않도록 실제 파일 해석·심볼릭 링크·생성 및 경쟁 조건을 고려해 검사합니다."
  },
  {
    "id": "security/no-command-string-interpolation",
    "description": "신뢰할 수 없는 입력이 셸 문법·실행 명령·보호된 옵션을 결정하지 않도록 실제 실행 API와 파서에 맞는 인자 경계를 사용합니다."
  },
  {
    "id": "security/context-aware-output-encoding",
    "description": "외부 데이터가 들어가는 실제 출력 문맥에 맞는 안전한 sink·인코딩·정제 정책을 사용하고, 프레임워크가 이미 보장하는 처리를 중복하지 않도록 합니다."
  },
  {
    "id": "security/no-untrusted-dynamic-evaluation",
    "description": "신뢰할 수 없는 문자열을 코드나 실행 가능한 표현식으로 평가하지 않도록 합니다."
  },
  {
    "id": "security/validate-upload-content-and-limits",
    "description": "업로드의 수신·해석·압축 해제·변환·저장·제공 단계가 선언된 형식·자원·접근 정책을 지키는지 검사하며, 파일명이나 Content-Type만을 근거로 신뢰하지 않습니다."
  },
  {
    "id": "security/no-secrets-in-source",
    "description": "소스·설정·배포물의 비밀 및 의심 비밀 노출을 사용처와 경로의 근거로 보고하고, 활성 여부 미확인이나 전용 검사 부재를 안전으로 간주하지 않습니다. 비밀값 자체는 재노출하지 않습니다."
  },
  {
    "id": "security/no-client-authoritative-privileges",
    "description": "클라이언트가 임의로 바꿀 수 있는 역할·소유자·테넌트 정보가 권한의 최종 근거가 되지 않도록 하며, 신뢰된 발급·검증을 거친 권한 증거를 구분합니다."
  },
  {
    "id": "security/controlled-security-bypasses",
    "description": "인증·검증 우회가 승인된 대상과 실행 범위에서만 가능하고 보호된 배포나 경로로 새어 들어가지 않도록 합니다."
  }
];
const rules = securityRules;
const specifier = "aquarius-section-17-fixture";
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

describe("section 17: security", () => {
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
    "authorize-at-trusted-boundary",
    "exceptions",
    "gateway"
  ],
  [
    "no-mass-assignment",
    "exceptions",
    "Object.assign"
  ],
  [
    "constrain-remote-destinations",
    "evidenceRequirements",
    "DNS"
  ],
  [
    "constrain-file-paths",
    "evidenceRequirements",
    "symlink"
  ],
  [
    "no-command-string-interpolation",
    "exceptions",
    "옵션 주입"
  ],
  [
    "no-secrets-in-source",
    "criteria",
    "무단 active-key probe"
  ],
  [
    "no-secrets-in-source",
    "criteria",
    "재노출"
  ],
  [
    "no-client-authoritative-privileges",
    "exceptions",
    "서명"
  ]
] as const)("preserves the boundary for %s", async (id, field, fragment) => {
    const rule = rules.find((rule) => rule.id === `security/${id}`)!;
    const instructions = await rule.buildPrompt({ options: {} });
    expect(JSON.stringify(instructions[field as keyof LintInstructions])).toContain(fragment);
  });
});
