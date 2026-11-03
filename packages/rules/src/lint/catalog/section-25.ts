import type { LintRule } from "@aquarius/core";

// Section 25: 성능과 알고리즘.
// Prompt definitions only. Registration does not enable rules or prove detection quality.
// Canonical source: https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad
export const section25Rules: LintRule[] = [
  {
    id: "performance/evidence-based-optimization",
    description: "사용자 코드나 변경에 도입된 복잡한 최적화가 실제 입력 규모·실행 빈도·비용 또는 성능 요구로 정당화되는지 검토하고, 근거가 불충분하면 결함으로 단정하지 않고 선택과 비용을 설명합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "User code or a change introduces a complex optimization whose benefit and cost can be reviewed against actual workload or performance requirements.\n\n환경: 자료구조·동등성·작업량·메모리·job 진행의 실행 의미가 우선. typecheck 성공은 실행 비용이나 host 진행 보장의 증거가 아님. main thread와 worker·microtask/task·render 예산을 구분. event loop·worker pool·worker thread·CLI/startup·serverless 수명을 구분",
      criteria: "사용자 코드나 변경에 도입된 복잡한 최적화가 실제 입력 규모·실행 빈도·비용 또는 성능 요구로 정당화되는지 검토하고, 근거가 불충분하면 결함으로 단정하지 않고 선택과 비용을 설명합니다.\n\n기존 사용자 코드나 변경에 도입된 복잡한 최적화의 정당성을 검토하는 규칙이다. 분석기 자신의 보고 근거인 agentlint/require-evidence와 대상이 다르므로 독립 ID를 유지한다. 측정 자료 부재만으로 위반을 단정하지 않는다.\n\n보존할 의무: 분석기 자신이 근거를 제시해야 한다는 meta rule로 옮겨 기존 사용자 코드 검토를 없애지 않는다. 알려진 unbounded 고장 경로를 profiling 부재로 숨기지 않는다.",
      evidenceRequirements: [
        "The introduced complexity, input sizes/frequency/cost or performance requirement, measured/analytical benefit, and maintenance tradeoffs.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 기존/변경 코드가 도입한 복잡성과 원래 요구 · 입력 규모·빈도·latency/memory 목표·cost model 또는 대표 profile · 대안의 의미/운영 비용"
      ],
      exceptions: [
        "A missing benchmark alone is not a defect; sufficient analytical evidence may justify a choice, otherwise present an optional review with uncertainty.",
        "허용 사례: 명백한 입력 의존 비용 또는 측정/요구가 있어 최적화 복잡성을 감수하는 의도가 확인된다. 숫자 benchmark가 없다는 이유만으로 금지하지 않는다."
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
          scenario: "A complex cache/worker graph increases maintenance and failure paths for a verified small bounded workload, but no explicit correctness or performance contract is violated.",
          expected: "unknown",
          reason: "This supports an optional design review, not a confirmed code defect. Explain the evidenced costs and uncertain benefit without converting the review into a violation."
        },
        {
          scenario: "An optimization has measured or analytical benefit at the actual workload while preserving the supported contract.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. A missing benchmark alone is not a defect; sufficient analytical evidence may justify a choice, otherwise present an optional review with uncertainty."
        },
        {
          scenario: "판단 불가: workload·설계 이유가 없다. 불필요한 최적화라고 확정하지 않고 근거/비용의 비교를 요청한다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "performance/bound-input-dependent-work",
    description: "외부 입력의 크기·깊이·형태·빈도가 선언된 계산·메모리·실행 시간 및 실제 런타임의 호출 스택·깊이 한도를 넘길 수 있는 경로를 검사합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "External input size, depth, shape, or frequency can consume a declared compute, memory, time, stack, or depth budget.\n\n환경: 자료구조·동등성·작업량·메모리·job 진행의 실행 의미가 우선. typecheck 성공은 실행 비용이나 host 진행 보장의 증거가 아님. main thread와 worker·microtask/task·render 예산을 구분. event loop·worker pool·worker thread·CLI/startup·serverless 수명을 구분",
      criteria: "외부 입력의 크기·깊이·형태·빈도가 선언된 계산·메모리·실행 시간 및 실제 런타임의 호출 스택·깊이 한도를 넘길 수 있는 경로를 검사합니다.\n\n외부 입력 의존성 자체는 정상이다. 허용 크기·비용·공유 실행 자원에 대한 초과 경로가 근거여야 하고 regex·압축·parser 비용도 포함한다. 재귀 특수화를 통합하려면 실제 런타임 호출 스택·깊이 한도도 이 대상 계약에 포함해야 한다.\n\n보존할 의무: 어떤 숫자든 limit이 있으면 안전이라는 판정 금지. 반대로 수치 예산이 미정이라고 명백한 unbounded 위험을 숨기지 않는다.",
      evidenceRequirements: [
        "Input reachability and effective limits, growth/cost model including parser/regex/decompression, actual runtime limits, and a budget-exceeding input.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 외부 입력이 제어하는 size/depth/shape/frequency · 계산·memory·stack·shared execution resource의 실제 한도 · 조기 제한/분할·중단 및 limit 값의 실효성"
      ],
      exceptions: [
        "Input-dependent work within proven bounds is valid; an async API or finite input alone is not a resource bound.",
        "허용 사례: 선언된 workload에 충분하고 실제 경로에 적용되는 제한/분할이 있으며 고정된 작은 계산은 공유 자원 예산 안에 있다."
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
          scenario: "An allowed compressed input expands into work beyond the declared memory/time budget with no effective admission limit.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Input reachability and effective limits, growth/cost model including parser/regex/decompression, actual runtime limits, and a budget-exceeding input."
        },
        {
          scenario: "Input size and decompression work are effectively limited within the documented runtime budget.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Input-dependent work within proven bounds is valid; an async API or finite input alone is not a resource bound."
        },
        {
          scenario: "판단 불가: 최대 입력·runtime budget을 모른다. 무제한 증가 구조는 위험으로 남기되 정확한 장애 threshold를 만들어내지 않는다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "performance/no-repeated-linear-lookups",
    description: "반복 조회의 규모와 비용 근거가 있을 때 대안 자료구조를 제안하되, 비교 방식·중복 선택·순서·변경 및 부작용 계약이 보존되는지 확인합니다.",
    scope: "module",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "Repeated linear lookups have meaningful workload/cost evidence and an alternative can preserve lookup semantics.",
      criteria: "반복 조회의 규모와 비용 근거가 있을 때 대안 자료구조를 제안하되, 비교 방식·중복 선택·순서·변경 및 부작용 계약이 보존되는지 확인합니다.\n\n고정된 작은 목록에는 Map 구축이 더 비싸다. NaN 동등성·첫/마지막 중복·객체 identity·key 정규화·callback 부작용이 바뀔 수 있어 자동 치환하면 안 된다.",
      evidenceRequirements: [
        "Collection/query scale and measured/analytical cost, equality rules, duplicate selection, order, mutation, and callback side effects.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Small fixed collections may be cheaper; Map/Set conversion is not required and cannot silently change NaN, identity, duplicates, or effects."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A large verified workload repeatedly scans a list above its stated budget and a proven equivalent indexed lookup meets the same contract.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Collection/query scale and measured/analytical cost, equality rules, duplicate selection, order, mutation, and callback side effects."
        },
        {
          scenario: "A short fixed list retains linear lookup because indexing costs more and duplicates use first-match semantics.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Small fixed collections may be cheaper; Map/Set conversion is not required and cannot silently change NaN, identity, duplicates, or effects."
        },
        {
          scenario: "The obligation or decisive runtime/path evidence for performance/no-repeated-linear-lookups is unavailable, and the visible code alone does not establish it.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "performance/hoist-invariant-computation",
    description: "반복 계산의 비용이 유의미하고 값·부작용·예외 및 평가 시점의 불변성이 확인될 때만 반복 밖 이동을 제안합니다.",
    scope: "module",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "Repeated computation has meaningful cost and its value, effects, exceptions, and evaluation timing are invariant over the relevant iterations.",
      criteria: "반복 계산의 비용이 유의미하고 값·부작용·예외 및 평가 시점의 불변성이 확인될 때만 반복 밖 이동을 제안합니다.\n\n변수가 재할당되지 않아도 getter·Proxy·this·locale·시간·외부 mutable state는 변한다. 0회 loop와 예외 발생 시점도 바뀐다. 비순수 호출 hoist 기본 금지.",
      evidenceRequirements: [
        "The loop and zero-iteration path, dependencies/getters/Proxy/this/external state, exception/effect order, and cost evidence.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Nonpure or timing-sensitive work is not safely hoistable merely because a variable is never reassigned."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A costed pure calculation with identical inputs and no observable timing/effects is redundantly repeated beyond its budget.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The loop and zero-iteration path, dependencies/getters/Proxy/this/external state, exception/effect order, and cost evidence."
        },
        {
          scenario: "A getter stays inside the loop because its result or side effects can change per iteration.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Nonpure or timing-sensitive work is not safely hoistable merely because a variable is never reassigned."
        },
        {
          scenario: "The obligation or decisive runtime/path evidence for performance/hoist-invariant-computation is unavailable, and the visible code alone does not establish it.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "performance/minimize-critical-path-work",
    description: "응답의 완료 계약과 작업 수명·오류·내구성을 보존하는 범위에서만 핵심 경로의 불필요한 비용을 줄이도록 제안합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "The response completion contract identifies work whose cost can be reduced or relocated without changing required lifetime, durability, or error semantics.\n\n환경: 자료구조·동등성·작업량·메모리·job 진행의 실행 의미가 우선. typecheck 성공은 실행 비용이나 host 진행 보장의 증거가 아님. main thread와 worker·microtask/task·render 예산을 구분. event loop·worker pool·worker thread·CLI/startup·serverless 수명을 구분",
      criteria: "응답의 완료 계약과 작업 수명·오류·내구성을 보존하는 범위에서만 핵심 경로의 불필요한 비용을 줄이도록 제안합니다.\n\n응답에 불필요해 보여도 durable 완료·감사·트랜잭션 계약상 필수일 수 있다. fire-and-forget은 serverless 종료·오류 유실을 일으킬 수 있다.\n\n보존할 의무: 응답을 빨리 보내는 것보다 필요한 완료·정리·실패 책임을 보존한다. disconnected/detached work도 owner를 가진다.",
      evidenceRequirements: [
        "The critical path and measured cost, completion contract, required audit/transaction work, environment lifetime, and proposed background ownership.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 응답의 accepted/committed/completed 계약 · 후처리의 소유권·내구성·오류·재시도/중복 보장 · host lifetime와 비용 근거"
      ],
      exceptions: [
        "Durable completion, required audit, and transaction work may belong on the critical path; fire-and-forget is not automatically safe.",
        "허용 사례: 필수 감사/commit/결과 전달 또는 Lambda 종료 전 완료가 필요한 작업을 기다린다."
      ],
      procedure: [
        "수준: 선택적 설계 검토 · 명세·공식 구현 의미 확인",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A verified optional repeated computation exceeds the response budget and can be safely removed without changing completion semantics.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The critical path and measured cost, completion contract, required audit/transaction work, environment lifetime, and proposed background ownership."
        },
        {
          scenario: "Required durable persistence remains awaited in a serverless request whose lifetime ends after the response.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Durable completion, required audit, and transaction work may belong on the critical path; fire-and-forget is not automatically safe."
        },
        {
          scenario: "판단 불가: background executor의 내구성이나 response completion 계약을 모른다. await를 지우거나 queue 도입을 자동 권고하지 않는다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "performance/no-redundant-serialization",
    description: "반복 직렬화의 비용과 목적을 확인하고, 표현 변환·복사·검증·서명 및 사용자 정의 변환의 의미를 보존할 때만 제거를 제안합니다.",
    scope: "module",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "Repeated serialization has meaningful cost and its representation, clone, validation, signing, or custom-transformation purpose is known.",
      criteria: "반복 직렬화의 비용과 목적을 확인하고, 표현 변환·복사·검증·서명 및 사용자 정의 변환의 의미를 보존할 때만 제거를 제안합니다.\n\n직렬화는 clone·검증·보안 경계·canonical bytes·toJSON/reviver 실행일 수 있다. JSON과 structuredClone은 의미가 다르다. 반복된 모양만으로 제거하지 않는다.",
      evidenceRequirements: [
        "The repeated operations and cost, exact representation semantics, toJSON/reviver hooks, canonical/signature bytes, and copy/validation guarantees.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Serialization used as a documented boundary, copy, validation, or canonicalization step is not redundant; structuredClone is not equivalent by default."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "An identical expensive serialization of an immutable value is repeated with no transformation/effect purpose and exceeds its stated budget.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The repeated operations and cost, exact representation semantics, toJSON/reviver hooks, canonical/signature bytes, and copy/validation guarantees."
        },
        {
          scenario: "A round trip remains because its specified validation and custom reviver semantics are required.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Serialization used as a documented boundary, copy, validation, or canonicalization step is not redundant; structuredClone is not equivalent by default."
        },
        {
          scenario: "The obligation or decisive runtime/path evidence for performance/no-redundant-serialization is unavailable, and the visible code alone does not establish it.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "performance/bounded-memory-accumulation",
    description: "로그·결과·버퍼·중간 목록의 누적량과 최대 사용량이 허용 메모리 범위를 넘지 않도록 검사합니다. 유한 입력도 비용을 확인하고, buffer 임계값이나 비동기 API의 존재만을 실제 누적 한도로 간주하지 않습니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "Logs, results, buffers, or intermediate collections can accumulate beyond an allowed memory/peak-use budget.\n\n환경: 자료구조·동등성·작업량·메모리·job 진행의 실행 의미가 우선. typecheck 성공은 실행 비용이나 host 진행 보장의 증거가 아님. main thread와 worker·microtask/task·render 예산을 구분. event loop·worker pool·worker thread·CLI/startup·serverless 수명을 구분",
      criteria: "로그·결과·버퍼·중간 목록의 누적량과 최대 사용량이 허용 메모리 범위를 넘지 않도록 검사합니다. 유한 입력도 비용을 확인하고, buffer 임계값이나 비동기 API의 존재만을 실제 누적 한도로 간주하지 않습니다.\n\n자원 소모의 명확한 고장 모드다. finite 입력도 예산을 넘길 수 있다. queue·cache·stream의 같은 원인은 해당 세부 규칙 한 건으로 묶는다.\n\n보존할 의무: 계속 쌓이는 구조뿐 아니라 유한하지만 과도한 peak도 보존할 고장 모드다. 데이터를 drop하는 fix는 결과·감사 계약 없이 자동 실행하지 않는다.",
      evidenceRequirements: [
        "Producer/consumer rates, ownership and lifetime, retained volumes, effective backpressure and limits, and peak memory including finite inputs.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: producer/consumer 속도·queue/cache/array 수명 · 실제 byte/item 크기와 backpressure·overflow·release · finite workload의 최대 누적량과 host memory 예산"
      ],
      exceptions: [
        "A proven effective accumulation bound is sufficient; a buffer threshold or async method alone is not proof of a bound.",
        "허용 사례: backpressure/유한 큐/streaming/해제 정책이 실제 누적량을 허용 예산 안에 유지한다. 모든 결과 collection을 금지하지 않는다."
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
          scenario: "A finite but allowed huge request materializes all intermediate results and exceeds the memory budget despite an async API.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Producer/consumer rates, ownership and lifetime, retained volumes, effective backpressure and limits, and peak memory including finite inputs."
        },
        {
          scenario: "A pipeline honors backpressure and a verified admission limit that bounds total retained memory.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. A proven effective accumulation bound is sufficient; a buffer threshold or async method alone is not proof of a bound."
        },
        {
          scenario: "판단 불가: 라이브러리 내부 buffer/queue 정책을 모른다. highWaterMark 존재를 hard cap으로 보거나 output이 finite여서 안전하다고 단정하지 않는다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "performance/no-large-object-retention",
    description: "작은 참조가 필요 이상으로 큰 객체나 backing buffer의 수명을 연장하는 근거가 있을 때 보존 비용과 소유권을 함께 검토합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "A reachable small reference prolongs a materially large object's or backing buffer's lifetime beyond its required use.",
      criteria: "작은 참조가 필요 이상으로 큰 객체나 backing buffer의 수명을 연장하는 근거가 있을 때 보존 비용과 소유권을 함께 검토합니다.\n\nclosure가 있다는 사실만으로 큰 객체 보존을 단정하지 않는다. 실제 reachable retainer와 lifetime 차이가 근거다. Buffer subarray는 backing memory를 공유하며 copy가 소유권 의미를 바꿀 수 있다.",
      evidenceRequirements: [
        "The actual retainer/reachability path, object/backing-buffer size, required and observed/modelled lifetime, and ownership consequences of alternatives.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "A closure alone is not proof of retention; intentional ownership and required shared-buffer lifetimes are valid."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A long-lived small Buffer subarray keeps a large backing allocation alive beyond the allowed retained-memory budget.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The actual retainer/reachability path, object/backing-buffer size, required and observed/modelled lifetime, and ownership consequences of alternatives."
        },
        {
          scenario: "A required shared view retains its backing memory only for the contractually necessary lifetime.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. A closure alone is not proof of retention; intentional ownership and required shared-buffer lifetimes are valid."
        },
        {
          scenario: "The obligation or decisive runtime/path evidence for performance/no-large-object-retention is unavailable, and the visible code alone does not establish it.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "performance/no-unnecessary-full-copy",
    description: "전체 복사의 비용이 유의미하고 snapshot·소유권·참조 동일성·변경 격리 계약을 유지할 수 있을 때만 부분 처리나 view를 제안합니다.",
    scope: "module",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "A full copy has meaningful cost and a partial operation or view can preserve snapshot, ownership, identity, and mutation isolation.",
      criteria: "전체 복사의 비용이 유의미하고 snapshot·소유권·참조 동일성·변경 격리 계약을 유지할 수 있을 때만 부분 처리나 view를 제안합니다.\n\n복사는 불변 snapshot·소유권·동시 변경 격리 계약일 수 있다. shallow/deep copy·view·Buffer 종류와 accessor/iterator side effect를 구분한다.",
      evidenceRequirements: [
        "Actual copy type/size/cost, shallow/deep/view semantics, accessor/iterator effects, and required isolation/identity contract.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Copies required for immutable snapshots or ownership/concurrent-mutation isolation remain valid."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A measured full immutable buffer copy exceeds a budget when a proven equivalent bounded read preserves every required contract.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Actual copy type/size/cost, shallow/deep/view semantics, accessor/iterator effects, and required isolation/identity contract."
        },
        {
          scenario: "A full copy is retained because callers require an isolated immutable snapshot rather than a shared view.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Copies required for immutable snapshots or ownership/concurrent-mutation isolation remain valid."
        },
        {
          scenario: "The obligation or decisive runtime/path evidence for performance/no-unnecessary-full-copy is unavailable, and the visible code alone does not establish it.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "performance/memoize-stable-computations",
    description: "메모이제이션이 입력·외부 상태·동등성·부작용뿐 아니라 새 결과 할당·참조 동일성·공유 변경 계약을 보존하는지 검사하며, 순수 계산에 메모이제이션 도입 자체를 요구하지 않습니다.",
    scope: "module",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "An existing or proposed memoization may change input/external-state equality, effects, allocation, reference identity, or shared mutation semantics.",
      criteria: "메모이제이션이 입력·외부 상태·동등성·부작용뿐 아니라 새 결과 할당·참조 동일성·공유 변경 계약을 보존하는지 검사하며, 순수 계산에 메모이제이션 도입 자체를 요구하지 않습니다.\n\n원문은 memoization 권장이 아니라 unsound cache 방지다. key·정규화·무효화·부작용은 기존 cache 규칙과 공유하되, 매번 새 객체를 반환하던 계약과 같은 참조 재사용의 차이는 기존 규칙만으로 모두 덮이지 않아 독립 의무로 남긴다.",
      evidenceRequirements: [
        "Cache key and invalidation, all relevant inputs/external state, effects and freshness, and fresh-allocation versus shared-result behavior.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Pure calculations do not have to be memoized; stable values alone do not justify sharing result objects when fresh identity is part of the contract."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "Memoization returns the same mutable object to callers that are promised fresh isolated results.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Cache key and invalidation, all relevant inputs/external state, effects and freshness, and fresh-allocation versus shared-result behavior."
        },
        {
          scenario: "A cache preserves value and freshness semantics and only shares results where the identity/immutability contract allows it.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Pure calculations do not have to be memoized; stable values alone do not justify sharing result objects when fresh identity is part of the contract."
        },
        {
          scenario: "The obligation or decisive runtime/path evidence for performance/memoize-stable-computations is unavailable, and the visible code alone does not establish it.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "performance/match-data-structure-to-access",
    description: "실제 workload와 비용·순서·동등성 계약이 확인된 경우에 자료구조 대안을 비교하며, 자료구조 종류만으로 설계 위반을 판정하지 않습니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "An opt-in design review has actual workload and cost, ordering, and equality contracts for a data structure choice.\n\n환경: 자료구조·동등성·작업량·메모리·job 진행의 실행 의미가 우선. typecheck 성공은 실행 비용이나 host 진행 보장의 증거가 아님. main thread와 worker·microtask/task·render 예산을 구분. event loop·worker pool·worker thread·CLI/startup·serverless 수명을 구분",
      criteria: "실제 workload와 비용·순서·동등성 계약이 확인된 경우에 자료구조 대안을 비교하며, 자료구조 종류만으로 설계 위반을 판정하지 않습니다.\n\n접근 패턴만으로 최적 자료구조를 판단할 수 없다. workload·메모리·순서·복잡도 계약이 없는 한 설계 조언 목록으로 유지하고 독립 기본 경고는 보류한다.\n\n보존할 의무: 자료구조 변경 시 결과 순서·중복·동등성·참조 의미를 보존한다. 이 규칙은 다른 구체 correctness/budget 위반을 대체하지 않는다.",
      evidenceRequirements: [
        "Operation frequencies and sizes, time/memory evidence, ordering/equality semantics, and comparable alternatives.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 실제 access workload·크기·변경·순서·equality 요구 · 자료구조 연산의 보장 복잡도와 allocation 비용 · 선택을 바꿨을 때의 의미/maintenance trade-off"
      ],
      exceptions: [
        "A structure's type alone is not a design defect; without workload evidence retain an optional review and explicit uncertainty.",
        "허용 사례: 작은 순서 보존 목록이나 중복 유지가 필요한 자료를 array로 처리한다. Map/Set이 항상 낫다는 가정은 금지한다."
      ],
      procedure: [
        "수준: 선택적 설계 검토 · 명세·공식 구현 의미 확인",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A verified structure choice violates a declared access-time budget under its real workload and an equivalent alternative is evidenced.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Operation frequencies and sizes, time/memory evidence, ordering/equality semantics, and comparable alternatives."
        },
        {
          scenario: "The chosen array remains appropriate for the measured small ordered workload.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. A structure's type alone is not a design defect; without workload evidence retain an optional review and explicit uncertainty."
        },
        {
          scenario: "판단 불가: workload와 equality 계약이 없다. Map lookup을 무조건 최악 O(1)이라고 주장하거나 자료구조를 바꾸지 않는다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "performance/avoid-unrelated-ui-recomputation",
    description: "UI 프로파일과 framework의 계산·memoization 모델을 근거로 고비용 재계산을 식별하고, 참조 안정성과 동작 계약을 보존하는 개선만 제안합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "An opt-in performance review has UI profiling evidence and an identified framework/compiler/runtime recomputation model.",
      criteria: "UI 프로파일과 framework의 계산·memoization 모델을 근거로 고비용 재계산을 식별하고, 참조 안정성과 동작 계약을 보존하는 개선만 제안합니다.\n\nframework/compiler/runtime 측정 없이는 unrelated나 expensive를 판정하기 어렵다. React에서는 memoization이 의미 보장이 아니며 compiler가 처리할 수 있다. opt-in profiler 검토로 보류한다.",
      evidenceRequirements: [
        "The profile and expensive recomputation, input change/re-render cause, framework memoization behavior, and identity/behavior preservation.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Rerenders alone do not establish expensive recomputation; a compiler may already optimize it and memoization is not a semantic guarantee."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A profile shows expensive unrelated recomputation exceeding a stated UI budget with a verified behavior-preserving reduction.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The profile and expensive recomputation, input change/re-render cause, framework memoization behavior, and identity/behavior preservation."
        },
        {
          scenario: "A rerender is left alone because profiling shows negligible cost and the compiler already reuses expensive work.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Rerenders alone do not establish expensive recomputation; a compiler may already optimize it and memoization is not a semantic guarantee."
        },
        {
          scenario: "The obligation or decisive runtime/path evidence for performance/avoid-unrelated-ui-recomputation is unavailable, and the visible code alone does not establish it.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "performance/bounded-recursion",
    description: "외부 데이터의 깊이·순환 참조가 실제 런타임의 호출 스택·작업량 예산을 넘는지 검사합니다. performance/bound-input-dependent-work와 같은 위반은 묶되 깊이·스택 한도와 독립 설정을 유지합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "External depth or cycles can exceed the actual runtime call-stack, depth, or work budget.\n\n환경: 자료구조·동등성·작업량·메모리·job 진행의 실행 의미가 우선. typecheck 성공은 실행 비용이나 host 진행 보장의 증거가 아님. main thread와 worker·microtask/task·render 예산을 구분. event loop·worker pool·worker thread·CLI/startup·serverless 수명을 구분",
      criteria: "외부 데이터의 깊이·순환 참조가 실제 런타임의 호출 스택·작업량 예산을 넘는지 검사합니다. performance/bound-input-dependent-work와 같은 위반은 묶되 깊이·스택 한도와 독립 설정을 유지합니다.\n\n조건부 통합이다. 대상 bound-input-dependent-work가 실제 런타임의 호출 스택·깊이 한도까지 명시적으로 확장되고 stack overflow·graph cycle의 근거와 설정을 보존할 때만 특수화가 된다. 확장 전에는 독립 유지한다.\n\n보존할 의무: 일반 work budget만으로 stack 의무를 덮지 않는다. 원래 독립 ID·깊이/순환 옵션을 유지하고 같은 위반만 묶는다.",
      evidenceRequirements: [
        "Input graph and cycle/depth limits, reachable recursive path, runtime stack budget, and the concrete overflow/excess-work condition.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 입력 depth/cycle와 반복/재귀 구조 · target runtime의 실제 stack 관련 보장·검증된 domain cap · CPU/work budget과 stack-depth 설정의 독립성"
      ],
      exceptions: [
        "Proven shallow/acyclic bounded recursion is valid; preserve this rule's independent selection and depth/stack obligations even when correlating findings.",
        "허용 사례: 지원 입력의 깊이가 검증되고 해당 target stack 여유가 확인되거나 올바른 iterative/trampoline 구조가 작업/메모리 계약도 지킨다."
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
          scenario: "An allowed cyclic graph reaches unguarded recursion and overflows the actual runtime stack.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Input graph and cycle/depth limits, reachable recursive path, runtime stack budget, and the concrete overflow/excess-work condition."
        },
        {
          scenario: "Cycle detection and a validated maximum depth keep recursive traversal within the runtime budget.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Proven shallow/acyclic bounded recursion is valid; preserve this rule's independent selection and depth/stack obligations even when correlating findings."
        },
        {
          scenario: "판단 불가: engine/frame 크기/host limit을 모른다. universal 안전 depth를 제시하지 않고 depth 근거와 위험을 보고한다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "performance/no-busy-waiting",
    description: "상태 변화를 기다리는 반복이 필요한 다른 작업의 진행과 실행 자원 예산을 막는지 검사합니다. await·worker라는 문법만으로 안전하다고 보지 않고, 실제 task 진행 기회와 승인된 유한 동기화 조건을 확인합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "A wait loop may block required task progress or exceed an execution-resource budget.\n\n환경: 자료구조·동등성·작업량·메모리·job 진행의 실행 의미가 우선. typecheck 성공은 실행 비용이나 host 진행 보장의 증거가 아님. main thread와 worker·microtask/task·render 예산을 구분. event loop·worker pool·worker thread·CLI/startup·serverless 수명을 구분",
      criteria: "상태 변화를 기다리는 반복이 필요한 다른 작업의 진행과 실행 자원 예산을 막는지 검사합니다. await·worker라는 문법만으로 안전하다고 보지 않고, 실제 task 진행 기회와 승인된 유한 동기화 조건을 확인합니다.\n\nmain event loop spin은 진행을 막지만 전문 worker의 짧은 bounded spin은 설계일 수 있다. async function 안이라는 이유로 자동 예외를 주지 않는다. microtask만의 무한 yield도 고려한다.\n\n보존할 의무: yield 문법은 실제 다른 작업의 진행 보장과 다르다. worker라는 이름만으로 무제한 spin을 예외 처리하지 않는다.",
      evidenceRequirements: [
        "The actual scheduler/task model, awaited signal producer, loop bounds, yield class, and resource/progress budget.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 대기하는 상태를 변경할 주체와 실행 agent · 반복의 상한·budget·task/microtask 진행 방식 · worker/Atomics·message queue·main-thread 차이"
      ],
      exceptions: [
        "An approved bounded synchronization spin may be valid; being in an async function/worker or awaiting only microtasks does not itself prove safety.",
        "허용 사례: 유한 worker 동기화가 다른 agent의 상태 변경과 예산을 전제로 하거나 host가 허용한 blocking wait를 쓴다. 작은 bounded microtask batch 자체는 위반이 아니다."
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
          scenario: "An infinite microtask-only await loop prevents the task that changes the awaited condition from running.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The actual scheduler/task model, awaited signal producer, loop bounds, yield class, and resource/progress budget."
        },
        {
          scenario: "A specialized worker uses an approved short bounded spin that respects its synchronization and CPU budget.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. An approved bounded synchronization spin may be valid; being in an async function/worker or awaiting only microtasks does not itself prove safety."
        },
        {
          scenario: "판단 불가: await 대상이 즉시 Promise인지 실제 외부 task인지 모르거나 상태 writer가 다른 thread인지 모른다. await/worker라는 문법만으로 통과시키지 않는다.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
  {
    id: "performance/preserve-semantics-under-optimization",
    description: "사용자 코드나 변경의 최적화가 원래 계약의 값·오류·부작용·참조·평가 순서·정밀도·취소·수명을 바꾸지 않는지 검사하고, 의도된 동작 변경과 의도하지 않은 의미 변화를 구분합니다.",
    scope: "project",
    defaultSeverity: "warn",
    buildPrompt: () => ({
      applicability: "User code or a change optimizes behavior under a contract that must retain specified observable semantics.",
      criteria: "사용자 코드나 변경의 최적화가 원래 계약의 값·오류·부작용·참조·평가 순서·정밀도·취소·수명을 바꾸지 않는지 검사하고, 의도된 동작 변경과 의도하지 않은 의미 변화를 구분합니다.\n\n사용자가 작성한 최적화나 변경도 검사한다. 분석기 자신의 refactor를 통제하는 agentlint/preserve-behavior-on-refactor와 대상이 달라 독립 ID를 유지하고 의미 분석 엔진만 공유한다.",
      evidenceRequirements: [
        "The original and changed paths, target language/runtime contract, values/errors/effects/identity/order/precision/cancellation/lifetime, and a distinguishing input.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "Explicitly authorized intentional behavior changes are distinguished from unintended semantic drift; passing tests alone is not equivalence proof."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Missing context must remain unknown or a clearly qualified risk, not a pass or an invented violation.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "Replacing first-match array lookup with a last-write-wins Map changes the result for duplicate keys contrary to the original contract.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The original and changed paths, target language/runtime contract, values/errors/effects/identity/order/precision/cancellation/lifetime, and a distinguishing input."
        },
        {
          scenario: "An optimized lookup preserves equality, duplicate selection, order, side effects, and all supported observations.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Explicitly authorized intentional behavior changes are distinguished from unintended semantic drift; passing tests alone is not equivalence proof."
        },
        {
          scenario: "The obligation or decisive runtime/path evidence for performance/preserve-semantics-under-optimization is unavailable, and the visible code alone does not establish it.",
          expected: "unknown",
          reason: "State the missing evidence and inspected scope. Do not invent a policy, erase an evidenced risk, or report an uninspected obligation as passed."
        }
      ]
    }),
  },
];
