# Web 후속 과제 (backlog)

feat/web 최종 리뷰에서 머지 후로 미룬 항목. 우선순위 순.

## 접근성
- 트리: aria-setsize/posinset, 필터 후 포커스 유지, 현재 스키마 접기, group total, diff 로딩 중 expanded 표시
- Segmented(SQL/표, Split/Unified)·DDL 방향 radiogroup 화살표 키 탐색 — 공용 Segmented 컴포넌트로 한 번에
- SummaryTab 행 aria-label, skip link(`#main` 은 있음), 테마 버튼 title 동적화

## 동작
- 비밀번호 재설정: `prompt` 대신 type=password 대화상자
- 로그인 후 원래 보던 화면으로 복귀 (`state.from`)
- `me` 요청 실패 시 '관리자만' 문구 대신 오류 표시, resetError 초기화
- 버전 이력 화면에서 트리가 객체 목록을 보여주지 않음(버전 선택 없음)
- 대용량 업로드 미리보기 파싱을 Web Worker 로
- datalist 열린 상태에서 Esc 가 대화상자를 닫음

## 서버/정적 서빙
- `/assets/*` 등 확장자 있는 경로는 SPA 폴백 제외(없는 자산은 404), HEAD 딥링크 처리
- `wildcard:false` → 웹 재빌드 시 서버 재시작 필요 (README 에 기재됨)

## 코드 품질
- 깨진 JSON 응답 시 `res.json()` SyntaxError 메시지 정리, invalidateQueries 반환
- alignByKey 키 유일성 주석·CRLF·엣지 테스트, rename 전 이름으로 objectEntry 조회
- format.test 의 TZ 설정을 vitest config 로 이동
