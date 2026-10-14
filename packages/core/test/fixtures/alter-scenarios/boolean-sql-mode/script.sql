-- 리뷰 12회차 Claude F4: 따옴표 없는 단어 FALSE·TRUE 는 MySQL 에서 정수 0·1 이라 sql_mode = FALSE 는 0 처럼 빈 모드다 (8.0.46·8.4.11 실측 — 11회차는 모드 이름으로 읽어
-- 1231 로 거부했다). FALSE 로 정한 뒤 만든 프로시저는 빈 SQL_MODE 를 기억한다. TRUE 는 REAL_AS_FLOAT 라 RE_EXPORT 로 거부한다 (단위 테스트)
SET sql_mode = FALSE;
CREATE PROCEDURE p_false_mode() SELECT 1;
SET sql_mode = DEFAULT;
ALTER TABLE member ADD COLUMN nick VARCHAR(20);
