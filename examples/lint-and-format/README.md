# lint 출력과 fmt 전후 비교

**기본 데모는 미리 준비한 mock AI 응답을 사용합니다. 실제 모델이 찾아낸 진단이나 수정이라고 주장하지 않습니다.** 규칙 로딩, 응답 검증, 터미널 출력, 파일 변경은 실제 Aquarius CLI로 실행합니다. 실제 Codex 실행 결과는 별도로 기록했습니다.

기준 소스: [`feature/rules`, `ff2fbe26b711bbf87ad636050220c5e87d9b9ef1`](https://github.com/Su-Yong/aquarius/commit/ff2fbe26b711bbf87ad636050220c5e87d9b9ef1). 이 커밋의 소스 96개와 패키지/빌드 설정 21개를 원격 blob SHA와 비교해 일치 확인한 뒤 재빌드했습니다.

## 실행

의존성이 설치된 저장소 루트에서:

```sh
pnpm build
node examples/lint-and-format/run-demo.mjs
```

스크립트는 임시 디렉터리에서 실행하며 예제 파일이나 저장소 소스를 덮어쓰지 않습니다. `before.js`가 입력, `after.js`가 이번 mock 실행으로 얻은 기대 출력입니다. 전체 실제 CLI 출력은 [`mock-output.txt`](./mock-output.txt)에 있습니다.

## lint 터미널 출력

```text
$ aqlint example.js
example.js:6:5 error [aquarius/contracts/no-input-mutation:error] items.sort() mutates the caller's array despite the non-mutation contract.
  evidence example.js:1: The function promises not to change the caller's items.
  evidence example.js:6: Array.sort() modifies the original items array in place.
exit: 1
```

`items.sort()`가 호출자의 배열을 바꾼다는 모의 진단입니다. lint 실행 전후 원본이 동일한지 검사합니다.

## fmt 실행 전

```js
/** Return sorted labels without changing the caller's items. */
export function sortedLabels(items, enabled) {
  if (!enabled) {
    return [];
  } else {
    items.sort();
    return items.map((item) => item.trim());
  }
}
```

## fmt 터미널 출력

```text
$ aqfmt example.js
Formatted example.js
warn UNDO_UNAVAILABLE: Formatting completed without Git undo support.
exit: 0
```

이 경고는 임시 디렉터리가 Git 저장소가 아니어서 undo 기록이 없다는 뜻입니다. 형식 변환 자체는 완료됐습니다.

## fmt 실행 후

```js
/** Return sorted labels without changing the caller's items. */
export function sortedLabels(items, enabled) {
  if (!enabled) {
    return [];
  }
  items.sort();
  return items.map((item) => item.trim());
}
```

`prefer-early-return`의 모의 변경 제안대로, 이미 return으로 끝나는 분기 뒤 `else`를 없애고 정상 경로의 들여쓰기를 줄였습니다. 기존 `items.sort()`의 입력 변경은 그대로입니다. 따라서 fmt 결과를 lint 문제의 수정이라고 보아서는 안 됩니다.

스크립트는 반환값과 실행 후 입력 배열을 12가지 입력/조건 조합에서 비교합니다. 이는 해당 사례의 동작 비교이며 모든 입력에 대한 동등성 증명은 아닙니다.

## 실제 Codex 경로

```sh
node examples/lint-and-format/run-demo.mjs --live
```

이 옵션은 mock 대신 기본 Codex 어댑터를 사용하며 모델 옵션은 `gpt-6.1-sol`입니다. 해당 모델을 사용할 수 있는 인증과 실행환경이 필요합니다. 규칙/검사 정책은 바꾸지 않습니다.

이번 환경에서 실제 실행은 모델 호출 전에 중단됐습니다.

- 기본 상태 저장소: `CODEX_CONFIG_PROBE_FAILED`, lint/fmt 모두 exit 2. Codex 상태 저장소를 초기화할 수 없었습니다.
- 새 임시 `CODEX_HOME`으로 상태 저장소만 분리한 실행: `CODEX_SANDBOX_PROBE_FAILED`, lint/fmt 모두 exit 2. sandbox 진단에서는 `app-server socket directory must be a user-owned directory with mode 0700` 오류가 확인됐습니다.
- 실제 Codex 경로에서 fmt 실행 후 코드는 원본과 같았습니다. [`live-output.txt`](./live-output.txt)는 두 번째 실행의 전체 출력입니다.

인증정보를 열람/복사하지 않았고, 보안 설정 변경이나 sandbox 검사 우회도 하지 않았습니다. 이 예제의 성공 출력은 실제 모델 품질을 검증하지 않습니다.

## 검증 기록

- Node.js v24.22.1, Codex CLI 0.166.0-alpha.1.
- 이 환경의 `pnpm -r build`는 pnpm 상태 디렉터리 준비 단계에서 실패했습니다. 설치된 tsdown을 각 패키지의 기존 build 스크립트와 같은 방식으로 실행해 core → rules → aqlint → aqfmt 빌드를 완료했습니다.
- `node examples/lint-and-format/run-demo.mjs`: exit 0. 내부 lint exit 1, fmt exit 0, 출력 코드 일치 및 12개 동작 관찰 비교 통과.
- `node --check`로 `run-demo.mjs`와 `mock-ai-bridge.mjs` 문법 검사 통과.
- 전체 프로젝트 테스트를 이 예제 작업에서 재실행한 것은 아닙니다.
