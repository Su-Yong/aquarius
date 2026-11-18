# aqfmt 데모 · 영화 예매

영화 예매 안내, 할인 금액, 영수증을 담은 파일 세 개를 한 번에 바꿨습니다. [.aqfmtrc.json](.aqfmtrc.json)은 aqfmt에 등록된 포맷 규칙 3개를 모두 켭니다.

| 예제                                                                        | 적용 규칙                   | 한눈에 보이는 변화                                                                                 |
| --------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| 예매 안내 [Before](before/reservation.mjs) · [After](after/reservation.mjs) | `prefer-early-return`       | 상영 일정 없음과 좌석 부족을 먼저 처리해 중첩을 없앴습니다.                                        |
| 할인 금액 [Before](before/discount.mjs) · [After](after/discount.mjs)       | `name-compound-conditions`  | 회원, 평일, 4장 이상, 최소 금액 조건을 `isEligibleForGroupDiscount`라는 이름으로 읽을 수 있습니다. |
| 영수증 [Before](before/receipt.mjs) · [After](after/receipt.mjs)            | `separate-responsibilities` | 수량과 금액 합계는 `summarizeTickets`에서 계산하고, 영수증 함수는 출력 문구를 만듭니다.            |

## Windows 실행 결과

Windows PowerShell에서 기본 Codex 어댑터와 `gpt-6.1-terra`를 사용했습니다. Codex CLI 0.159.2의 응답을 aqfmt가 검증하고 파일 3개를 저장했습니다. 종료 코드는 `0`이고 건너뛴 규칙과 오류는 각각 0개였습니다.

```text
> node $aqfmtCli --config .aqfmtrc.json --format json
[00:00] Preparing
[00:00] Preparing rules
[00:00] Selecting files
[00:00] Formatting files with AI
[00:00] Locating Codex
[00:00] Preparing snapshot (4 context files)
[00:00] Preparing snapshot 1/4: .aqfmtrc.json
[00:00] Preparing snapshot 4/4: reservation.mjs
[00:00] Preparing rule files (3 rules)
[00:00] Checking Codex configuration
[00:00] Checking Codex read-only access
[00:02] Starting Codex analysis
[00:02] AI analyzing
[00:10] AI analyzing
[00:20] AI analyzing
[00:23] Inspecting rule aquarius/style/prefer-early-return
[00:23] AI analyzing; last referenced: rule aquarius/style/prefer-early-return
[00:26] Inspecting rule aquarius/readability/name-compound-conditions
[00:27] AI analyzing; last referenced: rule aquarius/readability/name-compound-conditions
[00:30] AI analyzing; last referenced: rule aquarius/readability/name-compound-conditions
[00:31] Inspecting rule aquarius/refactor/separate-responsibilities
[00:31] AI analyzing; last referenced: rule aquarius/refactor/separate-responsibilities
[00:37] Inspecting project
[00:37] Inspecting discount.mjs
[00:37] Inspecting reservation.mjs
[00:37] Inspecting receipt.mjs
[00:38] AI analyzing; last referenced: receipt.mjs
[00:40] AI analyzing; last referenced: receipt.mjs
[00:43] Inspecting discount.mjs
[00:43] Inspecting reservation.mjs
[00:43] Inspecting receipt.mjs
[00:43] Inspecting .aqfmtrc.json
[00:44] Inspecting receipt.mjs
[00:44] AI analyzing; last referenced: receipt.mjs
[00:50] AI analyzing; last referenced: receipt.mjs
[01:00] AI analyzing; last referenced: receipt.mjs
[01:05] Reading Codex response
[01:05] Checking changes
[01:05] Writing changes
{
  "changedFiles": [
    "discount.mjs",
    "receipt.mjs",
    "reservation.mjs"
  ],
  "skippedRules": [],
  "warnings": [
    {
      "code": "UNDO_UNAVAILABLE",
      "ruleIds": [],
      "paths": [],
      "message": "Formatting completed without Git undo support."
    }
  ],
  "errors": []
}
Exit code: 0
```

`UNDO_UNAVAILABLE`은 Git 저장소 밖의 임시 폴더에서 실행했기 때문에 되돌리기 기록이 없다는 안내입니다.

