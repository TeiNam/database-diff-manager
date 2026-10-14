-- 이름이 같은 저장 함수가 있어도 이름과 괄호 사이에 공백·주석·줄바꿈을 끼운 내장 함수 호출(CONCAT (·IFNULL/**/(·COALESCE 와 줄바꿈)은 내장 함수를 부른다 (리뷰 9회차 R9-1).
-- 저장 함수는 @m 을 바꾸므로 MySQL 이 저장 함수를 불렀다면 뒤의 SET sql_mode = @m 이 다른 SQL_MODE 를 프로시저에 남긴다. 바로 '(' 가 붙어야 내장 함수인 NOW 는 붙여 쓴다.
-- 진짜 저장 함수 호출(fn_bump) 뒤에도 값을 버리는 세션 변수의 복원(SET UNIQUE_CHECKS = @OLD_UNIQUE_CHECKS)은 받는다 (리뷰 9회차)
SET @OLD_UNIQUE_CHECKS = @@UNIQUE_CHECKS, UNIQUE_CHECKS = 0;
SET @m = 'NO_ENGINE_SUBSTITUTION';
DELIMITER //
CREATE FUNCTION `concat`(a VARCHAR(10), b VARCHAR(10)) RETURNS VARCHAR(10) DETERMINISTIC NO SQL BEGIN SET @m = 'STRICT_TRANS_TABLES'; RETURN a; END//
CREATE FUNCTION `ifnull`(a INT, b INT) RETURNS INT DETERMINISTIC NO SQL BEGIN SET @m = 'STRICT_TRANS_TABLES'; RETURN a; END//
CREATE FUNCTION `coalesce`(a INT, b INT) RETURNS INT DETERMINISTIC NO SQL BEGIN SET @m = 'STRICT_TRANS_TABLES'; RETURN a; END//
CREATE FUNCTION fn_bump(x INT) RETURNS INT DETERMINISTIC NO SQL BEGIN SET @touched = x; RETURN x + 1; END//
DELIMITER ;
SELECT CONCAT ('a', 'b'), IFNULL/**/(NULL, 1), COALESCE
(NULL, 2), NOW();
SET sql_mode = @m;
CREATE PROCEDURE mark_spacing() SELECT 1;
UPDATE member SET age = fn_bump(age) WHERE id = 0;
SET UNIQUE_CHECKS = @OLD_UNIQUE_CHECKS;
DROP FUNCTION `concat`;
DROP FUNCTION `ifnull`;
DROP FUNCTION `coalesce`;
DROP FUNCTION fn_bump;
ALTER TABLE member ADD COLUMN nick VARCHAR(20);
