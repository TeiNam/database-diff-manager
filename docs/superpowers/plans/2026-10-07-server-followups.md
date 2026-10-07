# Server 후속 백로그

Plan 2(server) 실행 중 리뷰에서 미뤄 둔 항목과 보류 판정이다. 출처는 SDD 진행 기록(ledger)이다.

## Parked (판정 포함)
- Final: parked — 단일 IP 패스워드 스프레이(사용자명별 버킷) — ruling: 설계상 트레이드오프, IP 전용 2차 제한은 후속
- Final: parked — authz 라우트 목록 수동 유지 — ruling: printRoutes 비교 테스트는 후속

## Deferred minor
- Task 2: minor (deferred): migrate의 user_version 읽기가 트랜잭션 밖; AppError name 미설정; db.test 임시파일 try/finally 없음
- Task 3: minor (deferred): promptHidden이 Ctrl-D·ESC 시퀀스 미처리; 비밀번호 NFC 정규화 없음
- Task 3: minor (deferred): verifyPassword에 문자열이 아닌 stored가 오면 split 예외(타입상 불가)
- Task 4: minor (deferred): trustProxy 미설정 — 프록시 뒤 배포 시 로그인 제한이 전원 공용(배포 문서/설정으로 노출 필요); logger redact 현재 무효과
- Task 5: minor (deferred): viewer의 POST/PATCH 403, 잘못된 id 400 테스트 없음
- Task 6: minor (deferred): description 비우기가 NULL이 아닌 빈문자열; ensure*는 select-then-insert(트랜잭션 안에서만 안전); 이름만 PATCH·이름 충돌 409 테스트 없음
- Task 7: minor (deferred): version_no/revision_no 삭제 후 재사용; 덤프 헤더 DB명과 schemaName 불일치 경고 없음; tx 비재진입; 객체별 prepare 성능; rawDdl 객체 서식 변경 시 새 리비전
- Task 8: minor (deferred): 20파일×20MB 메모리 버퍼링; 중복 파일명 400 시 남은 part 미소비
