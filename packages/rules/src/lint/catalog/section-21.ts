import type { LintRule } from "@aquarius/core";

// Section 21: 프런트엔드와 UI 구조.
// Prompt definitions only. Registration does not enable rules or prove detection quality.
// Canonical source: https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad
export const section21Rules: LintRule[] = [
  {
    id: "ui/separate-view-and-domain-policy",
    description: "프로젝트가 공유·신뢰 경계에서 보장하도록 정한 업무 정책이 화면 표시 코드에만 존재해 다른 진입점에서 우회되는지 검사합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "UI entry points that enforce shared business policies.",
      criteria: "프로젝트가 공유·신뢰 경계에서 보장하도록 정한 업무 정책이 화면 표시 코드에만 존재해 다른 진입점에서 우회되는지 검사합니다.\n\n버튼을 숨기는 것만으로 서버의 권한·상태 전이를 보장할 수는 없지만 표시 전용 규칙까지 서버로 옮길 필요는 없습니다. 공유·신뢰 경계에서 보장해야 하는 정책과 클라이언트의 표현 선택을 구분해야 합니다.\n\n중복 구별: security/authorize-at-trusted-boundary는 권한 하드 의무이며 모든 UI 도메인 정책 분리가 보안 이슈인 것은 아니다",
      evidenceRequirements: [
        "The policy source, protected operation, all relevant entry points, and the concrete bypass from another entry point.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 신뢰/업무 경계 · 공유되어야 할 정책 · 서버·다른 진입점의 실제 보호"
      ],
      exceptions: [
        "Presentation-only choices and independently enforced shared/server policies do not require moving display code into a domain layer.",
        "허용 사례: 클라이언트 전용 표시 규칙 또는 서버 정책을 반영한 UX 안내"
      ],
      procedure: [
        "수준: 계약 근거 검사",
        "환경: JS/JSX/템플릿의 실제 framework와 상태·효과 API를 식별할 때 적용. TSX/types만으로 React 또는 특정 상태 owner를 추정하지 않음. browser UI와 server rendering·native UI를 구분; framework/query library의 버전별 lifecycle·동시성 요약 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "The only owner check hides a delete button while a reachable delete endpoint accepts another user's resource.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The policy source, protected operation, all relevant entry points, and the concrete bypass from another entry point."
        },
        {
          scenario: "A delete endpoint enforces ownership and the UI independently hides the button for clarity.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Presentation-only choices and independently enforced shared/server policies do not require moving display code into a domain layer."
        },
        {
          scenario: "위반 사례: 버튼 숨김만 존재하고 서버에서 금지 상태 전이를 직접 호출할 수 있다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "ui/no-side-effects-during-render",
    description: "식별된 프레임워크의 렌더 단계에서 비지역 변경·전송·저장 등 금지된 효과가 실행되는지 검사하고, 허용된 지역 계산·초기화와 이벤트·커밋 단계는 구분합니다.",
    scope: "module",
    buildPrompt: () => ({
      applicability: "Functions executed during a UI framework's render phase.",
      criteria: "식별된 프레임워크의 렌더 단계에서 비지역 변경·전송·저장 등 금지된 효과가 실행되는지 검사하고, 허용된 지역 계산·초기화와 이벤트·커밋 단계는 구분합니다.\n\nReact는 렌더 안에서 새로 만든 지역 배열을 변경하는 것과 모듈 전역 상태를 변경하는 것을 다르게 취급합니다. 이벤트 콜백을 정의한 것과 렌더 도중 호출한 것도 구분해야 하므로 JSX 근처의 변경 연산만으로 판정하면 안 됩니다.",
      evidenceRequirements: [
        "The framework render entry, a reachable invocation during render, the nonlocal effect target, and the applicable render-phase prohibition.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Mutating freshly created local values and defining callbacks without invoking them during render are allowed; event/commit phases follow their own contracts."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A React component calls a payment request during render.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The framework render entry, a reachable invocation during render, the nonlocal effect target, and the applicable render-phase prohibition."
        },
        {
          scenario: "A component fills a newly allocated local array and defines an event callback that sends only when clicked.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Mutating freshly created local values and defining callbacks without invoking them during render are allowed; event/commit phases follow their own contracts."
        },
      ]
    }),
  },
  {
    id: "ui/single-owner-for-shared-ui-state",
    description: "동일한 UI 사실의 최종 변경 권한이 서로 독립된 소유자에게 있어 선언된 동기화 계약이 깨지는 경로를 검사합니다.",
    scope: "module",
    buildPrompt: () => ({
      applicability: "UI state updated by multiple components or stores.",
      criteria: "동일한 UI 사실의 최종 변경 권한이 서로 독립된 소유자에게 있어 선언된 동기화 계약이 깨지는 경로를 검사합니다.\n\n여러 컴포넌트가 하나의 reducer나 조정 계약에 따라 변경을 요청하는 것은 합법적입니다. setter 수보다 독립된 최종 권한의 충돌을 확인하고, 일반 상태 규칙과 UI 규칙이 모두 켜져 같은 위반을 확인한 경우에만 하나로 보고해야 합니다.\n\n중복 구별: state/single-owner-for-shared-state와 같은 위반인 경우만 묶는다. UI 어댑터와 일반 저장소 범위는 같지 않을 수 있다",
      evidenceRequirements: [
        "The same fact in each store, independent final write authorities, the coordination contract, and a conflicting update sequence.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 동일 UI 사실 · 최종 권한·동기화/조정 계약 · 각 writer와 상태 전파"
      ],
      exceptions: [
        "Multiple components dispatching to one reducer or an explicit coordinator are not independent owners.",
        "허용 사례: 여러 dispatcher가 하나의 reducer나 합의된 동기화 절차로 갱신한다"
      ],
      procedure: [
        "수준: 계약 근거 검사",
        "환경: JS/JSX/템플릿의 실제 framework와 상태·효과 API를 식별할 때 적용. TSX/types만으로 React 또는 특정 상태 owner를 추정하지 않음. browser UI와 server rendering·native UI를 구분; framework/query library의 버전별 lifecycle·동시성 요약 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "Two independent selection stores overwrite each other after one user selection with no coordination contract.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The same fact in each store, independent final write authorities, the coordination contract, and a conflicting update sequence."
        },
        {
          scenario: "Several controls dispatch selection changes to one reducer that owns the final value.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Multiple components dispatching to one reducer or an explicit coordinator are not independent owners."
        },
        {
          scenario: "위반 사례: 선택 항목의 독립 최종 저장소 둘이 서로 다른 값으로 확정되어 화면이 충돌한다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "ui/separate-server-and-local-state",
    description: "서버 원본·로컬 편집본·낙관적 값의 역할과 동기화 계약이 혼동되어 덮어쓰기·유실되는 경로를 검사합니다.",
    scope: "module",
    buildPrompt: () => ({
      applicability: "UI code synchronizing server data, local drafts, or optimistic values.",
      criteria: "서버 원본·로컬 편집본·낙관적 값의 역할과 동기화 계약이 혼동되어 덮어쓰기·유실되는 경로를 검사합니다.\n\n서버 데이터를 로컬 초안으로 복사하는 것은 흔한 편집 설계이며 그 자체로 중복 진실 공급원은 아닙니다. 백그라운드 갱신이 저장 전 입력을 지우는 등 역할·동기화 계약 위반을 구체적으로 확인해야 합니다.\n\n중복 구별: state/no-competing-sources-of-truth와 달리 권한은 서버 하나여도 잘못된 draft 동기화가 발생한다",
      evidenceRequirements: [
        "The role of each value, refresh/save/edit paths, and a sequence that overwrites unsaved or newer data contrary to the contract.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 서버 원본/초안/낙관값 역할 · reset/merge/commit 정책 · 갱신 경로"
      ],
      exceptions: [
        "Local editable copies and intentional resets are valid when their synchronization and discard policy is preserved.",
        "허용 사례: 서버 값을 편집 초안으로 복사하고 저장/취소 때만 재동기화한다"
      ],
      procedure: [
        "수준: 계약 근거 검사",
        "환경: JS/JSX/템플릿의 실제 framework와 상태·효과 API를 식별할 때 적용. TSX/types만으로 React 또는 특정 상태 owner를 추정하지 않음. browser UI와 server rendering·native UI를 구분; framework/query library의 버전별 lifecycle·동시성 요약 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A background refresh replaces an unsaved form draft despite the product's preserve-edits contract.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The role of each value, refresh/save/edit paths, and a sequence that overwrites unsaved or newer data contrary to the contract."
        },
        {
          scenario: "A form keeps a local draft and rebases server changes without discarding user edits.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Local editable copies and intentional resets are valid when their synchronization and discard policy is preserved."
        },
        {
          scenario: "위반 사례: 백그라운드 refetch가 보존해야 할 저장 전 입력을 덮어쓴다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "ui/explicit-loading-empty-error-states",
    description: "제품이 구분하기로 한 요청 상태가 사용자에게 잘못 표시되거나 다음 동작을 막는 구체적 경로를 검사합니다.",
    scope: "module",
    buildPrompt: () => ({
      applicability: "UI code displaying asynchronous request results or status.",
      criteria: "제품이 구분하기로 한 요청 상태가 사용자에게 잘못 표시되거나 다음 동작을 막는 구체적 경로를 검사합니다.\n\n상위 오류 경계나 로딩 경계가 상태 표시를 맡을 수 있으므로 모든 컴포넌트가 세 상태를 직접 렌더할 필요는 없습니다. 실패를 성공한 빈 목록으로 오인시키는 등 제품이 구분하기로 한 의미의 손실을 검사해야 합니다.\n\n중복 구별: contract/explicit-error-results가 실패를 올바르게 전달해도 UI가 잘못 표시할 수 있어 별도 의무다",
      evidenceRequirements: [
        "The product state contract, request transitions, responsible boundaries, and the misleading display or blocked interaction.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 사용자에게 구분할 요청 상태·제품 계약 · ancestor/boundary 렌더 · 요청 결과 경로"
      ],
      exceptions: [
        "Parent suspense/loading/error boundaries may own the distinction; each component need not render every state itself.",
        "허용 사례: 상위 error boundary가 실패 표시를 맡거나 승인된 공통 skeleton을 사용한다"
      ],
      procedure: [
        "수준: 계약 근거 검사",
        "환경: JS/JSX/템플릿의 실제 framework와 상태·효과 API를 식별할 때 적용. TSX/types만으로 React 또는 특정 상태 owner를 추정하지 않음. browser UI와 server rendering·native UI를 구분; framework/query library의 버전별 lifecycle·동시성 요약 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A failed search is shown as a successful empty result despite a required retry path.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The product state contract, request transitions, responsible boundaries, and the misleading display or blocked interaction."
        },
        {
          scenario: "A parent boundary shows request failure and retry while the child renders only successful data.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Parent suspense/loading/error boundaries may own the distinction; each component need not render every state itself."
        },
        {
          scenario: "위반 사례: 오류를 정상 빈 목록 메시지로 보여 사용자가 데이터가 없다고 오인한다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "ui/no-stale-closure-behavior",
    description: "최신 값 사용이 필요한 계약을 가진 콜백이 이전 렌더의 값을 사용해 잘못된 동작을 하는 경로를 검사하고, 사용자 동작 시점의 의도된 스냅샷은 허용합니다.",
    scope: "module",
    buildPrompt: () => ({
      applicability: "UI callbacks that capture values used after a later render or state change.",
      criteria: "최신 값 사용이 필요한 계약을 가진 콜백이 이전 렌더의 값을 사용해 잘못된 동작을 하는 경로를 검사하고, 사용자 동작 시점의 의도된 스냅샷은 허용합니다.\n\n전송 버튼을 누른 순간의 수신자를 나중에도 사용하는 스냅샷은 의도된 동작일 수 있습니다. 모든 클로저를 최신 값 참조로 바꾸면 오히려 다른 사람에게 전송할 수 있으므로 최신성이 필요한 계약을 먼저 확인해야 합니다.",
      evidenceRequirements: [
        "The capture render, later callback execution, the changed value, and a counterexample against the freshness contract.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Intentional action-time snapshots, such as the recipient selected when Send was clicked, are allowed."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A polling callback must use the current account but keeps requesting the account from its initial render.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The capture render, later callback execution, the changed value, and a counterexample against the freshness contract."
        },
        {
          scenario: "A delayed send uses the recipient selected when the user pressed Send, as required by the product contract.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Intentional action-time snapshots, such as the recipient selected when Send was clicked, are allowed."
        },
      ]
    }),
  },
  {
    id: "ui/complete-effect-dependencies",
    description: "식별된 프레임워크·버전의 효과 의존성 계약에 따라 재동기화에 필요한 반응형 값의 누락을 검사하며, 안정 값·비반응형 경로·등록된 사용자 정의 훅을 구분합니다.",
    scope: "module",
    buildPrompt: () => ({
      applicability: "Reactive effects or custom hooks with dependency-driven resynchronization.",
      criteria: "식별된 프레임워크·버전의 효과 의존성 계약에 따라 재동기화에 필요한 반응형 값의 누락을 검사하며, 안정 값·비반응형 경로·등록된 사용자 정의 훅을 구분합니다.\n\n반응형 값·안정 값·비반응형 경로는 프레임워크와 버전에 따라 구분됩니다. 식별된 훅과 기존 분석기 설정을 활용하고, 의존성 추가가 재실행 횟수나 순환을 바꿀 수 있으므로 단순 자동 수정은 피해야 합니다.",
      evidenceRequirements: [
        "The effect/hook identity and version, reactive reads, dependency declarations, and a missing required resynchronization.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Proven stable values, nonreactive paths, and version-supported hook semantics need not be added as dependencies."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A React effect subscribes to roomId but omits it from dependencies, so changing rooms keeps the old subscription.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The effect/hook identity and version, reactive reads, dependency declarations, and a missing required resynchronization."
        },
        {
          scenario: "A documented stable dispatcher is omitted while every reactive subscription input is tracked.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Proven stable values, nonreactive paths, and version-supported hook semantics need not be added as dependencies."
        },
      ]
    }),
  },
  {
    id: "ui/cleanup-owned-effects",
    description: "효과가 소유한 구독·타이머·작업이 재실행·교체·해제될 때 자원 해제·취소 책임을 지키는지 검사하고, 이전 결과의 반영 차단은 별도의 최신성 계약으로 확인합니다.",
    scope: "module",
    buildPrompt: () => ({
      applicability: "UI effects that acquire subscriptions, timers, or asynchronous tasks.",
      criteria: "효과가 소유한 구독·타이머·작업이 재실행·교체·해제될 때 자원 해제·취소 책임을 지키는지 검사하고, 이전 결과의 반영 차단은 별도의 최신성 계약으로 확인합니다.\n\n이전 응답을 무시하면 최신성은 지킬 수 있어도 소유한 구독·타이머의 해제 책임까지 사라지는 것은 아닙니다. 재실행·교체·해제 시 자원 정리와 결과 차단을 각각 확인하고, 자원 규칙과 같은 의무의 동일 위반을 확인했을 때만 묶어야 합니다.",
      evidenceRequirements: [
        "The acquisition and owner, rerun/unmount paths, cleanup or cancellation obligation, and a reachable resource that survives its required lifetime.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Framework/library-owned cleanup and explicit ownership transfer are valid when proven; ignoring stale results does not release owned resources."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "Unmount sets an ignoreResults flag but leaves its owned interval running.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The acquisition and owner, rerun/unmount paths, cleanup or cancellation obligation, and a reachable resource that survives its required lifetime."
        },
        {
          scenario: "An effect unsubscribes its owned listener on replacement and separately ignores an obsolete response.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Framework/library-owned cleanup and explicit ownership transfer are valid when proven; ignoring stale results does not release owned resources."
        },
      ]
    }),
  },
  {
    id: "ui/stable-semantic-item-identity",
    description: "항목의 삽입·삭제·재정렬·교체에서 프레임워크 키가 선언된 항목 정체성과 상태 보존 계약을 유지하는지 검사합니다.",
    scope: "module",
    buildPrompt: () => ({
      applicability: "Keyed UI collections with insertion, removal, reordering, or replacement.",
      criteria: "항목의 삽입·삭제·재정렬·교체에서 프레임워크 키가 선언된 항목 정체성과 상태 보존 계약을 유지하는지 검사합니다.\n\n재정렬되는 편집 행에서 index 키는 다른 항목으로 상태를 옮길 수 있지만 고정 목록이나 의도된 상태 초기화는 별도 판단이 필요합니다. 추측한 id로 자동 교체하지 말고 항목 정체성과 보존·초기화 계약을 확인해야 합니다.",
      evidenceRequirements: [
        "The semantic identity contract, key computation, collection transition, and resulting state association.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Fixed lists with stable positional identity and explicit state-reset keys are allowed when their contracts justify them."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "Editable rows use array indexes as keys, and reordering moves one row's local draft onto another item.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The semantic identity contract, key computation, collection transition, and resulting state association."
        },
        {
          scenario: "Rows use a validated stable item identity, while an intentional revision key resets state on replacement.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Fixed lists with stable positional identity and explicit state-reset keys are allowed when their contracts justify them."
        },
      ]
    }),
  },
  {
    id: "ui/reconcile-optimistic-updates",
    description: "낙관적 변경의 실패·서버 정정·동시 변경에 대해 선언된 재동기화·보상 정책이 최신 상태를 보존하는지 검사합니다.",
    scope: "module",
    buildPrompt: () => ({
      applicability: "UI mutations that update local state before the server confirms the result.",
      criteria: "낙관적 변경의 실패·서버 정정·동시 변경에 대해 선언된 재동기화·보상 정책이 최신 상태를 보존하는지 검사합니다.\n\n실패 시 예전 전체 스냅샷으로 되돌리면 그 뒤 성공한 변경까지 사라질 수 있습니다. 버전별 보상·권위 있는 재조회·라이브러리 관리 등 동등한 복구 방식을 인정하고, 수동 rollback 코드 유무만으로 판단하지 않아야 합니다.\n\n중복 구별: async/no-stale-result-overwrite는 조회에서도 발생하며 optimistic 실패 보상은 추가 상태·rollback 의무가 있다",
      evidenceRequirements: [
        "The authoritative state and versions, overlapping timeline, failure/correction policy, and lost or incorrectly restored state.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: mutation ID·순서·서버 권위·보상/재조회 정책 · 겹친 변경과 라이브러리 동작"
      ],
      exceptions: [
        "Versioned compensation, authoritative refetch, and library-managed reconciliation are valid alternatives to handwritten rollback.",
        "허용 사례: 버전별 보상·overlay 재계산·서버 재조회가 최신 확정 상태를 보존한다"
      ],
      procedure: [
        "수준: 계약 근거 검사",
        "환경: JS/JSX/템플릿의 실제 framework와 상태·효과 API를 식별할 때 적용. TSX/types만으로 React 또는 특정 상태 owner를 추정하지 않음. browser UI와 server rendering·native UI를 구분; framework/query library의 버전별 lifecycle·동시성 요약 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "Failure of edit A restores an old whole-state snapshot and deletes the later successful edit B.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The authoritative state and versions, overlapping timeline, failure/correction policy, and lost or incorrectly restored state."
        },
        {
          scenario: "An optimistic mutation is compensated by version without removing a later confirmed change.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Versioned compensation, authoritative refetch, and library-managed reconciliation are valid alternatives to handwritten rollback."
        },
        {
          scenario: "위반 사례: 이전 요청 실패의 전체 snapshot rollback이 이후 성공한 변경까지 지운다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "ui/consistent-form-validation",
    description: "입력 중·제출·서버 검증이 각 단계의 의도된 강도를 따르면서 최종 허용 계약과 모순되는지 검사합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Forms with input-time, submission-time, or server-side validation.",
      criteria: "입력 중·제출·서버 검증이 각 단계의 의도된 강도를 따르면서 최종 허용 계약과 모순되는지 검사합니다.\n\n입력 중 미완성 소수를 허용하고 제출 시 엄격하게 검사하는 것은 정당하며 서버만 확인할 수 있는 조건도 있습니다. 모든 단계에 같은 스키마를 강제하기보다 최종 허용 계약과 각 단계의 의도된 강도가 모순되는지 확인해야 합니다.\n\n중복 구별: contract/separate-input-output-schemas는 작업별 shape이며 같은 입력 schema라도 단계별 검사 시점은 다를 수 있다",
      evidenceRequirements: [
        "Each stage's intended strength, the final acceptance contract, and a specific input accepted/rejected inconsistently with that contract.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 입력 중/제출/서버 단계의 허용·필수·타이밍 계약 · schema와 UX 조건"
      ],
      exceptions: [
        "Partial input while editing, stronger submission validation, and server-only checks are allowed; one shared schema is not required.",
        "허용 사례: 입력 중 '-'를 허용하고 제출 때 숫자를 요구하거나 서버만 유일성을 검사한다"
      ],
      procedure: [
        "수준: 계약 근거 검사",
        "환경: JS/JSX/템플릿의 실제 framework와 상태·효과 API를 식별할 때 적용. TSX/types만으로 React 또는 특정 상태 owner를 추정하지 않음. browser UI와 server rendering·native UI를 구분; framework/query library의 버전별 lifecycle·동시성 요약 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "Submission accepts an amount outside the final supported range and the server silently persists it.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Each stage's intended strength, the final acceptance contract, and a specific input accepted/rejected inconsistently with that contract."
        },
        {
          scenario: "The editor allows an unfinished decimal while submission and the server enforce the final numeric contract.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Partial input while editing, stronger submission validation, and server-only checks are allowed; one shared schema is not required."
        },
        {
          scenario: "위반 사례: 문서상 유효한 값을 최종 client submit에서 무조건 거부하여 서버의 유효 작업을 막는다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "ui/keyboard-equivalent-actions",
    description: "키보드로 가능해야 하는 기능이 적절한 시맨틱 컨트롤·포커스·키보드 경로를 통해 동등하게 수행되는지 검사하며, 입력 경로 자체에 의존하는 표준의 예외를 구분합니다.",
    scope: "module",
    buildPrompt: () => ({
      applicability: "User actions exposed through interactive UI controls.",
      criteria: "키보드로 가능해야 하는 기능이 적절한 시맨틱 컨트롤·포커스·키보드 경로를 통해 동등하게 수행되는지 검사하며, 입력 경로 자체에 의존하는 표준의 예외를 구분합니다.\n\n네이티브 button은 별도의 keydown 구현 없이 키보드 동작을 제공할 수 있고, 경로 자체에 의존하는 입력에는 표준상 예외가 있습니다. 정적 검사 결과만으로 전체 접근성 준수를 인증하지 말고 실제 인터랙션 확인 범위를 구분해야 합니다.",
      evidenceRequirements: [
        "The action, semantic element and focus path, keyboard activation behavior, applicable standard exception, and observed/unanalyzed interaction scope.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Native keyboard semantics and functions inherently dependent on the input path's movement may satisfy applicable exceptions."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A clickable nonsemantic element performs a required action but has no focus or keyboard activation path.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The action, semantic element and focus path, keyboard activation behavior, applicable standard exception, and observed/unanalyzed interaction scope."
        },
        {
          scenario: "A native button provides the required keyboard action without custom keydown code.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Native keyboard semantics and functions inherently dependent on the input path's movement may satisfy applicable exceptions."
        },
      ]
    }),
  },
  {
    id: "ui/preserve-meaningful-focus",
    description: "선언된 인터랙션의 열기·닫기·갱신·오류 전환에서 포커스 이동·복귀·사용 가능성이 계약과 일치하는지 검사합니다.",
    scope: "module",
    buildPrompt: () => ({
      applicability: "UI transitions that open, close, update, or remove focusable content.",
      criteria: "선언된 인터랙션의 열기·닫기·갱신·오류 전환에서 포커스 이동·복귀·사용 가능성이 계약과 일치하는지 검사합니다.\n\n모달이 닫힐 때 포커스 복귀가 필요할 수 있지만 안내 토스트가 매번 포커스를 빼앗는 것은 오히려 잘못된 동작입니다. UI 프리미티브가 관리하는 경로와 제품의 열기·닫기·오류 전환 계약을 확인해야 합니다.\n\n중복 구별: keyboard-equivalent-actions가 모든 기능의 키 입력을 제공해도 modal focus 복귀는 깨질 수 있다",
      evidenceRequirements: [
        "The triggering control, active focus before/after the transition, actual focusable targets, and framework/primitive ownership.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 인터랙션별 focus 목표·복귀·사용가능성 · 실제 DOM/프리미티브 계약 · 검증된 상태 전환"
      ],
      exceptions: [
        "A proven UI primitive can own focus; informational toasts should not automatically take focus absent such a contract.",
        "허용 사례: UI primitive가 적절한 복귀를 담당하거나 toast가 기존 입력 focus를 유지한다"
      ],
      procedure: [
        "수준: 계약 근거 검사",
        "환경: 렌더된 DOM 및 focus primitive의 실제 동작을 추적할 때 적용. 타입은 실제 DOM 순서·포커스·보조기술 동작을 증명하지 않음. browser DOM 기준 설계; shadow DOM/portal/framework/native UI는 별도 지원 검증 필요, 정적 검사만으로 완전 접근성 준수 주장 금지",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "Closing a modal removes the focused element and loses focus instead of returning to the still-available trigger as required.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The triggering control, active focus before/after the transition, actual focusable targets, and framework/primitive ownership."
        },
        {
          scenario: "A modal primitive returns focus to its trigger, and a status toast announces without stealing focus.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. A proven UI primitive can own focus; informational toasts should not automatically take focus absent such a contract."
        },
        {
          scenario: "위반 사례: 모달 종료 후 복귀해야 할 컨트롤이 있는데 포커스가 제거 노드에 남거나 탐색 흐름을 잃는다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "ui/consistent-hydration-state",
    description: "실제 서버 렌더·수화 대상에서 서버 출력과 클라이언트 최초 렌더의 계약 위반을 검사하고, 승인된 불일치 처리·클라이언트 전용 경계는 구분합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "UI boundaries rendered on the server and hydrated on the client.",
      criteria: "실제 서버 렌더·수화 대상에서 서버 출력과 클라이언트 최초 렌더의 계약 위반을 검사하고, 승인된 불일치 처리·클라이언트 전용 경계는 구분합니다.\n\n모든 JSX가 서버 수화 대상은 아니며 클라이언트 전용 경계와 승인된 제한적 불일치 처리도 존재합니다. 실제 서버·최초 클라이언트 출력 경로를 확인하고 경고 억제 옵션만으로 모든 불일치가 안전하다고 판단하지 않아야 합니다.",
      evidenceRequirements: [
        "The server and first-client output paths, data/time/environment inputs, boundary configuration, and a concrete mismatch.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Client-only boundaries and explicitly supported limited mismatches are allowed only within their proven scope; a warning-suppression option is not proof of safety."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A hydrated timestamp is generated independently on server and client and violates the required initial markup contract.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The server and first-client output paths, data/time/environment inputs, boundary configuration, and a concrete mismatch."
        },
        {
          scenario: "A client-only widget is excluded from server hydration by the framework-supported boundary.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Client-only boundaries and explicitly supported limited mismatches are allowed only within their proven scope; a warning-suppression option is not proof of safety."
        },
      ]
    }),
  },
  {
    id: "ui/isolate-browser-server-execution",
    description: "실제 배포·실행 경계에서 브라우저 전용 API나 서버 전용 코드가 도달 가능한 잘못된 환경에서 실행·노출되는지 검사합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "UI code crossing browser, server, or other platform execution boundaries.",
      criteria: "실제 배포·실행 경계에서 브라우저 전용 API나 서버 전용 코드가 도달 가능한 잘못된 환경에서 실행·노출되는지 검사합니다.\n\n서버에서 window를 실행하는 문제와 클라이언트 묶음에 서버 비밀이 포함되는 문제는 방향도 결과도 다릅니다. 관련 모듈·플랫폼 규칙과 동치로 합치지 말고, 양쪽 활성 규칙이 같은 실행·노출 위반을 실제로 확인한 경우에만 묶어야 합니다.\n\n중복 구별: module/no-server-code-in-client-bundle은 한 방향 노출이므로 서버의 browser API 실행과 동치가 아니다",
      evidenceRequirements: [
        "Reachable imports/execution or bundle exposure, environment-specific capability or secret classification, and the actual deployment graph.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 실제 환경/entrypoint·bundle graph · import-time 실행 · 조건부 guard·framework 서버/클라이언트 경계"
      ],
      exceptions: [
        "Verified conditional execution, platform adapters, and supported client/server entry boundaries are allowed.",
        "허용 사례: browser-only event의 window 접근 또는 보장된 client-only module"
      ],
      procedure: [
        "수준: 계약 근거 검사",
        "환경: import/require/dynamic import와 실제 실행·배포 graph를 해석할 때 적용. type-only import와 실행 import·변환기 출력을 구분; TS source만으로 bundle 포함을 단정하지 않음. Node 조건부 exports/loader와 browser bundler/framework client-server 경계가 다름; 실제 조건과 버전 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "An SSR entry executes an unconditional window access on the server.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Reachable imports/execution or bundle exposure, environment-specific capability or secret classification, and the actual deployment graph."
        },
        {
          scenario: "A browser-only dependency is isolated behind a verified client boundary that never executes during SSR.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Verified conditional execution, platform adapters, and supported client/server entry boundaries are allowed."
        },
        {
          scenario: "위반 사례: 서버 진입점 top-level에서 window를 읽거나 client graph에 실제 server secret이 포함된다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
];
