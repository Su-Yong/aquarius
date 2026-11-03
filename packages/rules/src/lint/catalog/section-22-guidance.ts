// Non-rule history. Never add these records to a RulePlugin.lintRules array.
export const section22Guidance = [
  {
    id: "test/property-based-invariants-when-useful",
    kind: "guidance",
    description: "**비규칙 안내로 이동** · 독립 lint 후보에서 제외하고 ‘불변 조건에 맞는 검증 기법 선택’ 안내로 보존합니다. 특정 기법이 없다는 이유로 위반을 세지 않으며, 경계 검증 규칙으로 대체하지 않습니다. 실제 운영 설정의 심각도·예외를 자동 변환한 것은 아닙니다. [검증 안내](https://chatgpt.com/space/page_f30686036504819196e3036f53a477ab)",
    replacementRuleId: null,
    reason: "Choose verification techniques that fit the invariant. Lack of property-based testing is not a violation; boundary coverage is not a replacement rule. This record does not migrate active severity, options or scoped suppressions.",
    sourceUrl: "https://chatgpt.com/space/page_f30686036504819196e3036f53a477ab"
  }
] as const;