## 실제 diff

`git -c diff.suppressBlankEmpty=true diff --no-index -- before after`로 세 파일을 비교했습니다. `before/`에는 실행 입력을, `after/`에는 aqfmt가 저장한 결과를 줄바꿈까지 그대로 담았습니다.

```diff
diff --git a/before/discount.mjs b/after/discount.mjs
index 2d95241..018efd8 100644
--- a/before/discount.mjs
+++ b/after/discount.mjs
@@ -2,12 +2,13 @@ export function discountedTicketPrice(ticket, customer) {
   const originalPrice = ticket.price;
   let discount = 0;

-  if (
+  const isEligibleForGroupDiscount =
     customer.isMember &&
     ticket.isWeekday &&
     ticket.quantity >= 4 &&
-    originalPrice >= 10000
-  ) {
+    originalPrice >= 10000;
+
+  if (isEligibleForGroupDiscount) {
     discount = Math.floor(originalPrice * 0.2);
   }

diff --git a/before/receipt.mjs b/after/receipt.mjs
index 1047e5c..e6768ee 100644
--- a/before/receipt.mjs
+++ b/after/receipt.mjs
@@ -1,4 +1,4 @@
-export function ticketReceipt(tickets) {
+function summarizeTickets(tickets) {
   let totalQuantity = 0;
   let totalPrice = 0;

@@ -7,6 +7,11 @@ export function ticketReceipt(tickets) {
     totalPrice += ticket.price * ticket.quantity;
   }

+  return { totalQuantity, totalPrice };
+}
+
+export function ticketReceipt(tickets) {
+  const { totalQuantity, totalPrice } = summarizeTickets(tickets);
   const lines = ["영화 예매 영수증"];

   for (const ticket of tickets) {
diff --git a/before/reservation.mjs b/after/reservation.mjs
index a5c7f5e..c543aff 100644
--- a/before/reservation.mjs
+++ b/after/reservation.mjs
@@ -1,15 +1,18 @@
 export function reservationMessage(show, request) {
-  if (show) {
-    if (request.tickets > show.seatsLeft) {
-      return "남은 좌석이 부족합니다.";
-    } else {
-      if (request.isMember && request.tickets >= 4 && show.isWeekday) {
-        return "단체 할인으로 예매되었습니다.";
-      } else {
-        return "정상가로 예매되었습니다.";
-      }
-    }
-  } else {
+  if (!show) {
     return "상영 일정이 없습니다.";
   }
+
+  if (request.tickets > show.seatsLeft) {
+    return "남은 좌석이 부족합니다.";
+  }
+
+  const isEligibleForGroupDiscount =
+    request.isMember && request.tickets >= 4 && show.isWeekday;
+
+  if (isEligibleForGroupDiscount) {
+    return "단체 할인으로 예매되었습니다.";
+  }
+
+  return "정상가로 예매되었습니다.";
 }
```

## 다시 실행하기

Codex에 로그인한 뒤 일반 Windows PowerShell에서 저장소 루트로 이동해 실행합니다. `before/`의 파일을 임시 폴더에 복사한 뒤 폴더 전체를 대상으로 실행합니다.

```powershell
pnpm build
$aqfmtCli = (Resolve-Path 'packages/aqfmt/dist/cli.mjs').Path
$run = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ('aqfmt-demo-' + [guid]::NewGuid()))
Copy-Item 'examples/aqfmt-demo/.aqfmtrc.json', 'examples/aqfmt-demo/before/*.mjs' $run.FullName
Push-Location $run.FullName
try {
  node $aqfmtCli --config .aqfmtrc.json --format json
} finally {
  Pop-Location
}
```

이번 실행에서는 Codex 앱에서 상속된 `CODEX_WINDOWS_REGISTERED_CORE`와 `CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY`를 실행에 사용한 PowerShell 프로세스에서만 비웠습니다.

`node --test examples/aqfmt-demo/demo.test.mjs`로 예매 안내, 할인 금액, 영수증을 비교할 수 있습니다. 실행 전후 13개 사례가 모두 같은 예상 결과를 반환했습니다.
