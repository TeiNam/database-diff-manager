# 비교 결과 HTML 리포트 — 설계

상태: 설계 승인(2026-10-16), 구현 전

## 1. 목적

스키마 비교 화면의 요약과 객체 diff 를 HTML 파일 하나로 내보낸다. 받은 사람은 이 도구에 접속하지 않고도 파일을 열어 보고, 공유하고, 보관하고, 인쇄할 수 있다.

## 2. 사용자 흐름

- 스키마 비교 화면(`/db/:dbId/schema/:schemaId`) 탭 줄 오른쪽에 "리포트 내보내기" 버튼을 둔다. 비교를 볼 수 있는 모든 역할(admin·dba·viewer)이 쓸 수 있다.
- 버튼을 누르면 지금 고른 BASE·TARGET 비교로 HTML 파일을 만들어 내려받는다. 객체 diff 는 지금 고른 보기 방식(SQL Split·SQL Unified·표)을 따른다.
- 버튼 옆 "추가 포함"·"삭제 포함" 체크박스(기본 켜짐)를 끄면 BASE 에 없는(추가된)·TARGET 에 없는(삭제된) 객체를 리포트에서 뺀다. 요약 통계·목록·객체 diff 가 모두 같은 기준으로 빠진다.
- 만드는 동안에는 버튼이 꺼지고 "리포트 만드는 중…"을 보여 준다. 실패하면 화면에 `role="alert"` 로 이유를 보여 준다.
- 비교 결과를 불러오는 동안에는 탭 줄과 함께 버튼도 보이지 않는다(화면은 "비교 결과를 불러오는 중…"만 보여 준다).

## 3. 리포트 내용

1. **머리말**
   - 제목: `{DB} › {스키마} 비교 리포트`. BASE·TARGET 의 DB 나 스키마가 다르면 `{BASE DB} › {스키마} ↔ {TARGET DB} › {스키마} 비교 리포트`
   - 뺀 객체: 추가·삭제 객체를 뺐으면 그 종류
   - BASE·TARGET: DB › 스키마, 버전 번호, 원본 파일 이름, 올린 사람, 올린 시각
   - 보기 방식, 만든 시각(로컬 시간과 시간대), 만든 사람(현재 사용자), 도구 버전(`__APP_VERSION__`)
2. **화면 안내**: 화면에 뜨는 안내를 같은 문구로 넣는다. MD 부분 비교 안내, 적용된 rename 목록과 출처, TARGET 완전성·BASE 불완전·예전 파서 안내가 그것이다.
3. **요약**: 통계(테이블 추가·삭제·변경, 컬럼·인덱스·제약 변경, 루틴, TARGET 완전성)와 변경 객체 목록. 목록의 각 항목은 같은 파일 안의 해당 객체 diff 로 가는 링크(`#객체 앵커`)다.
4. **객체 diff**
   - 맨 위에 왼쪽 BASE·오른쪽 TARGET 의 `DB › 스키마 v버전` 을 적는다. SQL Unified 는 좌우가 없어 `− BASE`·`+ TARGET` 으로 적는다.
   - 변경된 객체마다 머리(변경 표지·종류·이름·+/− 줄 수)와 본문을 넣는다.
   - 본문은 보기 방식에 따라 화면의 SQL diff, 표(테이블), 루틴 표와 같은 모양이다.
   - 객체마다 `<details open>` 으로 감싸 JS 없이 접고 펼 수 있다.
   - 화면의 "동일 구간 접기"는 파일에서 펼칠 수 없으므로 모두 펼친 상태로 넣는다.

넣지 않는 것: DDL·전환 탭, 복사 버튼, 이력 링크 등 화면 조작 요소.

## 4. 구조

서버는 바꾸지 않는다. 웹이 이미 불러온 비교 결과(`DiffResponse`)로 브라우저에서 파일을 만든다.

- **새 폴더 `apps/web/src/features/report/`**
  - `buildReportHtml(data: DiffResponse, opts: ReportOptions): string`: 순수 함수. 리포트 컴포넌트를 `react-dom/server` 의 `renderToStaticMarkup` 으로 렌더하고 `<!doctype html>` 문서로 감싼다.
    - `ReportOptions` 는 `{ mode, layout, generatedAt: Date, generatedBy: string, appVersion: string }` 이다.
  - `ReportDocument`: 머리말·안내·요약·객체 목록을 그린다.
  - `ReportObject`: 객체 머리와 본문을 그린다.
  - `report.css`: 리포트 전용 레이아웃·인쇄 스타일.
  - `ExportReportButton`: 버튼, 진행 표시, 오류 안내, 내려받기(Blob URL 과 `<a download>`).
