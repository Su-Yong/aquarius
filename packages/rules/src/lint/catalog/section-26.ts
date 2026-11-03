// Analyzer/reporting and fix principles, NOT user-code LintRule definitions.
// Current RuleScope cannot target analyzer artifacts. These records do not enforce tool safety,
// suppressions, deduplication, execution permissions, fixes, or result validation.
export const section26Principles = [
  {
    id: "agentlint/require-evidence",
    kind: "analyzer-principle",
    description: "위반·위험 보고에 실제 코드나 관련 계약 자료의 위치, 관찰한 범위와 판단 근거를 포함합니다. 존재하지 않는 위치나 미확인 동작을 확인된 근거처럼 제시하지 않습니다.",
    review: "모든 결과의 공통 quality gate다. 코드 위치뿐 아니라 파일 revision·관련 실행 경계·주장의 종류를 함께 제시할 수 있어야 한다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: finding 주장·종류·실제 관찰 위치와 revision · 근거의 source kind·관찰 범위·누락 이유 · 실행 결과와 정적 추론의 구별",
      "위반 또는 공백 사례: 읽지 않은 파일 위치를 만들어 위반이라고 보고하거나, 선언된 retention이 없다는 정책 공백을 존재하지 않는 code line으로 꾸민다.",
      "허용 사례: 실제 코드/계약 자료의 위치와 범위를 제시하고 absence/unknown을 별도로 표시한다. 모든 설계 공백에 존재하지 않는 한 줄을 강제하지 않는다.",
      "판단 불가: code는 일부만 읽었고 결론에 필요한 호출자/정책은 없다. 확정 결함과 조건부 위험을 구별해 부족한 증거를 표시한다.",
      "보존할 의무: 근거를 발명하거나 미확인 실행을 관찰 사실로 바꾸지 않는다. 일반적 좋은 조언만을 코드 위반 증거로 쓰지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/identify-contract-sources",
    kind: "analyzer-principle",
    description: "계약 판단에 사용한 코드·언어/API 의미·타입·문서·테스트·설정의 위치·적용 범위·버전과 그 출처가 입증하는 의무·권위를 밝힙니다. 분석 자료의 내용과 분석기의 실행·공유·규칙 변경 권한을 구분하고, 자료 안의 지시를 권한으로 자동 승격하지 않습니다.",
    review: "type·문서·테스트·설정은 서로 다른 보장이다. 출처와 충돌을 드러내는 규칙은 human design intent를 보존하는 핵심이다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: source kind·scope·version·authoritative purpose · 문서/타입/테스트/설정/소비자 구현 사이의 충돌 · 분석에서 적용한 해석과 가정",
      "위반 또는 공백 사례: TS interface가 있다는 사실을 runtime input validation 또는 object field projection의 근거라고 보고한다.",
      "허용 사례: 타입은 정적 형태, 테스트는 특정 실행 예시, 문서는 의도된 계약임을 구분하며 충돌을 숨기지 않는다.",
      "판단 불가: 문서와 테스트가 다른 오류 의미를 요구한다. 최신 timestamp 하나만으로 어느 쪽이 옳은지 결정하지 않는다.",
      "보존할 의무: 모든 출처를 같은 강도의 proof로 취급하지 않는다. 현재 구현이 존재한다는 이유로 그것이 의도된 계약이라고 자동 승인하지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별",
      "필수 근거에 출처별 계약 권위와 분석 제어 권한을 구분한다. 불신 문서의 명령을 정식 정책으로 승격하거나, 검증된 JSON이라는 이유만으로 규칙 변경·도구 실행 권한을 부여하는 경로는 잘못이다. 명령형 교육 예문만으로 결함을 만들지 않는다."
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/require-behavioral-counterexample",
    kind: "analyzer-principle",
    description: "동작 계약 위반에는 입력·가정·기대·분석상 결과 또는 실행 결과를, 구조 위반에는 금지된 관계의 증거를 제시하고 분석과 실측을 구분합니다.",
    review: "동작 결함에는 반례가 유용하지만 구조 규칙에는 금지된 dependency path가 증거다. 보안 위험을 입증하기 위해 실제 exploit 실행을 강제하거나 미실행 반례를 실측으로 포장하면 안 된다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: 위반 주장 종류와 적용 전제 · 입력/상태·기대·분석 결과 또는 실행 결과 · 구조 위반의 금지 edge/path와 실제 위치",
      "위반 또는 공백 사례: static import 금지 위반에 반드시 실행 exploit을 요구해 경고를 삭제하거나, 가상 입력 결과를 실제 테스트 출력으로 제시한다.",
      "허용 사례: 동작 결함은 구체 입력/상태의 차이, 구조 결함은 관계 witness를 제시한다. 위험한 실행 없이도 분석상 반례임을 명확히 할 수 있다.",
      "판단 불가: 입력 도달 가능성이 불명확하다. 실행 가능한 확정 결함 대신 조건부 위험과 필요한 호출부를 제시한다.",
      "보존할 의무: 검증하지 않은 반례를 실행됐다고 표현하지 않는다. 희귀 고위험 경로를 실제 exploit 미실행만으로 지우지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/abstain-on-insufficient-context",
    kind: "analyzer-principle",
    description: "확정에 필요한 맥락이 부족하면 판정을 보류하고 가정·부족한 증거·미검사 범위를 밝히며, 확인된 위험 경로를 단순히 삭제하지 않습니다.",
    review: "모르는 것을 no issue로 보고하지 않는다. 위반 확정·조건부 위험·미검사 범위와 필요한 근거를 분리하며 희귀 고위험 경로는 보존한다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: 필요한 호출부·정책·host profile과 실제 조사 범위 · unknown으로 남은 edge/상태와 결론 영향 · 조건부 위험을 지지하는 확인된 부분",
      "위반 또는 공백 사례: PDP 구현을 못 읽었는데 안전하다고 통과시키거나, 반대로 프로젝트 전체가 취약하다고 단정한다.",
      "허용 사례: 확정 가능한 부분만 결론 내고 unknown/not-applicable/suppressed를 pass와 분리한다. 부족한 맥락을 찾을 수 있는 구체 다음 증거를 제시한다.",
      "판단 불가: external adapter가 opaque이다. 보장 존재/부재를 추정하지 않고 coverage gap으로 남긴다.",
      "보존할 의무: abstain은 무조건 침묵이나 전체 분석 폐기가 아니다. 알려진 위험과 미검사 범위를 지우지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/no-size-only-design-judgment",
    kind: "analyzer-principle",
    description: "줄 수·분기 수·메서드 수만으로 책임 과다나 추상화 실패를 단정하지 않습니다.",
    review: "줄 수·복잡도 metric은 조사 신호일 뿐 설계 결함의 증명은 아니다. 변경 축·책임·비용·명시된 계약과 연결해야 한다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: size/complexity signal과 실제 책임·변경 축·계약 영향의 관계 · generated/data table/parser 같은 역할 · 프로젝트의 명시된 budget/style policy와 일반 설계 판단 구분",
      "위반 또는 공백 사례: 1000줄 generated parser를 줄 수만으로 SRP 위반이라고 확정하거나 역할을 보지 않고 class를 여러 파일로 자동 분리한다.",
      "허용 사례: 큰 모듈도 한 책임의 필요한 표현일 수 있다. 명시된 byte/stack/API 한도 위반은 별도 구체 budget 규칙으로 판단한다.",
      "판단 불가: 큰 파일만 있고 변경 이유/consumer를 모른다. 조사 신호로는 쓰되 설계 결함으로 확정하지 않는다.",
      "보존할 의무: 숫자 하나를 설계 진실로 승격하지 않는다. 동시에 명백한 자원/프로토콜 크기 제한까지 무시하지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/honor-project-architecture",
    kind: "analyzer-principle",
    description: "프로젝트가 명시한 구조·도메인 의도·허용 예외와 사용자가 지정한 정식 정책·설정 출처를 그 권위·적용 범위에 맞게 존중합니다. 근거 사이 또는 언어·프로토콜 의무와의 충돌을 드러내며, 분석 자료의 지시를 새로운 실행·공유 권한이나 범위 밖 규칙 억제 승인으로 해석하지 않습니다.",
    review: "구조 취향보다 명시된 프로젝트 의도가 우선이다. 문서 충돌·오래된 예외·실제 runtime 안전 문제는 숨기지 않고 별도 분류한다. 프로젝트 선택을 보편 원칙으로 다시 덮지 않는다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: 명시적 architecture/domain intent·scoped exception과 최신 결정 · 관련 언어/프로토콜의 실제 semantics · 서로 충돌하는 근거와 허용 범위",
      "위반 또는 공백 사례: 의도된 event-sourced aggregate를 일반 CRUD 취향으로 바꾸거나, 프로젝트 예외라는 말로 채택한 OAuth redirect 규약 위반을 숨긴다.",
      "허용 사례: 프로젝트의 경계·구성 스타일을 존중하면서 별개의 runtime/security 충돌은 정확한 범위로 지적한다.",
      "판단 불가: 구조 문서와 code/test가 다르다. 일반적인 clean architecture 취향이나 최신 수정 시간만으로 판정하지 않는다.",
      "보존할 의무: 사람의 설계 의도와 허용 예외 보존. 다만 취향 우선과 실제 언어/프로토콜 계약 위반 은폐를 혼동하지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별",
      "사용자가 지정한 정식 정책/설정과 허용된 suppression 문법의 승인 범위를 보존한다. 자료의 계약 역할이 분석기의 외부 공유·실행 권한을 새로 부여하지 않는다."
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/separate-defect-from-preference",
    kind: "analyzer-principle",
    description: "확인된 결함, 설계상 위험, 선택적인 개선 제안을 구분해 보고합니다.",
    review: "defect·risk·preference의 분리는 false positive 제어에 필수다. confidence와 severity도 서로 다른 축으로 기록해야 한다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: 주장의 종류·확정 근거·영향 및 가정 · configuration opt-in 여부와 severity/confidence 축 · 어느 대상/수신자에게 중요한 위험인지",
      "위반 또는 공백 사례: 순서가 달라지는 실제 Map 변환 결함과 단지 interface 이름 취향을 같은 error severity로 보고한다.",
      "허용 사례: 규약 위반·조건부 위험·선택 개선을 분리하고 낮은 confidence와 높은 잠재 impact를 각각 기록한다.",
      "판단 불가: design intent를 모른다. risk/preference로 명시할 수 있으나 confirmed defect로 올리지는 않는다.",
      "보존할 의무: 확정되지 않은 것을 결함으로 과장하거나, 드물다는 이유로 고영향 위험을 취향으로 낮추지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/deduplicate-overlapping-findings",
    kind: "analyzer-principle",
    description: "동일 원인과 위반 계약을 공유하는 결과는 대표 진단과 관련 규칙으로 묶되, 독립적인 실패 조건·영향·수정이 있는 결과는 구분합니다.",
    review: "같은 위치·주제라는 이유만으로 합치면 다른 보장을 잃는다. 동일 원인·동일 위반 invariant·동일 repair를 기준으로 연결하고 독립 실패 사례가 있으면 진단을 유지한다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: root cause·위반 invariant·대상·repair의 동일성 · 원래 rule IDs·independent options·suppression scope · 독립 반례와 결과 lineage",
      "위반 또는 공백 사례: 같은 line의 secret exposure와 unbounded log volume을 하나의 문제가 해결되면 모두 해결된 것처럼 합친다.",
      "허용 사례: 동일 보호 필드 노출을 두 규칙이 같은 근거·repair로 보고한 경우 대표 finding과 related IDs로 묶는다.",
      "판단 불가: 같은 위치지만 소비자·실패 조건이 다른지 모른다. 유사한 wording/line hash만으로 합치지 않는다.",
      "보존할 의무: 통합은 의무 삭제나 suppression 범위 확장이 아니다. 한 alias가 비활성화돼도 다른 활성 규칙의 독립 의무를 유지한다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/show-cross-file-evidence",
    kind: "analyzer-principle",
    description: "여러 파일의 관계를 주장할 때 관련 선언·구현·호출 위치와 연결 경로를 근거에 함께 포함합니다. 공통 근거 형식을 재사용하되 교차 파일 관계의 증거 완전성과 독립적인 요구 설정을 유지합니다.",
    review: "require-evidence의 cross-file completeness 조건이다. 독립 사용자 규칙 대신 evidence schema의 relatedLocations와 관계 edge 필수성으로 통합한다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: 호출·선언·구현의 실제 위치와 revision · 금지되거나 중요한 연결 edge/path · unresolved dynamic edge와 분석 scope",
      "위반 또는 공백 사례: A가 B 내부를 침범한다고 주장하면서 A의 line만 내고 B의 declaration/허용 범위 근거가 없다.",
      "허용 사례: 확인한 선언·호출·구성 경로를 관련 위치로 제공하고 외부 opaque edge는 unknown이라고 표시한다.",
      "판단 불가: runtime plugin registration 때문에 실제 target이 불명확하다. 하나를 임의 선택해 완전한 경로처럼 만들지 않는다.",
      "보존할 의무: 공통 evidence schema를 공유해도 교차 파일 관계의 완전성과 독립 설정은 사라지지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/consistent-rule-application",
    kind: "analyzer-principle",
    description: "동일한 버전·설정·실행 모델·근거에 같은 판정 및 예외 기준을 적용하고, 결과가 달라지면 달라진 입력이나 불확실성을 설명합니다.",
    review: "같은 code만으로 같다는 뜻이 아니다. runtime·config·model·rule revision·dependency 및 dynamic assumptions도 입력이다. LLM 판정의 완전 결정성을 보장한다고 주장하지 않는다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: code/config/runtime/rule/dependency 및 analyzer/model revision · 판정 기준·예외 scope와 cache key · 동일 입력 반복/회귀 fixture와 변화 기록",
      "위반 또는 공백 사례: 동일 적용 범위의 suppression을 한 곳만 무시하거나 오래된 rule cache를 새 config 판정에 재사용한다.",
      "허용 사례: 기준을 일관되게 적용하고 실제 입력/근거 변화나 불확실성을 설명한다. LLM의 매번 동일 문장을 보장한다고 하지 않는다.",
      "판단 불가: 이전 분석의 config/model/runtime snapshot이 없다. 두 결과가 다르다는 사실만으로 어느 쪽이 잘못인지 확정하지 않는다.",
      "보존할 의무: 같은 근거에 기분/표현만으로 다른 예외를 적용하지 않는다. 재현 불가능한 결과를 완전 결정적인 검증이라고 광고하지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/actionable-remediation",
    kind: "analyzer-principle",
    description: "문제의 책임과 경계를 어떻게 개선할지 구체적인 대안과 보존할 계약을 설명합니다. 안전한 수정을 정할 근거가 부족하면 문제를 숨기거나 임의로 고치지 않고 필요한 증거와 사람의 결정을 밝힙니다.",
    review: "실행 가능한 설계 대안을 요구하되 하나의 아키텍처를 강제하지 않는다. trade-off와 가장 작은 충분한 변화가 제안돼야 한다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: 실제 위반 원인과 보존할 계약 · 가능한 최소 변경·대안·trade-off · 자동 수정 가능성 및 필요한 사람의 선택",
      "위반 또는 공백 사례: 대형 파일에 근거 없이 분리하라고만 하거나, 개인정보 경고를 없애려고 업무상 필요한 전체 export를 삭제한다.",
      "허용 사례: 어느 경계의 어떤 의무를 어떻게 회복할지 구체적으로 제시하고 대안/필요한 결정도 밝힌다.",
      "판단 불가: 안전한 fix를 제안하기엔 계약이 부족하다. 문제를 숨기지 않고 결정권자가 확인할 질문/근거를 구체적으로 제시한다.",
      "보존할 의무: actionable을 반드시 code patch 존재로 해석하지 않는다. 추측한 아키텍처/의견을 사용자 의도로 꾸미지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/respect-scoped-suppressions",
    kind: "analyzer-principle",
    description: "승인된 예외의 규칙·대상·조건·수명 범위를 존중하고, 억제 사실과 만료·잘못된 범위는 분석 결과와 구분해 남깁니다.",
    review: "억제는 분석 불능·성공 판정과 다르다. rule/path/기간/이유 범위를 보존하고 unknown rule·만료·넘친 범위를 독립적으로 표시한다. 새 별명으로 억제를 우회하지 않는다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: 인정된 suppression syntax/승인 범위·rule ID/path·조건 · alias migration과 expiry가 적용되는 정책 · suppressed/unused/invalid 결과의 별도 기록",
      "위반 또는 공백 사례: 이전 ID가 canonical로 바뀌며 scoped suppression이 전체 security pack을 끄거나, 반대로 새 alias로 같은 경고를 재발행한다.",
      "허용 사례: 승인 범위만 억제하고 적용/만료 상태를 별도로 남긴다. 정책상 허용된 영구 예외에 임의 만료일을 강제하지 않는다.",
      "판단 불가: comment가 정식 suppression인지 설명문인지 모른다. 자연어 한 문장을 지시로 읽어 분석 전체를 끄지 않는다.",
      "보존할 의무: 명시 승인된 예외를 존중하되 범위를 넓히지 않는다. suppressed는 safe/pass와 다르며 unused도 자동 삭제 승인으로 보지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/preserve-behavior-on-refactor",
    kind: "analyzer-principle",
    description: "리팩터링에서 공개·의존 계약과 대상 언어·런타임의 계약상 관찰 동작을 보존합니다. 값·오류·부작용·참조·평가 순서·취소·수명의 변경을 확인하고, 보존 근거가 부족한 변환은 자동 적용하지 않습니다.",
    review: "JS는 this·identity·getter/Proxy·enumeration·sparse array·sync throw와 rejection·microtask·Number/BigInt 등의 관찰 의미가 있다. 함수 signature나 테스트 통과만으로 동등성을 단정하지 않는다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: 변경 전후의 공개·의존 계약과 실제 호출자/테스트 의미 · JS의 값·this·identity·getter·오류·job ordering·취소/수명 · transform의 충분한 필요조건과 증명/회귀 범위",
      "위반 또는 공백 사례: refactor라면서 새 객체 반환을 공유 memoized 객체로 바꾸거나 sync throw를 rejected Promise로 바꿔 caller 계약을 깨뜨린다.",
      "허용 사례: 계약상 관찰 동작은 유지하고 승인된 최적화로 elapsed cost나 incidental debug line 위치가 바뀐다. 그 항목이 공개 계약이면 별도로 보존한다.",
      "판단 불가: caller가 identity·exception timing을 의존하는지 모른다. tests passed만으로 완전 등가를 주장하지 않고 risky transform을 자동 적용하지 않는다.",
      "보존할 의무: 문서화되지 않았더라도 언어 의미·실제 의존/테스트로 드러난 계약을 보존한다. 단순 syntax/typecheck 통과는 동작 등가 proof가 아니다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/separate-refactor-and-behavior-change",
    kind: "analyzer-principle",
    description: "구조 개선과 업무 동작 변경을 하나의 자동 수정에 섞지 않습니다.",
    review: "bug fix는 의도적으로 동작을 바꿀 수 있지만 무승인 semantic drift를 refactor로 포장하면 안 된다. 한 issue의 두 commit이 반드시 필요하다는 기계 규범으로 확대하지 않는다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: 요청된 변경 목적과 승인된 semantic delta · structural refactor와 bug/feature 수정의 구분 · 각 의도별 diff/test/effect와 자동 적용 범위",
      "위반 또는 공백 사례: 레이어 분리 자동 수정에 무관한 가격/권한/재시도 정책 변경을 끼워 넣고 모두 refactor라고 보고한다.",
      "허용 사례: 승인된 bug fix가 필요한 최소 구조 변경을 수반하되 목적·동작 차이·검증을 명시한다. 물리 commit/file 개수만으로 판단하지 않는다.",
      "판단 불가: 변경된 기대 결과가 의도된 business change인지 모르겠다. refactor라는 이름으로 안전하다고 확정하지 않는다.",
      "보존할 의무: 구조 개선 권한이 임의 업무 변경 권한은 아니다. 필요한 semantic fix를 숨기거나 설명 없이 refactor로 재분류하지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/no-unrequested-dependency-additions",
    kind: "analyzer-principle",
    description: "단순한 룰 수정 때문에 새로운 프레임워크나 라이브러리를 임의로 추가하지 않습니다.",
    review: "프로젝트 의존성 결정권을 보존한다. helper 도입이 편리하다는 이유로 framework·package·권한·licensing 비용을 숨기지 않는다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: 요청된 작업·허용된 dependency 변경 범위 · manifest/lockfile·runtime/dev install·license/security 영향 · 기존 dependency 사용과 새로운 채택의 차이",
      "위반 또는 공백 사례: 단순 validation 수정에 임의 framework를 설치하거나 실행 중 helper가 필요하다는 이유로 무관한 transitive dependency를 production에 추가한다.",
      "허용 사례: 명시 요청된 dependency 도입, 이미 존재하는 공개 dependency의 사용, 또는 필요한 builtin 활용. 이들까지 무조건 신규 설치로 오인하지 않는다.",
      "판단 불가: 설치 승인/목적을 확인할 수 없다. 필요성을 설명하고 결정을 남기며 source import만 보고 승인됐다고 가정하지 않는다.",
      "보존할 의무: 편리하다는 이유로 새로운 비용·공급망·runtime 결합을 숨기지 않는다. package 설치는 검사 실행과 다른 외부 효과다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/minimal-scope-fixes",
    kind: "analyzer-principle",
    description: "문제를 충분히 해결하는 범위에서만 코드를 변경하고, 관련 없는 재명명·포맷·이동은 피하되 필요한 교차 파일·계약·검증 변경을 축소하지 않습니다.",
    review: "최소 line diff와 최소 충분한 수정은 다르다. invariant 복원에 필요한 여러 파일·테스트 수정은 허용해야 한다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: 원인과 충분한 해결 범위 · 변경 파일/호출부·계약·테스트의 필요성 · 무관 formatting/rename/move와 생성 도구의 영향",
      "위반 또는 공백 사례: 권한 guard 한 곳을 고치면서 무관 package 구조·이름을 일괄 변경하거나 최소 line 수를 맞추려고 필요한 caller/test 수정을 생략한다.",
      "허용 사례: 같은 invariant를 회복하기 위해 여러 파일·schema·tests를 함께 바꾸는 최소 충분한 수정.",
      "판단 불가: 관련 API caller나 generated ownership을 모른다. 가장 짧은 patch가 충분하다고 단정하지 않는다.",
      "보존할 의무: 작업 완결성과 사용자 변경 보존을 해치면서 diff 문자 수만 최소화하지 않는다. 무관한 cleanup은 섞지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/no-test-weakening",
    kind: "analyzer-principle",
    description: "수정 결과를 통과시키려고 검증을 삭제하거나 기대 결과를 근거 없이 완화하지 않습니다.",
    review: "실패 test의 정당한 계약 변경과 통과를 위한 무근거 기대값 완화를 구분한다. test 삭제 자체를 전면 금지하지 않는 원문 범위를 유지한다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: 원래 test가 검증한 계약과 실패 이유 · 새 기대값/삭제/skip의 근거와 승인된 행동 변경 · 대체 검증·quarantine 추적 및 보고 상태",
      "위반 또는 공백 사례: 수정 후 실패하는 assertion을 지우거나 expected를 actual에 맞춰 이유 없이 완화한다.",
      "허용 사례: 명시된 계약 변경에 맞춰 오래된 test를 고치고 대체 회귀를 남기거나 승인된 flaky quarantine을 skipped로 정확히 보고한다.",
      "판단 불가: test가 잘못됐는지 코드가 잘못됐는지 근거가 없다. green을 만들기 위해 기대를 바꾸지 않는다.",
      "보존할 의무: 통과를 위한 무근거 검증 약화 금지. test 변경 자체를 영구 금지하거나 실제 잘못된 test를 진실로 고정하지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/validate-available-checks",
    kind: "analyzer-principle",
    description: "수정 범위에 맞는 안전하고 허용된 검사·테스트·빌드를 실행하고 명령·환경·revision·결과와 검증 한계를 기록합니다.",
    review: "실행 가능한 것과 안전·승인된 것은 다르다. test hook·build script가 network·비밀·파일 변경을 수행할 수 있다. 검사 성공이 semantic proof가 아님을 함께 기록한다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: 변경에 적합한 명령·script/hook의 실제 내용 · 허용된 실행·filesystem/network/credential 범위와 환경 · 완료 여부·exit status·revision·선별된 검사 범위",
      "위반 또는 공백 사례: npm test라는 이름만 믿고 destructive lifecycle hook을 실행하거나, command 시작만 보고 테스트 통과라고 보고한다.",
      "허용 사례: 안전하고 적합한 범위의 검사를 실제 수행하고 검사하지 못한 영역을 명시한다. 관계없는 긴 test 전체를 매 작은 변경마다 요구할 필요는 없다.",
      "판단 불가: script effect/환경/의존성을 확인할 수 없다. 실행 보류와 verification gap을 밝히고 안전한 대안을 검토한다.",
      "보존할 의무: 검사를 실제로 하지 않은 것을 성공으로 보고하지 않는다. 검증 목적이 새로운 설치·외부 mutation·비밀 전송을 자동 승인하지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/report-unperformed-validation",
    kind: "analyzer-principle",
    description: "실행하지 못한 검사와 아직 확인하지 못한 영향을 명확히 밝힙니다.",
    review: "미실행·실행 실패·검사 실패·통과를 구별하고 누락 이유를 밝힌다. 제안된 시나리오를 수행한 테스트로 보고하지 않는다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: 계획·시작·완료·실패/차단/skip된 검사 목록 · 실제 output·exit code와 대상 revision · 미검증 영향 및 다음 필요한 확인",
      "위반 또는 공백 사례: 테스트를 계획만 했거나 환경이 없어 못 돌렸는데 검증 완료라고 쓰거나, 일부 unit pass를 전체 integration 보장으로 확대한다.",
      "허용 사례: passed/failed/blocked/not-run를 분리하고 각 범위·이유를 짧고 구체적으로 제시한다.",
      "판단 불가: worker/tool 실행 상태가 불확실하다. 요청됨을 완료로 승격하지 않고 상태를 확인하거나 불확실하다고 표시한다.",
      "보존할 의무: 미실행·검사 실패·실행 자체 실패를 숨기지 않는다. 가상 test scenario와 실제 수행 결과를 섞지 않는다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  },
  {
    id: "agentlint/preserve-user-changes",
    kind: "analyzer-principle",
    description: "기존 작업 내용과 무관한 변경을 덮어쓰거나 되돌리지 않습니다.",
    review: "사용자 작업 보존은 자동 수정의 필수 contract다. stale snapshot·동시 수정 감지와 최소 patch 적용에 직접 연결한다.",
    implementationStatus: "documentation-only",
    inspectionConditions: [
      "수준: 분석·수정 도구의 검증 의무 · 정책·설계·도구 의무 확인",
      "필수 근거: 읽은 baseline/revision·현재 working state/동시 변경 · 소유한 patch와 기존 사용자 수정 범위 · 충돌 감지·실패 시 되돌릴 대상의 경계",
      "위반 또는 공백 사례: 테스트 실패 뒤 git reset/파일 교체로 작업 전부터 있던 사용자 수정을 삭제하거나 stale content 전체를 덮어쓴다.",
      "허용 사례: 새로운 상태와 비교한 최소 patch로 필요한 관련 수정만 하고 충돌 시 범위를 재검토한다. dirty file이라는 이유만으로 모든 관련 수정이 불가능한 것은 아니다.",
      "판단 불가: 원래 diff와 자신의 diff를 구별할 baseline이 없다. 작업 전체를 되돌리지 않고 현재 상태부터 확인한다.",
      "보존할 의무: 작업과 무관한 사용자 변경은 덮거나 되돌리지 않는다. 자동 복구도 사용자 작업 소유권을 침해할 수 없다.",
      "환경: 분석기가 JS 코드를 판정·수정할 때의 자체 품질 기준. 향후 TS 입력이 있을 때 type/config 의미 확인이 필요하지만 현재 지원을 주장하지 않음. target host가 browser인 코드의 근거와 fixture가 필요한 자체 검토 의무. analyzer 실행 host와 target Node 코드의 실행 모델을 구별"
    ],
    sourceUrl: "https://chatgpt.com/space/page_dd6ffadaf0448191aa29ee9e19e7d2ad"
  }
] as const;
