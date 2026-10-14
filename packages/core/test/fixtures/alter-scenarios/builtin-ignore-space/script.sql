-- 리뷰 10회차 R10-1: IGNORE_SPACE 세션에서는 바로 '(' 가 붙어야 하는 내장 함수 이름(NOW …)도 공백·줄바꿈만 끼우면 내장 함수이고, 9회차 목록에 없던 JSON_LENGTH 같은
-- 내장 함수는 공백·주석과 상관없이 내장 함수다. 이름이 같은 저장 함수(@m 을 바꾼다)가 있어도 MySQL 은 내장 함수를 불러 @m 이 그대로이므로 뒤 프로시저가 @m 의 SQL_MODE 를 기억한다
DELIMITER //
CREATE FUNCTION `now`() RETURNS INT DETERMINISTIC NO SQL BEGIN SET @m = 'STRICT_TRANS_TABLES'; RETURN 1; END//
CREATE FUNCTION `json_length`(a TEXT) RETURNS INT DETERMINISTIC NO SQL BEGIN SET @m = 'STRICT_TRANS_TABLES'; RETURN 1; END//
DELIMITER ;
SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'IGNORE_SPACE';
SET @m = 'NO_ENGINE_SUBSTITUTION';
SELECT NOW (), NOW
(), JSON_LENGTH ('{}'), JSON_LENGTH/**/('[]');
SET SQL_MODE = @m;
CREATE PROCEDURE mark_ignore_space() SELECT 1;
SET SQL_MODE = @OLD_SQL_MODE;
DROP FUNCTION `now`;
DROP FUNCTION `json_length`;
ALTER TABLE member ADD COLUMN nick VARCHAR(20);
