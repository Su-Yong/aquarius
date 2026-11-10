import type { LintRule } from "@aquarius/core";

// Section 22: 테스트 설계.
// Prompt definitions only. Registration does not enable rules or prove detection quality.
// Canonical source: https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad
export const section22Rules: LintRule[] = [
  {
    id: "test/assert-public-behavior",
    description: "테스트가 지정된 검증 대상의 관찰 가능한 계약을 실제로 확인하는지 검토하고, 내부 프로토콜 자체가 계약인 단위·화이트박스 테스트는 허용합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Tests of public APIs or internal protocols.",
      criteria: "테스트가 지정된 검증 대상의 관찰 가능한 계약을 실제로 확인하는지 검토하고, 내부 프로토콜 자체가 계약인 단위·화이트박스 테스트는 허용합니다.\n\n공개 결과를 검사하면서 불필요한 private 호출 순서도 추가 확인하는 테스트가 있을 수 있어 내부 결합 규칙과 단순 포함 관계가 아닙니다. 두 규칙을 별도로 설정 가능하게 유지하고, 동일 근거가 두 계약을 함께 위반할 때만 결과를 묶어야 합니다.\n\n중복 구별: no-fragile-internal-assertions는 public 결과가 충분히 검증된 테스트의 추가 private 순서 단언도 평가하므로 포함 관계가 아니다",
      evidenceRequirements: [
        "The test's declared target, observable obligation, assertions and failure semantics, and an implementation that violates that obligation yet passes.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 검증 대상의 외부 관찰 계약 · 실제 assertion·helper 의미 · 테스트 목적"
      ],
      exceptions: [
        "Unit/white-box tests may target internal protocols when those interactions are themselves the contract.",
        "허용 사례: 프로토콜 순서 자체가 공개 행동인 adapter 테스트 또는 상태/반환 관찰"
      ],
      procedure: [
        "수준: 선택적 설계 검토",
        "환경: JS 테스트의 실제 runner/등록/assert helper/완료·격리 모델을 식별할 때 적용. TS 타입 테스트는 별도 검증 종류; 컴파일 성공과 런타임 행동 검증을 서로 대체하지 않음. Node test/Jest/Vitest/browser runner별 lifecycle·mock·timeout·실패 전파가 다르며 실제 버전이 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A test claims to verify a returned invoice total but only asserts that a helper was called.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The test's declared target, observable obligation, assertions and failure semantics, and an implementation that violates that obligation yet passes."
        },
        {
          scenario: "A resource protocol test asserts release ordering because that ordering is its explicit contract.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Unit/white-box tests may target internal protocols when those interactions are themselves the contract."
        },
        {
          scenario: "위반 사례: 외부 결과가 틀려도 mock 호출 횟수만 맞으면 통과하며 그 횟수가 계약이 아니다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "test/assert-meaningful-outcomes",
    description: "테스트 종류와 프레임워크의 실패 의미를 기준으로 기대 동작을 검증하지 못하는 테스트 경로를 검사하고, 선언된 무예외·타입·스모크 검증은 허용합니다.",
    scope: "module",
    buildPrompt: () => ({
      applicability: "Behavioral, type, smoke, or no-exception tests.",
      criteria: "테스트 종류와 프레임워크의 실패 의미를 기준으로 기대 동작을 검증하지 못하는 테스트 경로를 검사하고, 선언된 무예외·타입·스모크 검증은 허용합니다.\n\nexpect 호출 수만으로 의미 있는 검증 여부를 판단할 수 없으며, 무예외 완료 자체가 약속인 스모크 테스트도 있습니다. 반대로 비동기 assertion이 테스트 종료 후 실행되면 assertion이 있어도 검증이 유효하지 않을 수 있습니다.\n\n중복 구별: async/await-owned-work와 같은 누락인 경우만 묶는다. assertion 없는 스모크와 Promise 누락은 별개 판정이다\n\nDo not assume every late assertion is ignored: some runners fail the test or entire run on late throws. Verify the actual runner and version.",
      evidenceRequirements: [
        "The expected outcome, framework completion/failure semantics, assertion reachability, and a failing behavior the test misses.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 실제 runner와 버전 · 등록·assert helper·기대실패/스모크 계약 · await/return/종료 의미"
      ],
      exceptions: [
        "Declared no-exception, compile/type, and smoke contracts do not require an expect call.",
        "허용 사례: await된 no-throw smoke test 또는 실행기가 완료·실패를 추적하는 assertion helper; 늦은 throw는 Node에서 전체 실패로 보고된다"
      ],
      procedure: [
        "수준: 분석기·실행기 위임",
        "환경: JS 테스트의 실제 runner/등록/assert helper/완료·격리 모델을 식별할 때 적용. TS 타입 테스트는 별도 검증 종류; 컴파일 성공과 런타임 행동 검증을 서로 대체하지 않음. Node test/Jest/Vitest/browser runner별 lifecycle·mock·timeout·실패 전파가 다르며 실제 버전이 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "In a runner whose verified completion semantics do not track the returned work, an assertion is only inside an unreturned permanently pending Promise and never executes, yet the test passes.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The expected outcome, framework completion/failure semantics, assertion reachability, and a failing behavior the test misses."
        },
        {
          scenario: "A smoke test awaits startup and treats an uncaught startup failure as a failed test, as intended.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Declared no-exception, compile/type, and smoke contracts do not require an expect call."
        },
        {
          scenario: "위반 사례: Node24.19에서 반환하지 않은 영구 pending Promise의 then 내부 assertion이 실행되지 않는데 테스트가 pass한다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "test/independent-fixtures",
    description: "격리 대상으로 선언된 테스트가 이전 테스트의 변경 가능 데이터·모듈 상태·외부 자원에 의존하는 경로를 검사합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Test suites that share fixtures, module state, or external resources.",
      criteria: "격리 대상으로 선언된 테스트가 이전 테스트의 변경 가능 데이터·모듈 상태·외부 자원에 의존하는 경로를 검사합니다.\n\n변경되지 않는 공용 픽스처나 명시적으로 순서가 있는 시나리오 테스트는 정당할 수 있습니다. 이전 테스트가 바꾼 상태에 의존하는지와 실행기·훅·외부 저장소의 격리 범위를 확인해야 합니다.\n\n중복 구별: state/no-shared-mutable-defaults 없이 외부 DB를 통해 테스트 순서 의존이 생기므로 메모리 기본값 검사로 대체할 수 없다",
      evidenceRequirements: [
        "Mutable shared state, setup/reset lifecycle, runner ordering/parallelism, and an order-dependent failing sequence.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: runner 격리/동시성/순서 설정 · before/after lifecycle · 변경 상태·외부 자원·재설정"
      ],
      exceptions: [
        "Immutable shared fixtures and explicitly ordered scenario suites are allowed within their stated isolation contract.",
        "허용 사례: readonly 공용 fixture나 명시된 연속 시나리오를 한 테스트 단위로 실행한다"
      ],
      procedure: [
        "수준: 계약 근거 검사",
        "환경: JS 테스트의 실제 runner/등록/assert helper/완료·격리 모델을 식별할 때 적용. TS 타입 테스트는 별도 검증 종류; 컴파일 성공과 런타임 행동 검증을 서로 대체하지 않음. Node test/Jest/Vitest/browser runner별 lifecycle·mock·timeout·실패 전파가 다르며 실제 버전이 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "Test B passes only when Test A has already changed a shared singleton.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Mutable shared state, setup/reset lifecycle, runner ordering/parallelism, and an order-dependent failing sequence."
        },
        {
          scenario: "Each isolated test starts with a fresh mutable fixture while immutable reference data is shared.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Immutable shared fixtures and explicitly ordered scenario suites are allowed within their stated isolation contract."
        },
        {
          scenario: "위반 사례: 독립 테스트 B가 A가 채운 공유 배열 없이는 실패한다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "test/control-time-and-randomness",
    description: "재현 가능한 테스트에서 결과에 영향을 주는 시간·난수·ID를 고정·주입·가상화하거나 실패를 재현할 seed·기록을 유지하도록 합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Tests whose results depend on time, randomness, or generated identifiers.",
      criteria: "재현 가능한 테스트에서 결과에 영향을 주는 시간·난수·ID를 고정·주입·가상화하거나 실패를 재현할 seed·기록을 유지하도록 합니다.\n\n가상 시계뿐 아니라 재현 가능한 seed 기록도 정당한 통제 방식이며 확률적 성질을 시험하는 테스트도 있습니다. 테스트 종류와 재현 정책을 확인하고, 운영 난수를 고정값으로 약화하는 수정과 구분해야 합니다.",
      evidenceRequirements: [
        "Influential nondeterministic inputs, test type, control/replay policy, and whether a failure can be reproduced with captured seed and timing.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Injected/virtual time, fixed inputs, recorded replayable seeds, and declared statistical testing may all satisfy the policy."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A random failing input affects the assertion but neither its seed nor generated case is retained.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Influential nondeterministic inputs, test type, control/replay policy, and whether a failure can be reproduced with captured seed and timing."
        },
        {
          scenario: "A generative test records the failing seed and input, allowing exact reproduction without fixing production randomness.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Injected/virtual time, fixed inputs, recorded replayable seeds, and declared statistical testing may all satisfy the policy."
        },
      ]
    }),
  },
  {
    id: "test/no-unintended-external-io",
    description: "단위·격리 테스트로 선언된 범위에서 허용되지 않은 실제 네트워크·파일·운영 저장소 접근이 발생할 수 있는 경로를 검사합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Tests that can reach network, file, or external-store I/O.",
      criteria: "단위·격리 테스트로 선언된 범위에서 허용되지 않은 실제 네트워크·파일·운영 저장소 접근이 발생할 수 있는 경로를 검사합니다.\n\n격리 단위 테스트의 운영망 접근과 통합 테스트의 일회용 로컬 서비스 접근은 다르게 평가해야 합니다. fetch import만 보고 실행을 단정하지 말고 mock·차단기·허용 목적지를 확인하며, 검증을 위해 실제 운영 I/O를 실행해서는 안 됩니다.\n\n중복 구별: do-not-mock-away-integration-risk는 통합 목적의 과도한 mock이고 본 규칙은 허용되지 않은 실 I/O라 양립해야 한다",
      evidenceRequirements: [
        "Reachable I/O calls, mock/blocker effectiveness, test category, allowed destinations, and the actual unauthorized path without executing production I/O.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: unit/integration 분류 · 실제 클라이언트 해석 · mock/interceptor · endpoint/파일 허용 정책"
      ],
      exceptions: [
        "Authorized integration tests using disposable/local services and proven interception are allowed.",
        "허용 사례: 명시된 integration test가 disposable local service를 사용한다"
      ],
      procedure: [
        "수준: 계약 근거 검사",
        "환경: JS 테스트의 실제 runner/등록/assert helper/완료·격리 모델을 식별할 때 적용. TS 타입 테스트는 별도 검증 종류; 컴파일 성공과 런타임 행동 검증을 서로 대체하지 않음. Node test/Jest/Vitest/browser runner별 lifecycle·mock·timeout·실패 전파가 다르며 실제 버전이 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "An isolated unit test reaches the production payment endpoint because a mock does not cover its actual client.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Reachable I/O calls, mock/blocker effectiveness, test category, allowed destinations, and the actual unauthorized path without executing production I/O."
        },
        {
          scenario: "An integration test uses its explicitly permitted disposable database with isolated credentials and cleanup.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Authorized integration tests using disposable/local services and proven interception are allowed."
        },
        {
          scenario: "위반 사례: 격리 unit test가 mock 대신 운영 대상 기본 client로 실제 요청 가능한 경로를 가진다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "test/shared-contract-tests",
    description: "동일 계약의 교체 가능성을 보장하기로 한 구현들이 동등한 계약 검증을 받는지 확인하며, 공통 테스트 함수 사용 자체는 요구하지 않습니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Multiple implementations of one replaceable interface or behavior contract.",
      criteria: "동일 계약의 교체 가능성을 보장하기로 한 구현들이 동등한 계약 검증을 받는지 확인하며, 공통 테스트 함수 사용 자체는 요구하지 않습니다.\n\n여러 구현이 같은 계약을 검증해야 한다고 해서 반드시 하나의 공통 테스트 함수로 묶여야 하는 것은 아닙니다. 독립적인 동등 검증이나 모델·속성 테스트도 인정하고, 이름 검색만으로 검증 부재를 단정하지 않아야 합니다.\n\n중복 구별: assert-public-behavior는 한 테스트의 관찰 품질이고 모든 구현의 계약 검증 연결은 별도다",
      evidenceRequirements: [
        "The contract, applicable implementations, equivalent verification obligations, and coverage evidence across the full available suite.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 교체 가능한 구현 목록 · 동일 계약 · test 등록 및 동등 검증 연결"
      ],
      exceptions: [
        "Independent equivalent assertions, property/model tests, and a common suite are all valid; one shared test function is not required.",
        "허용 사례: 각 구현이 별도 방식으로 같은 계약을 검증한다"
      ],
      procedure: [
        "수준: 절차·이력 확인",
        "환경: JS 테스트의 실제 runner/등록/assert helper/완료·격리 모델을 식별할 때 적용. TS 타입 테스트는 별도 검증 종류; 컴파일 성공과 런타임 행동 검증을 서로 대체하지 않음. Node test/Jest/Vitest/browser runner별 lifecycle·mock·timeout·실패 전파가 다르며 실제 버전이 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A replaceable storage adapter has no evidence for its required expiry semantics while the other adapters do.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The contract, applicable implementations, equivalent verification obligations, and coverage evidence across the full available suite."
        },
        {
          scenario: "Separate adapter suites each verify the same expiry and failure contract.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Independent equivalent assertions, property/model tests, and a common suite are all valid; one shared test function is not required."
        },
        {
          scenario: "위반 사례: 새 adapter가 호환 구현 목록에 추가됐으나 전체 확인된 검증 목록에서 해당 계약 검증이 빠진다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "test/cover-failure-and-recovery",
    description: "명시된 중요한 실패·정리·재시도·복구 계약마다 검증 근거가 있는지 확인하고, 실행하지 않은 경로를 검증 완료로 보고하지 않습니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Failure, cleanup, retry, or recovery paths and their tests.",
      criteria: "명시된 중요한 실패·정리·재시도·복구 계약마다 검증 근거가 있는지 확인하고, 실행하지 않은 경로를 검증 완료로 보고하지 않습니다.\n\n실패·복구 검증이 다른 통합 테스트에 있을 수 있으므로 현재 단위 파일에 보이지 않는다는 이유만으로 누락을 확정할 수 없습니다. 요구사항과 전체 검증 근거를 연결하고, 실행하지 않은 경로를 확인 완료로 보고하지 않아야 합니다.\n\n중복 구별: regression-for-fixed-defects는 알려진 결함 이력 기반이고 아직 결함이 없던 중요한 실패 경로도 본 규칙 대상이다",
      evidenceRequirements: [
        "Each required failure/recovery obligation, its verification evidence and execution status, and the inspected test scope.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 필수 실패·정리·복구 요구 · 검증 인벤토리·실행/모델 자료 · 관련 테스트 매핑"
      ],
      exceptions: [
        "Equivalent integration/model verification elsewhere in the suite may satisfy the obligation; absence from one unit file is not proof of absence.",
        "허용 사례: integration·model test가 실패/복구 조건을 직접 검증한다"
      ],
      procedure: [
        "수준: 절차·이력 확인",
        "환경: JS 테스트의 실제 runner/등록/assert helper/완료·격리 모델을 식별할 때 적용. TS 타입 테스트는 별도 검증 종류; 컴파일 성공과 런타임 행동 검증을 서로 대체하지 않음. Node test/Jest/Vitest/browser runner별 lifecycle·mock·timeout·실패 전파가 다르며 실제 버전이 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "The required failure-after-acquisition cleanup path is not covered anywhere in the fully inspected declared verification scope.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Each required failure/recovery obligation, its verification evidence and execution status, and the inspected test scope."
        },
        {
          scenario: "An integration test verifies retry exhaustion and resource cleanup even though a nearby unit file does not.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Equivalent integration/model verification elsewhere in the suite may satisfy the obligation; absence from one unit file is not proof of absence."
        },
        {
          scenario: "위반 사례: 필수 취소 정리 요구가 확인된 전체 검증 범위에서 아무 근거도 없다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "test/cover-boundaries-and-invalid-states",
    description: "선언된 범위·상태 불변 조건의 중요한 경계에 검증 근거가 있는지 확인하며, 예제·속성·모델·스키마 검증을 함께 인정합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Code with input ranges or state invariants and their tests.",
      criteria: "선언된 범위·상태 불변 조건의 중요한 경계에 검증 근거가 있는지 확인하며, 예제·속성·모델·스키마 검증을 함께 인정합니다.\n\n속성·모델 테스트가 경계 조건을 이미 검증할 수 있어 모든 함수에 같은 예제 목록을 요구할 이유는 없습니다. 실제 코드의 경계 결함과 그 결함을 잡을 검증 근거의 부재도 서로 다른 판단입니다.\n\n중복 구별: function/handle-boundary-values는 실제 함수 결함이며 검증 부재만으로 그 함수가 틀렸다고 말할 수 없다",
      evidenceRequirements: [
        "The invariant/range source, important boundary cases, existing example/property/model/schema evidence, and remaining inspected gaps.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 중요 입력 범위·불변 조건 · 예제/생성/모델 검증 범위 · 실행된 자료"
      ],
      exceptions: [
        "Equivalent generative, model, schema, or exhaustive finite-case verification is accepted; no fixed example list is mandatory.",
        "허용 사례: finite exhaustive 또는 property/model test가 해당 경계를 포함한다"
      ],
      procedure: [
        "수준: 절차·이력 확인",
        "환경: JS 테스트의 실제 runner/등록/assert helper/완료·격리 모델을 식별할 때 적용. TS 타입 테스트는 별도 검증 종류; 컴파일 성공과 런타임 행동 검증을 서로 대체하지 않음. Node test/Jest/Vitest/browser runner별 lifecycle·mock·timeout·실패 전파가 다르며 실제 버전이 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A declared inclusive upper limit and rejection beyond it have no verification evidence in the inspected required suite.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The invariant/range source, important boundary cases, existing example/property/model/schema evidence, and remaining inspected gaps."
        },
        {
          scenario: "A model test already checks the valid boundary and all invalid transitions without separate per-function examples.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Equivalent generative, model, schema, or exhaustive finite-case verification is accepted; no fixed example list is mandatory."
        },
        {
          scenario: "위반 사례: 명시된 inclusive endpoint에 대한 보장이 전체 검증 계획에서 누락돼 있다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "test/cover-concurrency-invariants",
    description: "동시성 위험으로 선언된 불변 조건에 대해 재현 가능한 스케줄·동기화·모델 기반 검증 근거가 있는지 확인합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability:
        "Code with shared invariants affected by concurrent or interleaved operations.",
      criteria: "동시성 위험으로 선언된 불변 조건에 대해 재현 가능한 스케줄·동기화·모델 기반 검증 근거가 있는지 확인합니다.\n\n몇 번의 스트레스 테스트나 sleep 기반 테스트 통과로 경쟁 상태의 부재를 증명할 수는 없습니다. 선언된 불변 조건에 맞는 재현 가능한 인터리빙·스케줄·모델 근거를 확인해야 하며 Promise의 교차 실행도 고려해야 합니다.\n\n중복 구별: async/synchronize-read-modify-write는 실제 경쟁 경로이고 테스트 증거 부족과 동일 결함으로 합치지 않는다",
      evidenceRequirements: [
        "The invariant, competing operations and schedulable interleaving, reproducible schedule/model evidence, and execution limits.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 경쟁 가능한 실행 모델 · 보존할 불변 조건 · interleaving·scheduler·model 검증"
      ],
      exceptions: [
        "Controlled schedules, barriers, and model checks are acceptable; passing stress or sleep-based tests does not prove race freedom.",
        "허용 사례: 결정적 scheduler/model 검증 또는 직렬 설계의 근거가 있다"
      ],
      procedure: [
        "수준: 절차·이력 확인",
        "환경: JS 테스트의 실제 runner/등록/assert helper/완료·격리 모델을 식별할 때 적용. TS 타입 테스트는 별도 검증 종류; 컴파일 성공과 런타임 행동 검증을 서로 대체하지 않음. Node test/Jest/Vitest/browser runner별 lifecycle·mock·timeout·실패 전파가 다르며 실제 버전이 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A required two-writer lost-update invariant is tested only by sleeps with no reproducible interleaving or equivalent evidence.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The invariant, competing operations and schedulable interleaving, reproducible schedule/model evidence, and execution limits."
        },
        {
          scenario: "A barrier-controlled test forces both async writers to read before either writes and checks the required invariant.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Controlled schedules, barriers, and model checks are acceptable; passing stress or sleep-based tests does not prove race freedom."
        },
        {
          scenario: "위반 사례: 중복 결제 방지 의무가 있는데 알려진 취약 interleaving을 검증하는 근거가 없다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "test/do-not-mock-away-integration-risk",
    description: "테스트가 검증한다고 선언한 연결·직렬화·프로토콜 경계를 모의화해 해당 위험의 관찰을 제거하는지 검토합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Tests intended to verify wiring, serialization, or protocol boundaries.",
      criteria: "테스트가 검증한다고 선언한 연결·직렬화·프로토콜 경계를 모의화해 해당 위험의 관찰을 제거하는지 검토합니다.\n\n연결 경계를 검증하겠다는 테스트가 그 경계를 항상 성공하는 mock으로 바꾸면 목적을 잃을 수 있습니다. 반면 단위 테스트가 네트워크를 mock하는 것은 정상적이므로 검증 목적 없이 mock 사용 자체를 위반으로 삼으면 안 됩니다.\n\n중복 구별: no-unintended-external-io와 반대라기보다 서로 다른 test kind 정책이다. 통합 위험을 본다고 운영 I/O를 강요하지 않는다",
      evidenceRequirements: [
        "The declared integration risk, real boundary, mock replacement, and which relevant failures the replacement makes unobservable.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 테스트가 주장하는 통합 경계 · mock 범위·행동 · 실제 관찰 대상과 보완 검증"
      ],
      exceptions: [
        "Unit tests may mock networks and external services when they do not claim to verify that integration risk.",
        "허용 사례: unit test는 network를 mock하고 다른 검증이 실제 protocol을 담당한다"
      ],
      procedure: [
        "수준: 선택적 설계 검토",
        "환경: JS 테스트의 실제 runner/등록/assert helper/완료·격리 모델을 식별할 때 적용. TS 타입 테스트는 별도 검증 종류; 컴파일 성공과 런타임 행동 검증을 서로 대체하지 않음. Node test/Jest/Vitest/browser runner별 lifecycle·mock·timeout·실패 전파가 다르며 실제 버전이 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A serialization compatibility test replaces the serializer with a mock that always returns success.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The declared integration risk, real boundary, mock replacement, and which relevant failures the replacement makes unobservable."
        },
        {
          scenario: "A unit policy test mocks transport, while a separate contract test exercises real serialization.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Unit tests may mock networks and external services when they do not claim to verify that integration risk."
        },
        {
          scenario: "위반 사례: SQL dialect 통합 테스트가 실제 쿼리/드라이버 동작을 항상 성공하는 mock으로 대체한다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "test/no-test-only-production-branches",
    description: "운영 업무 경로의 테스트 환경 분기가 실제 업무·보안 계약을 바꾸는지 검사하고, 명시적 계측·진단·주입 구성·비운영 테스트 지원은 허용합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Production code that branches on the test environment.",
      criteria: "운영 업무 경로의 테스트 환경 분기가 실제 업무·보안 계약을 바꾸는지 검사하고, 명시적 계측·진단·주입 구성·비운영 테스트 지원은 허용합니다.\n\n업무 함수 안에서 테스트 환경이면 권한을 생략하는 것과 조립 경계에서 테스트용 저장소를 주입하는 것은 다릅니다. 환경 이름의 존재가 아니라 업무·보안 계약 변경을 확인하고 같은 보안 우회를 중복 보고하지 않아야 합니다.\n\n중복 구별: security/controlled-security-bypasses는 실제 운영 활성화 위험도 다루고 이 규칙은 검증 대표성 문제도 포함한다",
      evidenceRequirements: [
        "Reachable production path, test-only branch, before/after authorization or business semantics, and deployment/injection boundaries.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 환경 분기의 실제 reachable build · 업무/보안 계약 · test 지원과 composition 역할"
      ],
      exceptions: [
        "Explicit instrumentation, diagnostics, composition-time dependency injection, and nonproduction test support are allowed.",
        "허용 사례: 조립 경계의 fake adapter 주입이나 계약을 바꾸지 않는 진단 계측"
      ],
      procedure: [
        "수준: 계약 근거 검사",
        "환경: JS 테스트의 실제 runner/등록/assert helper/완료·격리 모델을 식별할 때 적용. TS 타입 테스트는 별도 검증 종류; 컴파일 성공과 런타임 행동 검증을 서로 대체하지 않음. Node test/Jest/Vitest/browser runner별 lifecycle·mock·timeout·실패 전파가 다르며 실제 버전이 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A business function bypasses authorization whenever the environment name is test.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Reachable production path, test-only branch, before/after authorization or business semantics, and deployment/injection boundaries."
        },
        {
          scenario: "The composition root injects a test repository that preserves the business authorization contract.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Explicit instrumentation, diagnostics, composition-time dependency injection, and nonproduction test support are allowed."
        },
        {
          scenario: "위반 사례: 테스트 환경에서만 업무 함수의 권한·정합성 검사를 생략해 운영 계약과 다른 결과를 만든다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "test/no-fragile-internal-assertions",
    description: "검증 대상의 계약과 무관한 내부 구조·호출 순서에 대한 단언이 정당한 구현 변경을 불필요하게 막는지 검토하며, 내부 상호작용 자체가 계약인 경우는 허용합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Tests asserting internal structure, interactions, or call order.",
      criteria: "검증 대상의 계약과 무관한 내부 구조·호출 순서에 대한 단언이 정당한 구현 변경을 불필요하게 막는지 검토하며, 내부 상호작용 자체가 계약인 경우는 허용합니다.\n\n공개 결과를 올바르게 검사하는 테스트도 추가된 private 호출 순서 때문에 취약할 수 있습니다. 내부 결합을 독립적으로 평가하되 재시도 횟수·자원 해제 순서·프로토콜 순서처럼 상호작용 자체가 계약인 검증은 허용해야 합니다.\n\n중복 구별: assert-public-behavior가 이미 만족되어도 이 규칙만 해당할 수 있다. 독립 설정 유지가 필요하다",
      evidenceRequirements: [
        "The asserted internal interaction, the required contract, and a valid behavior-preserving implementation change rejected solely by that assertion.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 검증 대상 계약과 private implementation의 구분 · 추가 assertion · 정당한 refactor 반례"
      ],
      exceptions: [
        "Retry counts, resource cleanup order, protocol ordering, and other internal interactions that are the target contract are allowed.",
        "허용 사례: 정확한 retry 횟수·dispose 순서·handshake가 실제 계약이다"
      ],
      procedure: [
        "수준: 선택적 설계 검토",
        "환경: JS 테스트의 실제 runner/등록/assert helper/완료·격리 모델을 식별할 때 적용. TS 타입 테스트는 별도 검증 종류; 컴파일 성공과 런타임 행동 검증을 서로 대체하지 않음. Node test/Jest/Vitest/browser runner별 lifecycle·mock·timeout·실패 전파가 다르며 실제 버전이 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A test checks a private helper's incidental call order even though reversing those calls preserves every target obligation.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The asserted internal interaction, the required contract, and a valid behavior-preserving implementation change rejected solely by that assertion."
        },
        {
          scenario: "A protocol test asserts connect before send because the protocol explicitly requires that sequence.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Retry counts, resource cleanup order, protocol ordering, and other internal interactions that are the target contract are allowed."
        },
        {
          scenario: "위반 사례: 공개 결과를 검사하면서도 계약과 무관한 private 호출 순서가 바뀌면 실패한다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "test/meaningful-snapshot-scope",
    description: "스냅샷이 검증하려는 계약·안정성·검토 범위를 드러내는지 검토하고, 크기만으로 무의미하다고 판정하지 않습니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Tests that compare snapshots or golden artifacts.",
      criteria: "스냅샷이 검증하려는 계약·안정성·검토 범위를 드러내는지 검토하고, 크기만으로 무의미하다고 판정하지 않습니다.\n\n큰 API 스키마나 생성 결과의 골든 파일은 크더라도 의미 있는 계약 검증일 수 있습니다. 크기만으로 삭제를 권하지 말고 비결정적 값이 중요한 차이를 가리는지와 검토 목적·정규화 정책을 확인해야 합니다.\n\n중복 구별: assert-meaningful-outcomes는 검증 자체 존재/실행이고 snapshot의 리뷰 신호 품질은 별도 advisory다",
      evidenceRequirements: [
        "The intended artifact contract, review scope, normalization/stability policy, and important differences obscured by irrelevant churn.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: snapshot의 검증 목적·안정 필드·정규화 · 리뷰할 차이 · 실제 중요한 변경"
      ],
      exceptions: [
        "Large API schemas and generated golden files can be meaningful; size alone is never a violation.",
        "허용 사례: 큰 공개 schema golden file이 전체 호환성을 의도적으로 검사한다"
      ],
      procedure: [
        "수준: 선택적 설계 검토",
        "환경: JS 테스트의 실제 runner/등록/assert helper/완료·격리 모델을 식별할 때 적용. TS 타입 테스트는 별도 검증 종류; 컴파일 성공과 런타임 행동 검증을 서로 대체하지 않음. Node test/Jest/Vitest/browser runner별 lifecycle·mock·timeout·실패 전파가 다르며 실제 버전이 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A snapshot's uncontrolled timestamp churn hides the contract fields reviewers are expected to validate.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The intended artifact contract, review scope, normalization/stability policy, and important differences obscured by irrelevant churn."
        },
        {
          scenario: "A large normalized API-schema golden file makes every supported contract change reviewable.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Large API schemas and generated golden files can be meaningful; size alone is never a violation."
        },
        {
          scenario: "위반 사례: 무작위 ID/시간 차이가 목표 필드 변경을 가려 검토 목적을 무력화한다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
  {
    id: "test/regression-for-fixed-defects",
    description: "식별된 결함 수정의 원래 실패를 재현하고 수정 후 통과하는 검증 또는 동등한 회귀 방지 근거를 변경 이력과 연결합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Changes identified as fixes for known defects.",
      criteria: "식별된 결함 수정의 원래 실패를 재현하고 수정 후 통과하는 검증 또는 동등한 회귀 방지 근거를 변경 이력과 연결합니다.\n\n현재 소스만으로 어떤 변경이 과거 결함 수정인지 알 수 없으며 이미 존재한 검증을 CI에 연결하는 것만으로 재발 방지가 달성될 수도 있습니다. 실제 결함·이전 기준·재현 사례와 연결하고, 새 테스트 파일 유무만으로 판정하지 않아야 합니다.\n\n중복 구별: cover-failure-and-recovery는 모든 중요 실패 요구의 증거이고 이 규칙은 특정 과거 결함의 재현 연결을 요구한다",
      evidenceRequirements: [
        "The defect/history and original failure, affected contract, before/after reproduction or equivalent prevention evidence, and execution status.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 실제 결함 ID/원래 재현 · 수정 전후 기준 · 회귀 검증 또는 동등 방어 · 실행 증거"
      ],
      exceptions: [
        "Existing tests newly connected to CI, model verification, and equivalent regression barriers may satisfy the obligation without a new test file.",
        "허용 사례: 기존 failing test를 CI에 연결하거나 타입/외부 conformance 검증이 원래 결함을 막는다"
      ],
      procedure: [
        "수준: 절차·이력 확인",
        "환경: JS 테스트의 실제 runner/등록/assert helper/완료·격리 모델을 식별할 때 적용. TS 타입 테스트는 별도 검증 종류; 컴파일 성공과 런타임 행동 검증을 서로 대체하지 않음. Node test/Jest/Vitest/browser runner별 lifecycle·mock·timeout·실패 전파가 다르며 실제 버전이 필요",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A verified defect fix has no test or equivalent prevention evidence for its original failure despite the required regression policy.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The defect/history and original failure, affected contract, before/after reproduction or equivalent prevention evidence, and execution status."
        },
        {
          scenario: "An existing reproduction is added to required CI and demonstrated failing before the fix and passing afterward.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Existing tests newly connected to CI, model verification, and equivalent regression barriers may satisfy the obligation without a new test file."
        },
        {
          scenario: "위반 사례: 결함 수정이라 주장하지만 추가 검증이 수정 전에도 통과해 원래 실패를 잡지 못한다",
          expected: "violation",
          reason: "The stated target contract and the concrete counterexample must both be established; this example is not an executed engine test."
        }
      ]
    }),
  },
];
