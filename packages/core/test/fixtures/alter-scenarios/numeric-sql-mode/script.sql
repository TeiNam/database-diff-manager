-- 리뷰 11회차 Claude F8: MySQL 은 정수로 쓴 sql_mode 를 모드 비트로 읽어 0 은 빈 모드다 (8.0.46·8.4.11 실측). 0 으로 정한 뒤 만든 프로시저는 빈 SQL_MODE 를 기억한다.
-- 그 밖의 숫자는 비트를 재현하지 않아 RE_EXPORT 로 거부한다 (단위 테스트)
SET sql_mode = 0;
CREATE PROCEDURE p_empty_mode() SELECT 1;
SET sql_mode = DEFAULT;
ALTER TABLE member ADD COLUMN nick VARCHAR(20);
