import type { LintRule } from "@aquarius/core";

// Section 23: 설정·기능 플래그·배포.
// Prompt definitions only. Registration does not enable rules or prove detection quality.
// Canonical source: https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad
export const section23Rules: LintRule[] = [
  {
    id: "config/validate-at-startup",
    description: "설정이 필요한 기능을 사용 가능하게 만들기 전에 필수값·형식·상호 제약을 검증하고, 동적 갱신과 선택 기능은 각 활성화 경계에서 검증합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability:
        "Code that activates capabilities using startup, refreshed, request, or tenant configuration.",
      criteria: "설정이 필요한 기능을 사용 가능하게 만들기 전에 필수값·형식·상호 제약을 검증하고, 동적 갱신과 선택 기능은 각 활성화 경계에서 검증합니다.\n\n모든 설정을 프로세스 시작에 강제 검증하면 선택 기능·lazy tenant 설정·secret rotation을 깨뜨린다. 필수 capability를 공개하기 전 검증한다는 시간적 계약으로 바꾼다.\n\n보존할 의무: lazy/optional 예외가 사용 전 검증 생략으로 바뀌면 안 된다. 갱신 실패 시 부분 config를 노출하지 않는 계약을 확인한다.",
      evidenceRequirements: [
        "The activation boundary, required fields/formats/cross-field constraints, validation ordering, and dynamic refresh/tenant paths.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: capability별 필수 config와 활성화/ready 시점 · reload·request/tenant config lifecycle · validation 실패 시 기존 snapshot/기능 상태 처리"
      ],
      exceptions: [
        "Optional and lazy capabilities may validate at their own activation boundaries; not every setting is mandatory at process startup.",
        "허용 사례: 선택 기능은 활성화 시 검증하고 무관한 핵심 기능을 유지한다. 비활성 integration의 secret 부재가 전체 프로세스를 반드시 막을 필요는 없다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 정책·설계·도구 의무 확인",
        "환경: 설정 해석·기본값·활성화·변경 snapshot의 의미를 모델링. 선언된 config 타입은 누락·coercion·secret 노출을 런타임에서 방지하지 않음. build-time env 노출과 runtime flag/config를 구분. client flag는 권한의 최종 근거가 아님. process.env·worker copy·bootstrap·request/tenant lifecycle 및 external provider를 구분",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A service reports its payment capability ready before checking the required signing configuration.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The activation boundary, required fields/formats/cross-field constraints, validation ordering, and dynamic refresh/tenant paths."
        },
        {
          scenario: "An optional tenant feature validates its configuration when activated and refuses activation on invalid input.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Optional and lazy capabilities may validate at their own activation boundaries; not every setting is mandatory at process startup."
        },
      ]
    }),
  },
  {
    id: "config/explicit-required-values",
    description: "설정의 필수값과 허용 기본값을 명시하고, 시작·갱신·요청·테넌트·선택 기능의 각 사용 범위에서 필수값 누락이 임의의 기본값으로 숨겨지지 않도록 합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Configuration consumers with required values or fallback defaults.",
      criteria: "설정의 필수값과 허용 기본값을 명시하고, 시작·갱신·요청·테넌트·선택 기능의 각 사용 범위에서 필수값 누락이 임의의 기본값으로 숨겨지지 않도록 합니다.\n\n필수성은 설정 계약이고 validate-at-startup은 검증 시점의 계약이다. 시작 후 refresh·request·tenant·lazy 경계에서 값이 사라질 수 있으므로 독립 ID와 계속되는 사용 시점 의무를 유지한다.\n\n보존할 의무: 검증 시점과 별개로 필수/허용값의 계약은 사라지지 않는다. startup 성공이 이후 context의 required 값을 보증하지 않는다.",
      evidenceRequirements: [
        "The required-value contract, permitted defaults, omission at each use boundary, and any fallback that hides a required absence.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 필수성과 허용 default를 명시한 schema/사용 계약 · missing·empty·null·0·false 구분 · 각 refresh/request/tenant/lazy 사용 시점의 실제 값"
      ],
      exceptions: [
        "Defaults explicitly permitted by the contract and disabled optional capabilities are allowed.",
        "허용 사례: 명시적으로 허용된 기본값 또는 미활성 optional capability의 absent 값. 0과 빈 문자열이 의미 있는 계약이면 보존한다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 정책·설계·도구 의무 확인",
        "환경: 설정 해석·기본값·활성화·변경 snapshot의 의미를 모델링. 선언된 config 타입은 누락·coercion·secret 노출을 런타임에서 방지하지 않음. build-time env 노출과 runtime flag/config를 구분. client flag는 권한의 최종 근거가 아님. process.env·worker copy·bootstrap·request/tenant lifecycle 및 external provider를 구분",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A refresh deletes a mandatory destination and a silent arbitrary fallback masks the missing value.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The required-value contract, permitted defaults, omission at each use boundary, and any fallback that hides a required absence."
        },
        {
          scenario: "An optional disabled feature has no destination until activation, when the required value is validated.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Defaults explicitly permitted by the contract and disabled optional capabilities are allowed."
        },
      ]
    }),
  },
  {
    id: "config/typed-config-boundary",
    description: "문자열 설정을 사용 지점마다 제각각 해석하지 않고 검증된 형태로 전달합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability:
        "External string configuration parsed or used as booleans, numbers, enums, or other domain values.",
      criteria: "문자열 설정을 사용 지점마다 제각각 해석하지 않고 검증된 형태로 전달합니다.\n\nJS 환경 변수는 문자열이다. 검증된 boolean·number·enum 의미를 한 경계에서 해석하는 일은 실제 계약이다. TypeScript 타입만으로 runtime 검증을 대체하지 않는다.",
      evidenceRequirements: [
        "The external representation, runtime parser/validator, resulting value semantics, and conflicting or unvalidated downstream interpretation.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "A validated typed configuration container or equivalent boundary is sufficient; a TypeScript cast alone is not runtime validation."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "The string false is interpreted as truthy in business code because it was cast to boolean without parsing.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The external representation, runtime parser/validator, resulting value semantics, and conflicting or unvalidated downstream interpretation."
        },
        {
          scenario: "One runtime validator parses false to a boolean and passes the validated value to consumers.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. A validated typed configuration container or equivalent boundary is sufficient; a TypeScript cast alone is not runtime validation."
        },
      ]
    }),
  },
  {
    id: "config/no-scattered-environment-reads",
    description: "환경 설정의 해석·기본값·갱신 의미가 업무 코드에 숨거나 서로 충돌하는 경로를 검사하고, 선언된 설정 경계와 의도적인 직접 접근은 인정합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Environment-variable reads in application code.",
      criteria: "환경 설정의 해석·기본값·갱신 의미가 업무 코드에 숨거나 서로 충돌하는 경로를 검사하고, 선언된 설정 경계와 의도적인 직접 접근은 인정합니다.\n\n읽는 곳의 개수만으로 나쁜 구조라 판정하지 않는다. 짧은 CLI·bootstrap·framework adapter는 직접 읽어도 된다. 동적 설정을 강제 singleton snapshot으로 바꾸지 않는다.\n\n보존할 의무: 중앙 singleton 강제 대신 해석·수명·갱신 일관성을 보호한다. direct access 허용이 secret/client 노출이나 숨은 의존 허가가 아니다.",
      evidenceRequirements: [
        "The reads, interpretation/default rules, intended configuration boundary, and an actual hidden or conflicting semantic path.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: env/config source와 파싱·precedence 경계 · process·worker·buildtime·request snapshot 모델 · 같은 설정을 읽는 소비자들의 값/갱신 기대"
      ],
      exceptions: [
        "Short CLIs, bootstrap code, framework adapters, and intentionally direct reads are allowed; dynamic config need not become a singleton snapshot.",
        "허용 사례: 짧은 CLI/명시 bootstrap adapter에서 직접 읽거나 값이 독립적으로 쓰여 숨은 정책 충돌이 없다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 명세·공식 구현 의미 확인",
        "환경: 설정 해석·기본값·활성화·변경 snapshot의 의미를 모델링. 선언된 config 타입은 누락·coercion·secret 노출을 런타임에서 방지하지 않음. build-time env 노출과 runtime flag/config를 구분. client flag는 권한의 최종 근거가 아님. process.env·worker copy·bootstrap·request/tenant lifecycle 및 external provider를 구분",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "Two business paths parse the same timeout with inconsistent units and defaults.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The reads, interpretation/default rules, intended configuration boundary, and an actual hidden or conflicting semantic path."
        },
        {
          scenario: "A bootstrap module intentionally reads environment values and passes one validated configuration to consumers.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Short CLIs, bootstrap code, framework adapters, and intentionally direct reads are allowed; dynamic config need not become a singleton snapshot."
        },
      ]
    }),
  },
  {
    id: "config/safe-production-defaults",
    description: "설정 누락 시 디버그 노출·인증 생략·파괴적 동작이 기본으로 켜지지 않도록 합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability:
        "Configuration defaults controlling debug exposure, authentication, or destructive operations.",
      criteria: "설정 누락 시 디버그 노출·인증 생략·파괴적 동작이 기본으로 켜지지 않도록 합니다.\n\n설정 누락이 권한 우회·debug 노출·파괴적 동작을 켜는 위험은 명확하다. 보호 대상 profile을 production 문자열만으로 추정하지 않는다.\n\n보존할 의무: 보호된 배포의 불명확한 설정은 자동 허용으로 해석하지 않는다. config 미정이라는 이유로 fail-open 경로를 숨기지 않는다.",
      evidenceRequirements: [
        "The deployment/profile evidence, missing-value path, debug/auth/destructive default, and concrete exposure or bypass.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 보호된 배포/capability의 실제 노출과 data scope · missing/unknown env·flag의 기본 분기 · debug/auth/destructive 동작의 startup/remote override"
      ],
      exceptions: [
        "A proven isolated diagnostic profile may allow debug behavior; a string named production alone does not establish the protected scope.",
        "허용 사례: 보호 기능은 안전한 기본값으로 시작하고 격리된 demo/test 범위의 explicit unsafe mode는 실제 외부 자원에 영향을 주지 않는다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 정책·설계·도구 의무 확인",
        "환경: 설정 해석·기본값·활성화·변경 snapshot의 의미를 모델링. 선언된 config 타입은 누락·coercion·secret 노출을 런타임에서 방지하지 않음. build-time env 노출과 runtime flag/config를 구분. client flag는 권한의 최종 근거가 아님. process.env·worker copy·bootstrap·request/tenant lifecycle 및 external provider를 구분",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "Omitting an auth configuration flag enables authentication bypass in a protected deployment.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The deployment/profile evidence, missing-value path, debug/auth/destructive default, and concrete exposure or bypass."
        },
        {
          scenario: "Missing auth configuration fails closed before protected traffic is accepted.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. A proven isolated diagnostic profile may allow debug behavior; a string named production alone does not establish the protected scope."
        },
      ]
    }),
  },
  {
    id: "config/separate-secrets",
    description: "비밀 설정이 일반 설정과 같은 출력·배포·접근 권한으로 노출되지 않도록 분류와 전달 정책을 보존합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability:
        "Configuration carrying secrets through output, distribution, or access boundaries.",
      criteria: "비밀 설정이 일반 설정과 같은 출력·배포·접근 권한으로 노출되지 않도록 분류와 전달 정책을 보존합니다.\n\n물리적으로 다른 파일·객체가 필수는 아니다. 접근·출력·배포 경계에서 secret 분류가 보존되면 같은 typed config container도 가능하다.\n\n보존할 의무: 다른 파일이나 env에 옮긴 것만으로 안전해지지 않는다. 실제 secret 접근·출력·배포 경계의 보호를 유지한다.",
      evidenceRequirements: [
        "Secret classification without reproducing the value, data-flow/output/access boundaries, and a concrete policy violation.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: config field 분류와 reader 권한 · logger/serializer/bundle/build-time substitution 경로 · secret 전달·회전·보존 및 redact 실패 경로"
      ],
      exceptions: [
        "A shared typed configuration object/file is allowed if secret-specific access, redaction, and distribution policies are preserved.",
        "허용 사례: 같은 typed container 안에서도 secret이 접근·출력·배포 정책으로 격리되고 실제 serializer가 이를 보존한다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 명세·공식 구현 의미 확인",
        "환경: 설정 해석·기본값·활성화·변경 snapshot의 의미를 모델링. 선언된 config 타입은 누락·coercion·secret 노출을 런타임에서 방지하지 않음. build-time env 노출과 runtime flag/config를 구분. client flag는 권한의 최종 근거가 아님. process.env·worker copy·bootstrap·request/tenant lifecycle 및 external provider를 구분",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A generic configuration dump includes secret-classified fields in a public diagnostic response.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Secret classification without reproducing the value, data-flow/output/access boundaries, and a concrete policy violation."
        },
        {
          scenario: "A typed configuration container keeps secrets redacted and restricts their distribution despite sharing one container.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. A shared typed configuration object/file is allowed if secret-specific access, redaction, and distribution policies are preserved."
        },
      ]
    }),
  },
  {
    id: "config/explicit-precedence",
    description: "파일·환경 변수·실행 인자·원격 설정 중 무엇이 우선하는지 명확히 합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Configuration loaded or merged from multiple sources.",
      criteria: "파일·환경 변수·실행 인자·원격 설정 중 무엇이 우선하는지 명확히 합니다.\n\n파일·env·CLI·remote merge 순서의 실제 계약이다. 존재 여부와 falsy 값, unset과 null, 부분 갱신을 구별해야 한다.\n\n보존할 의무: 값이 여러 source에서 오면 실제 승자와 해석을 숨기지 않는다. 안전 관련 override를 일반 convenience merge로 무시하지 않는다.",
      evidenceRequirements: [
        "Each source, merge order, presence-versus-falsy semantics, unset/null behavior, and partial refresh handling.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 실제 loader/version와 env-file/CLI/remote source 순서 · empty/unset/partial object merge 의미 · 문서·테스트·실행 코드의 일치"
      ],
      exceptions: [
        "An explicit provider/library precedence contract can suffice without duplicate custom merge logic.",
        "허용 사례: 간단한 코드에서 명확한 precedence를 구현하고 필요한 계약/테스트가 있다. 모든 app에 같은 보편 우선순위를 강제하지 않는다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 명세·공식 구현 의미 확인",
        "환경: 설정 해석·기본값·활성화·변경 snapshot의 의미를 모델링. 선언된 config 타입은 누락·coercion·secret 노출을 런타임에서 방지하지 않음. build-time env 노출과 runtime flag/config를 구분. client flag는 권한의 최종 근거가 아님. process.env·worker copy·bootstrap·request/tenant lifecycle 및 external provider를 구분",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "CLI false is discarded by a truthiness fallback and an environment true overrides its declared priority.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Each source, merge order, presence-versus-falsy semantics, unset/null behavior, and partial refresh handling."
        },
        {
          scenario: "The merger uses presence checks so an explicitly supplied false retains CLI precedence.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. An explicit provider/library precedence contract can suffice without duplicate custom merge logic."
        },
      ]
    }),
  },
  {
    id: "config/traceable-feature-decisions",
    description: "필요한 기능 결정의 규칙·변형·fallback 이유를 허용된 범위에서 설명할 수 있게 하고, 중요한 결정의 추적 요구나 근거가 미정·확인 불가한 경우 이를 공백으로 남깁니다. 개인별 평가값의 무제한 기록은 요구하지 않습니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Feature-flag evaluations with variant or fallback decisions.",
      criteria: "필요한 기능 결정의 규칙·변형·fallback 이유를 허용된 범위에서 설명할 수 있게 하고, 중요한 결정의 추적 요구나 근거가 미정·확인 불가한 경우 이를 공백으로 남깁니다. 개인별 평가값의 무제한 기록은 요구하지 않습니다.\n\n어떤 결정의 추적이 필요한지는 감사·실험·운영 정책에 달린다. 모든 평가를 로깅하라는 기본 규칙은 개인정보·비용 문제다. SDK metadata와 샘플링도 인정해야 한다.\n\n보존할 의무: fallback을 성공 평가로 위장하지 않는다. 추적성 강화를 위해 민감 evaluation context를 무제한 수집하지 않는다.",
      evidenceRequirements: [
        "The important decision and required explanation, rule/variant/fallback metadata, permitted retention/sampling boundaries, and any evidence gap.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 추적이 필요한 결정/감사·실험 목적 · evaluation reason·variant·provider/config version와 fallback 상태 · SDK 상세정보·보존/수신/privacy policy"
      ],
      exceptions: [
        "SDK metadata, bounded sampling, and approved explanatory paths may suffice; logging every person's evaluation is not required.",
        "허용 사례: OpenFeature detailed metadata나 제한된 event로 필요한 variant/reason을 설명한다. 매 평가마다 user payload를 로그할 필요는 없다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 명세·공식 구현 의미 확인",
        "환경: 설정 해석·기본값·활성화·변경 snapshot의 의미를 모델링. 선언된 config 타입은 누락·coercion·secret 노출을 런타임에서 방지하지 않음. build-time env 노출과 runtime flag/config를 구분. client flag는 권한의 최종 근거가 아님. process.env·worker copy·bootstrap·request/tenant lifecycle 및 external provider를 구분",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A required release decision explanation cannot identify the fallback reason within the inspected approved trace path.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The important decision and required explanation, rule/variant/fallback metadata, permitted retention/sampling boundaries, and any evidence gap."
        },
        {
          scenario: "An SDK provides approved decision metadata and sampled traces sufficient for the project's traceability requirement.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. SDK metadata, bounded sampling, and approved explanatory paths may suffice; logging every person's evaluation is not required."
        },
      ]
    }),
  },
  {
    id: "config/remove-expired-flags",
    description: "종료가 확인된 임시 플래그의 코드·설정·관측 의존을 정리하되, 영구 운영 제어와 복구·호환 기간에 필요한 플래그는 유지합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability:
        "Temporary feature flags and their code, configuration, or observation dependencies.",
      criteria: "종료가 확인된 임시 플래그의 코드·설정·관측 의존을 정리하되, 영구 운영 제어와 복구·호환 기간에 필요한 플래그는 유지합니다.\n\n오래된 플래그가 곧 만료된 플래그는 아니다. 운영 kill switch·entitlement·장기 rollout은 보존하고 완료/만료 메타데이터와 양쪽 분기 사용을 검증한다.\n\n보존할 의무: 만료 확인된 임시 분기 정리 의무는 유지한다. 통계상 최근 trigger0이라는 이유로 비상 제어를 없애지 않는다.",
      evidenceRequirements: [
        "Completion/expiry metadata, branch/config/observability dependencies, active consumers, and rollback/compatibility retention requirements.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: flag type·owner·expiry/completion·rollout/rollback window · 사용 코드·server/client version·SDK cached values · 실제 제거 대상 분기와 운영 제어 역할"
      ],
      exceptions: [
        "Permanent operational controls, entitlements, kill switches, active rollouts, and needed rollback/compatibility windows remain valid.",
        "허용 사례: permanent entitlement/kill switch 또는 old client/복구 기간에 필요한 transition flag가 오래 존재한다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 명세·공식 구현 의미 확인",
        "환경: 설정 해석·기본값·활성화·변경 snapshot의 의미를 모델링. 선언된 config 타입은 누락·coercion·secret 노출을 런타임에서 방지하지 않음. build-time env 노출과 runtime flag/config를 구분. client flag는 권한의 최종 근거가 아님. process.env·worker copy·bootstrap·request/tenant lifecycle 및 external provider를 구분",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A confirmed expired temporary flag retains unreachable rollout branches and obsolete configuration after all retirement conditions are met.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. Completion/expiry metadata, branch/config/observability dependencies, active consumers, and rollback/compatibility retention requirements."
        },
        {
          scenario: "An old kill switch remains because it is a permanent operational recovery control.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Permanent operational controls, entitlements, kill switches, active rollouts, and needed rollback/compatibility windows remain valid."
        },
      ]
    }),
  },
  {
    id: "config/test-supported-flag-combinations",
    description: "지원·금지 플래그 조합과 중요한 상호작용의 검증 근거를 확인하고, 지원 범위 미정이나 검증 공백을 드러냅니다. 전체 조합 전수 실행을 임의로 요구하거나 일부 조합 통과를 전체 보장으로 확대하지 않습니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Code whose behavior depends on combinations of feature flags.",
      criteria: "지원·금지 플래그 조합과 중요한 상호작용의 검증 근거를 확인하고, 지원 범위 미정이나 검증 공백을 드러냅니다. 전체 조합 전수 실행을 임의로 요구하거나 일부 조합 통과를 전체 보장으로 확대하지 않습니다.\n\n지원 조합 계약 없이는 2^n 전수 테스트를 요구할 수 없다. 선언된 금지 조합은 빠른 검증 대상이나 일반 test completeness 판정은 설계 검토·coverage policy가 필요하다.\n\n보존할 의무: 전수 테스트를 강제하지 않는 것과 지원 계약의 검증을 면제하는 것은 다르다. 미정 범위와 미검증 조합을 숨기지 않는다.",
      evidenceRequirements: [
        "The support matrix, forbidden combinations, relevant interaction risks, verification evidence and actual executed subset.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 지원/금지 조합과 interaction 제약 · critical flow·failure/rollout state의 test matrix · 실행 fixture와 coverage strategy가 실제로 보장하는 범위"
      ],
      exceptions: [
        "Risk-based, pairwise, model, or other evidence is acceptable where it meets the declared obligations; exhaustive 2^n tests are not inferred.",
        "허용 사례: 실제로 지원하지 않는 조합을 runtime에서 명확히 거절하고 지원 범위의 위험 기반 검증을 수행한다. 2^n 전수 실행을 무조건 강제하지 않는다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 명세·공식 구현 의미 확인",
        "환경: 설정 해석·기본값·활성화·변경 snapshot의 의미를 모델링. 선언된 config 타입은 누락·coercion·secret 노출을 런타임에서 방지하지 않음. build-time env 노출과 runtime flag/config를 구분. client flag는 권한의 최종 근거가 아님. process.env·worker copy·bootstrap·request/tenant lifecycle 및 external provider를 구분",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A declared forbidden pair is accepted and a required interaction has no verification in the inspected support scope.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The support matrix, forbidden combinations, relevant interaction risks, verification evidence and actual executed subset."
        },
        {
          scenario: "The documented supported matrix is covered by approved model evidence without enumerating unsupported combinations.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Risk-based, pairwise, model, or other evidence is acceptable where it meets the declared obligations; exhaustive 2^n tests are not inferred."
        },
      ]
    }),
  },
  {
    id: "config/rolling-update-compatibility",
    description: "여러 버전이 동시에 실행되는 동안 설정·프로토콜·데이터 형식이 호환되도록 합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability:
        "Releases where old and new versions can coexist over shared configuration, protocols, or data.",
      criteria: "여러 버전이 동시에 실행되는 동안 설정·프로토콜·데이터 형식이 호환되도록 합니다.\n\n혼합 버전 기간이라는 별도 배포 계약이다. 외부 API뿐 아니라 DB·queue·config·cache reader/writer 호환이 포함된다. 단일 버전 atomic 배포에는 강제하지 않는다.\n\n보존할 의무: code rollout 성공/Pod ready는 저장된 data와 외부 소비자 호환 증명이 아니다. 운영 기간의 version mix를 누락하지 않는다.",
      evidenceRequirements: [
        "The coexistence window, participating reader/writer versions, actual formats, and a cross-version incompatibility sequence.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 동시에 존재하는 reader/writer/client 버전과 rollout 기간 · DB/event/cache/config 형식의 before/after 의미 · old/new 조합 fixture와 persisted historical data"
      ],
      exceptions: [
        "A proven atomic single-version deployment has no mixed-version obligation; staged compatibility migrations can satisfy it.",
        "허용 사례: 명시된 혼합 기간의 양방향 호환 또는 traffic drain·migration barrier가 보장된다. 단일 버전 atomic 배포에는 불필요한 호환 기간을 발명하지 않는다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 정책·설계·도구 의무 확인",
        "환경: 설정 해석·기본값·활성화·변경 snapshot의 의미를 모델링. 선언된 config 타입은 누락·coercion·secret 노출을 런타임에서 방지하지 않음. build-time env 노출과 runtime flag/config를 구분. client flag는 권한의 최종 근거가 아님. process.env·worker copy·bootstrap·request/tenant lifecycle 및 external provider를 구분",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A new writer emits a queue format that an old consumer still active during the rollout cannot read.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The coexistence window, participating reader/writer versions, actual formats, and a cross-version incompatibility sequence."
        },
        {
          scenario: "A rollout first deploys readers that accept both formats before writers emit the new format.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. A proven atomic single-version deployment has no mixed-version obligation; staged compatibility migrations can satisfy it."
        },
      ]
    }),
  },
  {
    id: "config/reversible-release-changes",
    description: "프로젝트가 요구한 복구 전략에 맞게 배포 후 데이터·설정·외부 효과까지 되돌리거나 보상할 수 있는 범위와 되돌릴 수 없는 변경을 식별합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Release changes affecting code, data, configuration, or external effects.",
      criteria: "프로젝트가 요구한 복구 전략에 맞게 배포 후 데이터·설정·외부 효과까지 되돌리거나 보상할 수 있는 범위와 되돌릴 수 없는 변경을 식별합니다.\n\n모든 배포는 rollback 가능해야 한다는 규범으로 확대하지 않는다. forward-fix·보상·백업 복원이 승인된 복구 전략일 수 있다.\n\n보존할 의무: 모든 변경을 rollback 가능하게 강제하지 않되 프로젝트가 요구한 복구 능력을 조용히 약화하지 않는다. 데이터 파괴의 사용자 결정권을 보존한다.",
      evidenceRequirements: [
        "The required recovery strategy, changed effects, rollback/compensation/forward-fix paths, and explicitly irreversible portions.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 요구된 recovery goal·rollback/forward-fix/보상 전략 · code/config/data/외부 side effect별 복구 가능성 · backup restore·migration·승인된 되돌릴 수 없는 경계"
      ],
      exceptions: [
        "Approved forward-fix, compensation, backups, or documented irreversible steps may meet the chosen strategy; universal rollback is not required.",
        "허용 사례: 승인된 forward-fix/보상 전략이 실제 복구 요건을 충족하며 irreversible step이 알려져 있다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 명세·공식 구현 의미 확인",
        "환경: 설정 해석·기본값·활성화·변경 snapshot의 의미를 모델링. 선언된 config 타입은 누락·coercion·secret 노출을 런타임에서 방지하지 않음. build-time env 노출과 runtime flag/config를 구분. client flag는 권한의 최종 근거가 아님. process.env·worker copy·bootstrap·request/tenant lifecycle 및 external provider를 구분",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A claimed reversible release irreversibly deletes required data without the recovery path its policy requires.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The required recovery strategy, changed effects, rollback/compensation/forward-fix paths, and explicitly irreversible portions."
        },
        {
          scenario: "The release documents irreversible effects and provides the approved compensation and backup recovery path.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Approved forward-fix, compensation, backups, or documented irreversible steps may meet the chosen strategy; universal rollback is not required."
        },
      ]
    }),
  },
  {
    id: "config/readiness-after-initialization",
    description: "필수 초기화가 끝나기 전에 정상 요청을 받을 준비가 됐다고 보고하지 않도록 합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability:
        "Services or capabilities with initialization and readiness or traffic-admission signals.",
      criteria: "필수 초기화가 끝나기 전에 정상 요청을 받을 준비가 됐다고 보고하지 않도록 합니다.\n\n필수 초기화와 traffic 수락의 순서 계약이다. 선택 의존의 준비 실패가 전체 서비스를 막아야 하는지는 별도 정책이다.\n\n보존할 의무: ready 보고는 필수 capability 준비 완료를 앞지르면 안 된다. liveness와 같은 endpoint라도 이 시간적 의무는 유지한다.",
      evidenceRequirements: [
        "The mandatory initialization dependencies, readiness signal, actual traffic admission, and success/failure ordering.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 필수 initialization과 capability 활성화 순서 · ready endpoint/provider state와 failure path · traffic gate가 실제로 읽는 signal"
      ],
      exceptions: [
        "Optional dependencies follow their own availability policy and need not necessarily block the entire service.",
        "허용 사례: 필수 준비는 완료됐고 선택 추천 기능은 degraded 상태로 명시하며 핵심 기능이 정상이다."
      ],
      procedure: [
        "수준: 프로젝트·정책 계약 검사 · 명세·공식 구현 의미 확인",
        "환경: 설정 해석·기본값·활성화·변경 snapshot의 의미를 모델링. 선언된 config 타입은 누락·coercion·secret 노출을 런타임에서 방지하지 않음. build-time env 노출과 runtime flag/config를 구분. client flag는 권한의 최종 근거가 아님. process.env·worker copy·bootstrap·request/tenant lifecycle 및 external provider를 구분",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "Readiness returns true while mandatory schema initialization is still pending.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The mandatory initialization dependencies, readiness signal, actual traffic admission, and success/failure ordering."
        },
        {
          scenario: "Readiness stays false until all required initialization completes, while optional analytics stays degraded.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Optional dependencies follow their own availability policy and need not necessarily block the entire service."
        },
      ]
    }),
  },
  {
    id: "config/distinguish-liveness-readiness",
    description: "생존 검사 실패의 재시작 정책과 준비 검사 실패의 트래픽 정책이 각 목적에 맞도록 하며, 목적을 충족하는 검사 구현의 공유는 허용합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Deployments with health signals controlling restarts or traffic admission.",
      criteria: "생존 검사 실패의 재시작 정책과 준비 검사 실패의 트래픽 정책이 각 목적에 맞도록 하며, 목적을 충족하는 검사 구현의 공유는 허용합니다.\n\nKubernetes 공식 문서도 같은 저비용 endpoint를 다른 threshold로 쓰는 패턴을 인정한다. 동일 함수·URL이 위반이 아니라 restart와 traffic 제거의 판정 의미가 핵심이다.",
      evidenceRequirements: [
        "The probe actions, failure conditions/thresholds, initialization/dependency behavior, and actual restart/traffic policy.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan."
      ],
      exceptions: [
        "One low-cost function or endpoint may serve both purposes if its configuration and semantics satisfy both contracts."
      ],
      procedure: [
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "A temporary downstream outage triggers liveness restarts even though the declared policy only requires traffic removal.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The probe actions, failure conditions/thresholds, initialization/dependency behavior, and actual restart/traffic policy."
        },
        {
          scenario: "A shared endpoint with approved thresholds correctly drives liveness and readiness behavior for the deployment.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. One low-cost function or endpoint may serve both purposes if its configuration and semantics satisfy both contracts."
        },
      ]
    }),
  },
  {
    id: "config/no-environment-name-business-policy",
    description: "환경별로 달라지는 업무 동작이 명시된 제품·배포 정책과 일치하는지 검사하고, 환경 이름 분기로 숨겨진 의미 차이와 승인된 안전장치를 구분합니다.",
    scope: "project",
    buildPrompt: () => ({
      applicability: "Business logic that branches on environment names or deployment modes.",
      criteria: "환경별로 달라지는 업무 동작이 명시된 제품·배포 정책과 일치하는지 검사하고, 환경 이름 분기로 숨겨진 의미 차이와 승인된 안전장치를 구분합니다.\n\nsandbox 결제·staging 외부전송 제한처럼 환경별 동작은 정당할 수 있다. 환경 문자열 자체가 아닌 문서화되지 않은 업무 의미 변화가 대상이다.\n\n보존할 의무: 환경 이름을 business truth나 보안 경계로 임의 해석하지 않는다. 명시된 환경별 안전장치를 분리하라며 삭제하지 않는다.",
      evidenceRequirements: [
        "The actual branch and deployment profile, changed business meaning, policy authority, and affected entry paths.",
        "Identify the source location, applicable version and authority of the obligation, the inspected paths, and the distinction between inferred behavior and executed validation. Do not invent locations or infer absence from an incomplete scan.",
        "필수 근거: 환경별로 달라지는 실제 업무 결과와 제품/운영 이유 · mode·NODE_ENV·배포 destination의 차이 · sandbox/real resource routing 및 client-visible 계약"
      ],
      exceptions: [
        "Sandbox payments, staging transmission restrictions, and other approved environment safety measures are allowed.",
        "허용 사례: 승인된 sandbox 결제·테스트 수신자·운영 안전장치가 명시된 scope에만 적용된다."
      ],
      procedure: [
        "수준: 선택적 설계 검토 · 정책·설계·도구 의무 확인",
        "환경: 설정 해석·기본값·활성화·변경 snapshot의 의미를 모델링. 선언된 config 타입은 누락·coercion·secret 노출을 런타임에서 방지하지 않음. build-time env 노출과 runtime flag/config를 구분. client flag는 권한의 최종 근거가 아님. process.env·worker copy·bootstrap·request/tenant lifecycle 및 external provider를 구분",
        "Establish the actual language, runtime, framework and project obligation from code, API semantics, callers, tests or authorized policy. A new configuration declaration is not required when existing evidence establishes the obligation.",
        "Compare the concrete reachable behavior with that obligation and the rule-specific exceptions. Inspect the available context before reaching a conclusion. Report only established violations, otherwise finish with no established violation in the inspected scope. Missing required configuration is a setup error. Skip a rule only when its code applicability prerequisite is absent; actual access or execution failures remain errors.",
        "Report a confirmed defect, a conditional risk and an optional preference separately. Correlate overlapping results only when their cause, violated contract and remedy agree; preserve independent rule selection and scoped exceptions.",
        "These are reporting instructions, not authority to execute code, transmit data, change policy or apply fixes. Preserve behavior and existing user changes; disclose checks that were not performed."
      ],
      examples: [
        {
          scenario: "An undocumented environment-name branch changes a customer's billing calculation despite a uniform product contract.",
          expected: "violation",
          reason: "Under the stated and verified obligation, this is a concrete counterexample. The actual branch and deployment profile, changed business meaning, policy authority, and affected entry paths."
        },
        {
          scenario: "A documented sandbox environment blocks real external payments while preserving the intended sandbox contract.",
          expected: "pass",
          reason: "Within the inspected scope, the stated obligation is satisfied. Sandbox payments, staging transmission restrictions, and other approved environment safety measures are allowed."
        },
      ]
    }),
  },
];
