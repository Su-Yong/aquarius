import type { LintRule } from "@aquarius/core";

// Section 24: 로깅·지표·운영 관측.
// Prompt definitions only. Registration does not enable rules or prove detection quality.
// Canonical source: https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad
export const section24Rules: LintRule[] = [
  {
    id: "observability/correlate-request-and-work",
    description: "요청과 파생·병합 작업의 인과관계를 허용된 식별자나 trace link로 연결하며, 작업 수명과 신뢰 경계에 맞는 맥락 전파를 사용합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "The project requires causal correlation across requests and derived, merged, batch, or long-lived work.",
      criteria: "요청과 파생·병합 작업의 인과관계를 허용된 식별자나 trace link로 연결하며, 작업 수명과 신뢰 경계에 맞는 맥락 전파를 사용합니다.\n\n동일 공통 ID만 강제하면 fan-in·batch·장기 job·외부 trust boundary에서 잘못된 추적과 개인정보 전파를 유도한다. trace link나 job correlation도 가능하다.",
      evidenceRequirements: [
        "The causal work graph, permitted identifiers/trace links, trust boundaries, lifetimes, and a lost or misleading relationship.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Trace links, job correlation, and fan-in links may replace one propagated ID; unrelated or prohibited personal context must not be copied."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A fan-in job is attributed solely to one unrelated request and loses the other required causal links.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The causal work graph, permitted identifiers/trace links, trust boundaries, lifetimes, and a lost or misleading relationship."
        },
        {
          scenario: "A batch uses approved trace links to all contributing operations without extending a request object's lifetime.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Trace links, job correlation, and fan-in links may replace one propagated ID; unrelated or prohibited personal context must not be copied."
        },
        {
          scenario: "The obligation or decisive runtime/path evidence for observability/correlate-request-and-work is unavailable, and the visible code alone does not establish it.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "observability/record-business-outcomes",
    description: "프로젝트의 중요한 업무 결과가 접수·확정·완료·거절 등 실제 의미에 맞게 관측되는지 확인합니다. 기존 이벤트·감사·지표 경로를 인정하고, 필요한 결과나 관측 책임이 미정·확인 불가하면 이를 공백으로 남깁니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "Important business outcomes and their observation responsibility are established by project policy.\n\n환경: try/catch·Promise 완료 단계·객체 serializer·전파 context를 포함. metric/event 타입은 실제 집계 시점·단위·실패 경로를 보장하지 않음. privacy consent·telemetry transport·render/main-thread 비용과 time origin을 고려. logger/stream·request/worker lifecycle·process clock·exporter·platform metric을 고려",
      criteria: "프로젝트의 중요한 업무 결과가 접수·확정·완료·거절 등 실제 의미에 맞게 관측되는지 확인합니다. 기존 이벤트·감사·지표 경로를 인정하고, 필요한 결과나 관측 책임이 미정·확인 불가하면 이를 공백으로 남깁니다.\n\n중요 결과와 계측 책임이 선언되지 않으면 누락을 증명할 수 없다. 모든 use case에 새 metric을 요구하지 않고 중앙 event/audit pipeline을 인정한다.\n\n보존할 의무: technical request 성공을 업무 성공으로 자동 동일시하지 않는다. privacy·volume 제한 때문에 최소한의 필요한 결과 구분까지 지우지 않는다.",
      evidenceRequirements: [
        "Required accepted/committed/completed/rejected meanings, authoritative transitions, existing event/audit/metric pipelines, and inspected gaps.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 중요 업무 흐름의 성공/거절/실패/접수/완료 의미 · 관측 책임과 기존 domain event·audit·metric pipeline · 실제 집계 범위·누락·중복 경로"
      ],
      exceptions: [
        "Central events, audit pipelines, and platform observations may satisfy the obligation without new per-use-case metrics.",
        "허용 사례: 중앙 domain event/audit pipeline이 결과를 정확히 제공한다. 모든 use-case 함수에 새 metric/log를 삽입할 필요는 없다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 정책·설계·도구 의무 확인",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A required payment-completed outcome is never observed in any inspected responsible pipeline.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Required accepted/committed/completed/rejected meanings, authoritative transitions, existing event/audit/metric pipelines, and inspected gaps."
        },
        {
          scenario: "An authoritative business event records completion through the existing audit pipeline without a new metric call.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Central events, audit pipelines, and platform observations may satisfy the obligation without new per-use-case metrics."
        },
        {
          scenario: "판단 불가: 핵심 결과의 정의나 기존 관측 owner를 못 찾았다. 임의 taxonomy를 만들지 않되 중요한 결과가 보이는지의 공백은 남긴다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "observability/preserve-async-context",
    description: "필요한 추적 맥락이 비동기·worker·메시지 경계를 올바른 수명과 격리 범위로 건너며, 무관한 요청의 맥락이 섞이지 않도록 합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "Required tracing context must cross actual async, worker, or message boundaries within an isolation/lifetime contract.",
      criteria: "필요한 추적 맥락이 비동기·worker·메시지 경계를 올바른 수명과 격리 범위로 건너며, 무관한 요청의 맥락이 섞이지 않도록 합니다.\n\nALS·SDK 자동 계측·explicit argument 모두 허용한다. custom callback과 worker 경계를 모델링하고 무조건 모든 context 전파나 request object 보존을 요구하지 않는다.\n\nA parent AsyncLocalStorage.run does not by itself prove context propagation to a worker. Verify the bridge and per-task scope; never treat untrusted tenant metadata as authorization.",
      evidenceRequirements: [
        "The context carrier and required fields, boundary propagation, owner lifetime, and cross-request leakage or missing required context.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "AsyncLocalStorage, SDK auto-instrumentation, explicit arguments, and supported message metadata are equivalent valid mechanisms."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A reused worker attaches the previous request's context to a new unrelated task.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The context carrier and required fields, boundary propagation, owner lifetime, and cross-request leakage or missing required context."
        },
        {
          scenario: "A worker receives only the allowed correlation context for each task and clears it afterward.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. AsyncLocalStorage, SDK auto-instrumentation, explicit arguments, and supported message metadata are equivalent valid mechanisms."
        },
        {
          scenario: "The obligation or decisive runtime/path evidence for observability/preserve-async-context is unavailable, and the visible code alone does not establish it.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "observability/bounded-metric-cardinality",
    description: "사용자별·요청별 값 때문에 지표의 조합 수가 무제한 늘어나지 않도록 합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "Metric label combinations and lifetime must fit a known finite resource/cardinality budget.",
      criteria: "사용자별·요청별 값 때문에 지표의 조합 수가 무제한 늘어나지 않도록 합니다.\n\n유한 예산이 실제 label 조합과 수명에 맞는지 검사한다. 임의의 전역 100개 한도를 강제하지 않는다. 민감성 규칙과는 독립이다.",
      evidenceRequirements: [
        "The label value domains, actual combinations and retention, exporter/backend budget, and reachable growth path.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Bounded domains within the actual budget are allowed; no arbitrary universal cardinality number is imposed."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "An unbounded request ID is used as a metric label and exceeds the declared series budget.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The label value domains, actual combinations and retention, exporter/backend budget, and reachable growth path."
        },
        {
          scenario: "Finite status and operation labels remain within the measured and declared cardinality budget.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Bounded domains within the actual budget are allowed; no arbitrary universal cardinality number is imposed."
        },
        {
          scenario: "The obligation or decisive runtime/path evidence for observability/bounded-metric-cardinality is unavailable, and the visible code alone does not establish it.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "observability/separate-attempts-and-operations",
    description: "지표·span이 논리 업무 수인지 실제 전송·재시도 시도 수인지 구분하고, 논리 업무 지표가 시도 횟수만큼 중복 증가하지 않도록 합니다. 필요한 구분이 충족되면 두 종류의 계측을 모두 새로 만들도록 강제하지 않습니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "Metrics/spans have a declared logical-operation or physical-attempt counting unit.\n\n환경: try/catch·Promise 완료 단계·객체 serializer·전파 context를 포함. metric/event 타입은 실제 집계 시점·단위·실패 경로를 보장하지 않음. privacy consent·telemetry transport·render/main-thread 비용과 time origin을 고려. logger/stream·request/worker lifecycle·process clock·exporter·platform metric을 고려",
      criteria: "지표·span이 논리 업무 수인지 실제 전송·재시도 시도 수인지 구분하고, 논리 업무 지표가 시도 횟수만큼 중복 증가하지 않도록 합니다. 필요한 구분이 충족되면 두 종류의 계측을 모두 새로 만들도록 강제하지 않습니다.\n\nattempt_total과 operation_total은 서로 다른 집계다. attempt metric 존재 자체를 경고하지 않고 이름·단위·metric contract와 increment 경로를 비교한다.\n\n보존할 의무: 둘을 혼동하지 않는 의무 유지. 모든 client가 logical+attempt span을 동시에 생성하도록 강제하면 표준 계측의 중복을 만들 수 있다.",
      evidenceRequirements: [
        "The instrument name and unit, retry boundaries, increment paths, logical-operation identity, and duplicate counting.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: metric/span의 측정 단위와 logical operation identity · retry/redirect/auth challenge의 횟수와 instrumentation 방식 · 중앙 집계/중복 제거 규칙"
      ],
      exceptions: [
        "Attempt metrics may legitimately increment on every retry; satisfying the declared unit does not require adding both metric kinds.",
        "허용 사례: 명시된 attempt metric이3을 기록하고 logical metric이1을 기록한다. 또는 선택한 표준 instrumentation이 attempt만 제공하며 operation count로 잘못 해석하지 않는다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 명세·공식 구현 의미 확인",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A logical operation total increments three times for one operation that retries twice.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The instrument name and unit, retry boundaries, increment paths, logical-operation identity, and duplicate counting."
        },
        {
          scenario: "An attempt total counts each transport call while an existing operation total counts completion once.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Attempt metrics may legitimately increment on every retry; satisfying the declared unit does not require adding both metric kinds."
        },
        {
          scenario: "판단 불가: request_total이라는 이름만 있고 physical/logical 단위가 없다. 이름만으로 결함을 확정하지 말고 metric contract gap을 표시한다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "observability/no-premature-success-metrics",
    description: "각 지표가 선언한 접수·시도·저장 확정·업무 완료 단계보다 앞서 그 단계의 성공을 집계하지 않도록 합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "A success instrument claims a specific accepted, attempted, committed, or completed stage.\n\n환경: try/catch·Promise 완료 단계·객체 serializer·전파 context를 포함. metric/event 타입은 실제 집계 시점·단위·실패 경로를 보장하지 않음. privacy consent·telemetry transport·render/main-thread 비용과 time origin을 고려. logger/stream·request/worker lifecycle·process clock·exporter·platform metric을 고려",
      criteria: "각 지표가 선언한 접수·시도·저장 확정·업무 완료 단계보다 앞서 그 단계의 성공을 집계하지 않도록 합니다.\n\nqueued/accepted의 성공과 업무 완료의 성공을 혼동하지 말아야 한다. 모든 성공 계측을 DB commit 뒤로 옮기는 수정은 전송·접수 지표를 왜곡한다.\n\n보존할 의무: 그 단계가 아직 확정되지 않았는데 확정 성공이라고 집계하면 안 된다. later failure를 성공으로 포장하는 fallback도 허용되지 않는다.",
      evidenceRequirements: [
        "The metric's declared stage, instrument location, authoritative transition, and a later failure that contradicts the reported stage.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 각 지표/이벤트의 완료 단계와 commit/ack 의미 · try/catch/transaction/queue enqueue의 시점 · rollback·timeout·partial failure에서의 counter 변화"
      ],
      exceptions: [
        "Acceptance/queueing success may be recorded before business completion when explicitly named and defined that way.",
        "허용 사례: accepted_total은 durable enqueue 직후 증가하고 completed_total은 실제 업무 완료 뒤 증가한다. 모두를 최종 commit 뒤로 옮기지 않는다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 정책·설계·도구 의무 확인",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A committed-write success counter increments before a database commit that can still fail.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The metric's declared stage, instrument location, authoritative transition, and a later failure that contradicts the reported stage."
        },
        {
          scenario: "An accepted-job counter increments on accepted enqueue, while completion has separate defined semantics.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Acceptance/queueing success may be recorded before business completion when explicitly named and defined that way."
        },
        {
          scenario: "판단 불가: success의 scope가 enqueue/request/업무 중 무엇인지 불명확하다. stage 결정을 임의로 하거나 통과시키지 않는다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "observability/actionable-error-context",
    description: "오류 진단에 필요한 작업·단계·원인 연결이 승인된 관측 경계에서 확보되는지 확인하고 민감한 전체 객체를 관성적으로 추가하지 않습니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "An error has a defined diagnostic need for operation, phase, or causal context at an approved observation boundary.\n\n환경: try/catch·Promise 완료 단계·객체 serializer·전파 context를 포함. metric/event 타입은 실제 집계 시점·단위·실패 경로를 보장하지 않음. privacy consent·telemetry transport·render/main-thread 비용과 time origin을 고려. logger/stream·request/worker lifecycle·process clock·exporter·platform metric을 고려",
      criteria: "오류 진단에 필요한 작업·단계·원인 연결이 승인된 관측 경계에서 확보되는지 확인하고 민감한 전체 객체를 관성적으로 추가하지 않습니다.\n\n정보가 더 많을수록 좋은 것은 아니다. 기존 상위 span·Error.cause로 충분할 수 있고 full request 추가는 노출 위험이다. 원인·작업·단계가 필요한지 사건별로 증명한다.\n\n보존할 의무: 진단을 위해 token/full body를 추가하지 않는다. context는 안전한 구조와 기존 연결로 확보하되 실제 원인을 지우지 않는다.",
      evidenceRequirements: [
        "The diagnostic obligation, existing spans/causes and correlation, missing meaningful context, and redaction/access policy.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: operator가 진단할 작업·단계·원인 연결 요구 · 상위 span·Error.cause·correlation으로 이미 제공되는 context · 노출 금지 field와 실제 serializer"
      ],
      exceptions: [
        "Existing parent spans and Error.cause can suffice; full request or sensitive object logging is not required.",
        "허용 사례: 상위 span/cause가 필요한 문맥을 보존해 낮은 계층이 추가 payload를 log하지 않는다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 정책·설계·도구 의무 확인",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "An error loses its required causal chain and operation identity across the only approved diagnostic boundary.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The diagnostic obligation, existing spans/causes and correlation, missing meaningful context, and redaction/access policy."
        },
        {
          scenario: "A linked span and Error.cause expose the required operation and cause without logging sensitive payloads.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Existing parent spans and Error.cause can suffice; full request or sensitive object logging is not required."
        },
        {
          scenario: "판단 불가: 외부 log platform의 enrichment/correlation을 못 읽었다. 로컬 문자열만 보고 정보 부족이라고 단정하지 않는다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "observability/log-at-owning-boundary",
    description: "동일 목적의 같은 장애 기록이 여러 경계에서 중복 집계되지 않도록 책임과 상관관계를 정하되, 별도 감사·span·복구 기록은 목적에 맞게 유지합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "Multiple layers record the same failure for the same observation and counting purpose.\n\n환경: try/catch·Promise 완료 단계·객체 serializer·전파 context를 포함. metric/event 타입은 실제 집계 시점·단위·실패 경로를 보장하지 않음. privacy consent·telemetry transport·render/main-thread 비용과 time origin을 고려. logger/stream·request/worker lifecycle·process clock·exporter·platform metric을 고려",
      criteria: "동일 목적의 같은 장애 기록이 여러 경계에서 중복 집계되지 않도록 책임과 상관관계를 정하되, 별도 감사·span·복구 기록은 목적에 맞게 유지합니다.\n\n중첩 span의 오류 기록, audit와 운영 로그는 동일 메시지라도 목적이 다를 수 있다. 같은 장애를 중복 집계하는 동일 목적의 기록만 대상이다.\n\n보존할 의무: 필수 audit·책임 있는 복구 기록을 중복 소음이라는 이유로 삭제하지 않는다. 실제 동일 목적의 과대 집계는 보존하지 않는다.",
      evidenceRequirements: [
        "Failure identity and correlation, record purposes, ownership boundary, aggregation path, and duplicate counting.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 동일 error identity/cause와 각 로그의 목적 · incident 집계·alert dedup key와 span nesting · 각 boundary의 복구/변환 책임 · 계측/semconv version·OTEL_SEMCONV_EXCEPTION_SIGNAL_OPT_IN·migration window 및 실제 backend 중복 집계 정책"
      ],
      exceptions: [
        "Separate audit, nested span, recovery, and debug records with distinct purposes may remain.",
        "허용 사례: 같은 오류가 필요한 span별 status와 보안 audit/운영 기록에 각기 다른 목적으로 남는다. 모두 하나만 남기라는 규칙은 부적절하다. 현재 OpenTelemetry가 명시한 logs/dup 이전 모드의 dual emission도 근거 있는 예외다. 같은 예외의 두 신호 존재와 잘못된 장애 이중 집계는 구분한다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 명세·공식 구현 의미 확인",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "One failure is logged as a new operational incident at three layers and counted three times.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Failure identity and correlation, record purposes, ownership boundary, aggregation path, and duplicate counting."
        },
        {
          scenario: "An audit event and a correlated recovery span coexist because they serve distinct declared purposes.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Separate audit, nested span, recovery, and debug records with distinct purposes may remain."
        },
        {
          scenario: "판단 불가: backend dedup 또는 각각의 소비 목적을 모른다. message text가 같다는 이유로 중복이라고 확정하지 않는다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "observability/separate-audit-debug-logs",
    description: "업무 감사 기록과 개발용 진단 로그의 목적·보존·접근 정책을 구분합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "Audit and debug records have different required integrity, retention, availability, or access policies.\n\n환경: try/catch·Promise 완료 단계·객체 serializer·전파 context를 포함. metric/event 타입은 실제 집계 시점·단위·실패 경로를 보장하지 않음. privacy consent·telemetry transport·render/main-thread 비용과 time origin을 고려. logger/stream·request/worker lifecycle·process clock·exporter·platform metric을 고려",
      criteria: "업무 감사 기록과 개발용 진단 로그의 목적·보존·접근 정책을 구분합니다.\n\n물리 파일 분리보다 필수성·무결성·보존·접근 정책의 구분이 핵심이다. audit를 일반 telemetry 실패 처리와 섞지 않는다.\n\n보존할 의무: 필수 감사의 기록·보존·접근 통제를 noncritical telemetry로 임의 downgrade하지 않는다. 물리 file 분리를 보편 요구하지 않는다.",
      evidenceRequirements: [
        "Record classification, required policy differences, storage/export/access handling, and a concrete conflation.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: audit/debug의 필요성·무결성·보존·접근 요구 · 실제 sink routing·filter/sampling·rotation · audit 실패가 업무에 미치는 계약"
      ],
      exceptions: [
        "Separate logical policies within one physical store can suffice; separate files are not mandatory.",
        "허용 사례: 같은 물리 backend라도 event classification·접근·보존·무결성 정책이 필요한 의무를 충족한다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 정책·설계·도구 의무 확인",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "Required audit records are dropped by the same sampling policy as optional debug output.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Record classification, required policy differences, storage/export/access handling, and a concrete conflation."
        },
        {
          scenario: "A shared logging system applies distinct integrity, retention, and access rules to audit records.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Separate logical policies within one physical store can suffice; separate files are not mandatory."
        },
        {
          scenario: "판단 불가: 파일은 분리돼 있지만 collector/backend 정책을 모른다. 파일 분리만으로 정책 분리가 완료됐다고 하지 않는다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "observability/bounded-log-volume",
    description: "반복 실패나 대량 처리에서 로그 출력이 처리 자원을 압도하지 않도록 합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "Input volume or repeated failures can produce logs that must remain within an execution/resource budget.\n\n환경: try/catch·Promise 완료 단계·객체 serializer·전파 context를 포함. metric/event 타입은 실제 집계 시점·단위·실패 경로를 보장하지 않음. privacy consent·telemetry transport·render/main-thread 비용과 time origin을 고려. logger/stream·request/worker lifecycle·process clock·exporter·platform metric을 고려",
      criteria: "반복 실패나 대량 처리에서 로그 출력이 처리 자원을 압도하지 않도록 합니다.\n\n입력 의존 로그와 재시도 폭주가 유한 자원 예산을 넘지 않도록 한다. 반드시 남겨야 하는 감사 기록에는 무조건 sampling/drop을 제안하지 않는다.\n\n보존할 의무: volume 제한은 필수 보안 기록 삭제 허가가 아니다. 적절한 backpressure/overflow/내구성 정책으로 업무와 감사 의무를 함께 보존한다.",
      evidenceRequirements: [
        "The amplification path, rate/size and retry/loop behavior, effective limits, resource budget, and required audit constraints.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 입력·retry·loop에 따른 log event/byte 비용 · stdout/transport의 실제 sync/async·buffer/backpressure · 필수 audit와 drop/sample 허용 정책"
      ],
      exceptions: [
        "Approved aggregation/sampling/rate limits may satisfy optional logging needs; mandatory audit records cannot be indiscriminately dropped.",
        "허용 사례: 필요 event를 집계/적절히 sample하면서 필수 audit는 별도 내구 경로로 보존하고 producer 속도를 제한한다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 정책·설계·도구 의무 확인",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A retry loop logs full large payloads without an effective bound and exhausts the declared processing budget.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The amplification path, rate/size and retry/loop behavior, effective limits, resource budget, and required audit constraints."
        },
        {
          scenario: "Bounded diagnostic sampling controls repeated failures while mandatory audit records use their required reliable path.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Approved aggregation/sampling/rate limits may satisfy optional logging needs; mandatory audit records cannot be indiscriminately dropped."
        },
        {
          scenario: "판단 불가: console 함수만 보이며 OS·destination·transport buffering을 모른다. 모든 console을 sync 또는 nonblocking이라고 단정하지 않는다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "observability/expose-queue-pool-pressure",
    description: "대기열·연결 풀·worker의 포화와 지연을 진단하는 데 필요한 신호가 앱 또는 플랫폼에서 제공되는지 확인합니다. 중요한 자원의 관측 요구나 보장이 미정·확인 불가하면 이를 공백으로 남기며 자체 지표 구현을 일률적으로 강제하지 않습니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "An important queue, connection pool, or worker has an established operational saturation/latency observation requirement.\n\n환경: try/catch·Promise 완료 단계·객체 serializer·전파 context를 포함. metric/event 타입은 실제 집계 시점·단위·실패 경로를 보장하지 않음. privacy consent·telemetry transport·render/main-thread 비용과 time origin을 고려. logger/stream·request/worker lifecycle·process clock·exporter·platform metric을 고려",
      criteria: "대기열·연결 풀·worker의 포화와 지연을 진단하는 데 필요한 신호가 앱 또는 플랫폼에서 제공되는지 확인합니다. 중요한 자원의 관측 요구나 보장이 미정·확인 불가하면 이를 공백으로 남기며 자체 지표 구현을 일률적으로 강제하지 않습니다.\n\n무슨 포화 신호가 필요한지는 SLO·운영 책임과 플랫폼 계측 여부에 달린다. 소스에 metrics call이 없다는 이유로 위반이라고 할 수 없다.\n\n보존할 의무: 운영 요구 미정이 포화 위험을 무해하게 만드는 것은 아니다. 알려진 critical shared resource의 가시성 공백을 묻고 추적한다.",
      evidenceRequirements: [
        "The resource and SLO/owner, required saturation/wait signals, app/platform guarantees, and unavailable or unverified coverage.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 관측해야 할 shared queue/pool·용량·대기 시간/거절 정책 · platform/exporter가 이미 제공하는 saturation 신호 · 운영자가 결정을 내릴 수 있는 signal owner"
      ],
      exceptions: [
        "Platform-provided instrumentation or equivalent signals may suffice without custom application metric calls.",
        "허용 사례: broker/platform metric이나 latency/rejection 지표가 필요한 포화 정보를 제공한다. 모든 큐에 자체 gauge를 추가할 필요는 없다."
      ],
      procedure: [
        "수준: 선택적 설계 검토 · 정책·설계·도구 의무 확인",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A critical queue's required wait-time signal is absent from both inspected application and platform monitoring.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The resource and SLO/owner, required saturation/wait signals, app/platform guarantees, and unavailable or unverified coverage."
        },
        {
          scenario: "The managed queue platform already provides the required saturation and latency signals.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Platform-provided instrumentation or equivalent signals may suffice without custom application metric calls."
        },
        {
          scenario: "판단 불가: 실제 운영 신호나 요구가 보이지 않는다. source metric call 부재로 결함을 확정하지 않고 중요한 자원의 관측 공백을 요약한다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "observability/surface-degraded-mode",
    description: "대체 경로나 축소 기능으로 동작 중인 상태가 정상 동작으로만 보이지 않도록 합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "Fallback or reduced-function operation must be distinguishable from full normal operation under the operational contract.\n\n환경: try/catch·Promise 완료 단계·객체 serializer·전파 context를 포함. metric/event 타입은 실제 집계 시점·단위·실패 경로를 보장하지 않음. privacy consent·telemetry transport·render/main-thread 비용과 time origin을 고려. logger/stream·request/worker lifecycle·process clock·exporter·platform metric을 고려",
      criteria: "대체 경로나 축소 기능으로 동작 중인 상태가 정상 동작으로만 보이지 않도록 합니다.\n\n축소 기능 계약과 실제 운영 가시성의 연결이다. degradation 자체의 옳고 그름은 distributed 규칙이고 여기서는 정상과 혼동되는 관측을 다룬다.\n\n보존할 의무: 실제 계약상 축소/기능 상실을 정상으로 위장하지 않는다. 모든 fallback을 실패로 바꾸거나 허용된 결과를 버리는 수정은 하지 않는다.",
      evidenceRequirements: [
        "The degraded transition, lost capability, observable status/metric/event path, and audience/lifetime of the signal.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 허용 fallback/degraded 동작과 정상 결과의 차이 · 사용자/운영자에게 보여야 할 상태·metric · fallback 진입·복구·반복 실패 경로"
      ],
      exceptions: [
        "Existing health/status/feature signals may satisfy the requirement without duplicate instrumentation.",
        "허용 사례: 축소 상태를 적절한 signal로 구별하며 내부 알고리즘의 무의미한 구현 대안은 사용자에게 매번 노출하지 않는다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 정책·설계·도구 의무 확인",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A service silently serves stale fallback data while its required operational status still reports full functionality.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The degraded transition, lost capability, observable status/metric/event path, and audience/lifetime of the signal."
        },
        {
          scenario: "A fallback mode is exposed through the existing approved degraded-health signal.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Existing health/status/feature signals may satisfy the requirement without duplicate instrumentation."
        },
        {
          scenario: "판단 불가: 해당 대체 경로가 실제 사용자 의미를 낮추는지 계약을 모른다. branch 존재만으로 degraded라고 명명하지 않는다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "observability/account-for-partial-success",
    description: "배치나 병렬 처리의 일부 성공·일부 실패를 분리해 기록합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "Batch or parallel work can partly succeed and observation must preserve completed/failed scope and denominators.\n\n환경: try/catch·Promise 완료 단계·객체 serializer·전파 context를 포함. metric/event 타입은 실제 집계 시점·단위·실패 경로를 보장하지 않음. privacy consent·telemetry transport·render/main-thread 비용과 time origin을 고려. logger/stream·request/worker lifecycle·process clock·exporter·platform metric을 고려",
      criteria: "배치나 병렬 처리의 일부 성공·일부 실패를 분리해 기록합니다.\n\nerror/explicit-partial-failure는 호출자 결과, 이 규칙은 관측 분모·완료 범위다. 하나를 지켜도 다른 하나를 어길 수 있으므로 통합 삭제하지 않는다.\n\n보존할 의무: 부분 완료를 모두 성공/모두 미실행으로 평탄화하지 않는다. 모든 item ID를 metric label로 넣어 privacy/cardinality를 깨뜨리지 않는다.",
      evidenceRequirements: [
        "Per-item or grouped outcomes, aggregate counters/records, denominator, retries, and a misleading all-or-nothing record.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: batch 단위와 item 단위의 성공/실패/취소/미시도 의미 · aggregator/Promise 결과와 실제 side effect · 지표 분모·처리 완료 기준"
      ],
      exceptions: [
        "Aggregate records can be sufficient if they preserve required partial-outcome counts and identities.",
        "허용 사례: 정의된 batch status와 item 결과를 필요한 수준으로 구분하며 원자적 all-or-nothing 계약은 전체 실패로 정확히 처리한다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 정책·설계·도구 의무 확인",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A batch with 8 successes and 2 failures is recorded as 10 completed successes.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Per-item or grouped outcomes, aggregate counters/records, denominator, retries, and a misleading all-or-nothing record."
        },
        {
          scenario: "One batch record retains 8 successful and 2 failed items with the correct denominator.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Aggregate records can be sufficient if they preserve required partial-outcome counts and identities."
        },
        {
          scenario: "판단 불가: Promise rejection 뒤 다른 작업이 실제로 완료됐는지/취소됐는지 모른다. fail-fast 결과만으로 모두 실패했다고 단정하지 않는다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "observability/isolate-noncritical-telemetry-failures",
    description: "필수 감사 기록이 아닌 일반 관측 실패가 업무 처리를 불필요하게 중단하지 않도록 합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "An optional telemetry exporter or observation path can fail independently from business work.",
      criteria: "필수 감사 기록이 아닌 일반 관측 실패가 업무 처리를 불필요하게 중단하지 않도록 합니다.\n\n원문이 필수 감사 예외를 이미 구분한다. exporter 장애를 무시하되 관측 시스템 자체의 실패 신호를 남길 수 있어야 한다. 모든 catch를 swallow로 경고하지 않는다.",
      evidenceRequirements: [
        "Telemetry criticality, exporter failure behavior, business completion path, and the contract for reporting telemetry degradation.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Mandatory audit obligations may intentionally fail closed; they are not optional telemetry."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "An optional metrics exporter outage throws through and aborts an otherwise valid business operation.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Telemetry criticality, exporter failure behavior, business completion path, and the contract for reporting telemetry degradation."
        },
        {
          scenario: "An optional exporter failure is isolated and surfaced as telemetry degradation without aborting business work.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Mandatory audit obligations may intentionally fail closed; they are not optional telemetry."
        },
        {
          scenario: "The obligation or decisive runtime/path evidence for observability/isolate-noncritical-telemetry-failures is unavailable, and the visible code alone does not establish it.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "observability/consistent-duration-measurement",
    description: "측정 목적에 맞는 시계·단위·시작과 종료 경계를 사용하고, 다른 시간 기준·호스트의 값을 비교할 때 기준 정렬과 동기화 오차를 확인합니다. 업무 시각과 경과 시간을 혼동하지 않습니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "A duration, timestamp, or business-time measurement has a defined purpose, unit, and start/end boundary.\n\n환경: try/catch·Promise 완료 단계·객체 serializer·전파 context를 포함. metric/event 타입은 실제 집계 시점·단위·실패 경로를 보장하지 않음. privacy consent·telemetry transport·render/main-thread 비용과 time origin을 고려. logger/stream·request/worker lifecycle·process clock·exporter·platform metric을 고려",
      criteria: "측정 목적에 맞는 시계·단위·시작과 종료 경계를 사용하고, 다른 시간 기준·호스트의 값을 비교할 때 기준 정렬과 동기화 오차를 확인합니다. 업무 시각과 경과 시간을 혼동하지 않습니다.\n\n같은 프로세스 내 경과 시간에는 monotonic clock이 적절하지만 분산 로그 timestamp나 업무 시각을 전부 바꾸면 안 된다. 단위·시작/종료·중첩 포함 기준을 분리한다.\n\n보존할 의무: duration의 단위·시작/종료·clock 의미는 보존한다. 다른 host라는 이유만으로 명시된 동기화/오차 모델의 모든 비교까지 금지하지 않는다.",
      evidenceRequirements: [
        "Clock source, units, start/end semantics, included intervals, and cross-host alignment/synchronization error if compared.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 측정 목적·단위·start/end·포함 작업 scope · clock 종류와 time origin/context/host · clock 동기화·coarsening·uncertainty budget"
      ],
      exceptions: [
        "Wall-clock business timestamps and distributed logs need not use a local monotonic clock; measurement purpose determines the correct basis.",
        "허용 사례: 같은 clock domain의 monotonic elapsed 또는 명시적으로 origin을 맞추고 오차를 고려한 분산 시간 추정. 업무 일시는 wall-clock일 수 있다."
      ],
      procedure: [
        "수준: 명세·실행 의미 검사 · 명세·공식 구현 의미 확인",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "An elapsed-duration calculation mixes seconds with milliseconds or incompatible host clock bases.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Clock source, units, start/end semantics, included intervals, and cross-host alignment/synchronization error if compared."
        },
        {
          scenario: "A local elapsed duration uses a monotonic clock while business timestamps retain their required wall-clock basis.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Wall-clock business timestamps and distributed logs need not use a local monotonic clock; measurement purpose determines the correct basis."
        },
        {
          scenario: "판단 불가: timestamp의 clock domain과 정밀도/동기화 오차를 모른다. ms 숫자라는 이유로 서로 뺄 수 있다고 하지 않는다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
];
