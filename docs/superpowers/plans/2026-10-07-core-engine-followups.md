# Core 엔진 후속 백로그

Plan 1(core) 실행 중 리뷰에서 나온 항목 가운데 미뤄 둔 것(deferred)과 판정을 내리고 보류한 것(parked)이다. 출처는 SDD 진행 기록(ledger)이다.

## Parked (판정 포함)
- Follow-up: parked — 안전 CONVERT 판정이 TARGET에서 DROP/비문자열로 바뀌는 BASE 문자열 컬럼을 검사 안 함 — ruling: 실재하지만 드묾(같은 문자셋/ascii 테이블에 넓은 명시 charset 컬럼을 동시에 DROP). strict 모드(기본)에선 1366으로 드러나 실패, 후속에서 BASE 전체 검사로 확장
- Follow-up: parked — 옵션 경로 latin1→utf8mb4 TEXT MODIFY 길이 초과 안내 없음 — ruling: strict 모드에서 오류로 드러남, 안내 추가는 후속
- Follow-up: parked — legacy MD에 문자열 기본값 'NULL'이 있으면 v2로 오판 — ruling: 극히 드묾, 휴리스틱 한계로 README에 기록 후속

## Deferred minor
- Task 1: minor (deferred): quoteString \r/\0/\Z, 미종결 주석, # 주석, "" 이중따옴표 테스트 없음
- Task 1: minor (deferred): lexer 엣지 — \%/\_ 백슬래시 소실, 1e5/-1 분리 토큰, "--\n" 주석 미인식, 미종결 /*! 허용
- Task 1: minor (deferred): lexer.ts:13-14 정규식에 이스케이프(￿) 대신 U+FFFF 문자가 그대로 들어감
- Task 2: minor (deferred): parse-table.ts toks.at(-1)?.v === ';' 토큰 타입 미확인 (COMMENT=';' 끝 오파싱 가능)
- Task 2: minor (deferred): partition method에 'KEY ALGORITHM = 1' 같은 옵션까지 포함됨
- Task 2: minor (deferred): normalizeType 직접 테스트, STORED/ON UPDATE/SET NULL/count/끝 ; 테스트 없음; 모듈 레벨 파싱
- Task 2: minor (deferred): ParseError name 미설정
- Task 3: minor (deferred): 비-CREATE 문장/IF NOT EXISTS 이름 추출, DEFINER에 공백 포함 시 VIEW_RE 실패
- Task 3: minor (deferred): 실패 뷰 경로·LOCAL CHECK OPTION·columnList 테스트 없음
- Task 4: minor (deferred): 프린터 예외가 파싱 실패로 기록됨; COLUMN_INT_WIDTH 대소문자 구분; 줄 끝 trim이 뷰 본문·문자열에도 적용; 한 줄 DDL 항상 왕복 경고
- Task 5: minor (deferred): 거부·중복 rename 매핑 무피드백; parseError 테이블끼리 가짜 rename 후보; ViewDiff에 skipped 없음; partitions/mysql8 테스트가 다른 변경 없음을 단언하지 않음
- Task 6: minor (deferred): 뷰 위상정렬 테스트 없음; sortViews 부분문자열 의존 탐지; COMMENT 안내 중복 가능; CHANGE/rename+move/인덱스 재생성/PK 재생성/옵션 리셋/FK modify/DROP VIEW/partial 헤더 테스트 없음; FK 컬럼 타입 변경 시 3780 경고 없음
- Task 6: minor (deferred): 파티션 추가/삭제와 경계 변경이 겹칠 때 from-empty 경로 범위 보존 미검증
- Task 7: minor (deferred): cells() 마지막 열 외 파이프 미처리; INDEX_RE가 prefix/함수형 파트 오파싱; 실패 섹션이 항상 table로 들어감; 교차검증이 뷰 미검사
- Task 7: minor (deferred): helpers.ts 주석 td-export 0.1.10 → 0.1.14; 복합 FK MD 형식은 가정(실샘플 없음)
- Task 8: minor (deferred): 실증 테스트에 "생성 DDL 비어있지 않음" 가드 없음; it_* DB 미정리; 포트/자격 하드코딩, test:mysql에 down 없음; compose 포트가 0.0.0.0 바인딩(127.0.0.1 권장); Docker Hub 로그인 필요(ECR 미러 재태깅)