- **재사용**
  - `SqlDiff`·`GridDiff`·`RoutineGrid`·`Mark`·`Icon` 을 그대로 쓴다. 모두 정적 렌더가 된다.
  - `SqlDiff` 는 `expanded` 로 동일 구간을 펼친다.
  - 요약 탭의 통계·안내·목록 계산과 문구는 표시용 컴포넌트로 뽑는다. 화면(항목이 버튼)과 리포트(항목이 링크)가 같은 컴포넌트를 쓰므로 문구가 한 곳에만 있다.
- **CSS**: 리포트 파일 안의 `<style>` 에 넣는다.
  - `tokens.css`(밝은 테마 변수)와 재사용 컴포넌트의 CSS 모듈 원문을 Vite `?inline` 으로 가져와 이어 붙이고 `report.css` 를 더한다.
  - 같은 빌드에서 나온 클래스 이름이라 화면과 같은 모양이 된다.
- **로딩**: 버튼을 누를 때 `import()` 로 리포트 모듈(`react-dom/server` 포함)을 불러 첫 화면 번들을 늘리지 않는다.

## 5. 파일 형식과 안전

- 문서 머리
  - `<!doctype html>`, `<html lang="ko" data-theme="light">`
  - `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width, initial-scale=1">`
  - `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`: 파일이 외부 자원을 읽거나 스크립트를 실행하지 못한다.
- 내용의 안전
  - `<script>` 가 없다.
  - 객체 이름·정의·COMMENT 등 모든 값은 React 텍스트 노드로 들어가 이스케이프된다. `dangerouslySetInnerHTML` 은 쓰지 않는다.
- 인쇄: `@media print` 에서 밝은 배경을 쓰고, 객체 머리가 페이지 끝에 홀로 남지 않게 한다(`break-after: avoid`). 객체는 `<details open>` 이라 그대로 인쇄된다.
- 파일 이름: `{DB}_{스키마}_v{BASE}-v{TARGET}_{YYYYMMDD-HHmm}.html`. DB 나 스키마가 다르면 `{BASE DB}_{스키마}_v{BASE}-{TARGET DB}_{스키마}_v{TARGET}_{YYYYMMDD-HHmm}.html`. 파일 이름에 쓸 수 없는 글자(`/\:*?"<>|` 와 제어 문자)는 `_` 로 바꾼다.

## 6. 큰 비교

- 객체 수와 상관없이 모든 변경 객체를 넣는다. 화면은 51번째 카드부터 본문을 접지만 리포트는 모두 펼친다.
- 파일은 한 번에 문자열로 만든다. 객체가 수천 개면 몇 초 걸릴 수 있어, 버튼에 진행 표시를 둔다.

## 7. 오류 처리

- 리포트 모듈을 불러오지 못하거나, 만들거나 내려받다 실패하면 버튼 옆에 `role="alert"` 로 "리포트를 만들지 못했습니다: {이유}"를 보여 준다. 다시 누르면 다시 시도한다.

## 8. 검증

- 단위 테스트(`apps/web/test/report.test.tsx`)
  - 머리말: DB·스키마·버전·만든 사람·만든 시각·보기 방식이 들어간다.
  - 요약 목록 링크의 `href` 가 객체 섹션의 `id` 와 같다.
  - 보기 방식별 본문: SQL Split·SQL Unified·표, 루틴은 루틴 표.
  - 안전
    - 객체 이름·COMMENT 에 넣은 `<script>`·`"`·`&` 가 이스케이프된다.
    - 문서에 `<script` 가 없고 CSP meta 가 있다.
  - 변경 없는 비교, MD 부분 비교 안내, rename 안내.
  - 파일 이름 정리.
- 버튼 테스트
  - 누르면 Blob 이 만들어지고 정한 파일 이름으로 내려받는다.
  - 만드는 동안 버튼이 꺼진다.
  - 실패하면 안내가 뜬다.
- 화면 요약 탭 회귀: 표시용 컴포넌트로 뽑은 뒤에도 기존 요약 탭 테스트가 그대로 통과한다.
- 빌드 확인: 단위 테스트는 CSS 모듈 이름을 바꾸지 않아(`non-scoped`) 빌드한 이름과 넣은 CSS 가 맞는지 잡지 못한다. 그래서 프로덕션 빌드를 띄워 리포트를 한 번 내려받고, 열었을 때 화면과 같은 스타일이 붙는지 브라우저로 확인한다.

## 9. 범위 밖

- DDL·전환 탭을 리포트에 넣기
- PDF 직접 만들기. 브라우저 인쇄로 PDF 를 만들 수 있다.
- 서버 URL 로 리포트 공유, 리포트 보관 이력
