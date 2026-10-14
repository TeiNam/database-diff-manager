-- 무시하는 문장이 저장 함수를 불러도 받는다 (리뷰 8회차): 도우미 함수를 만들어 데이터를 고친 뒤 지우는 마이그레이션, 이름이 같은 저장 함수가 있어도
-- 내장 함수를 부르는 CONCAT(, 숫자로 시작하는 이름(1fn())·현재 스키마로 한정한 호출. 함수가 바꿨을 수 있는 사용자 변수를 뒤에서 읽지 않으므로 모델은 MySQL 과 같다
DELIMITER //
CREATE FUNCTION fn_bump(x INT) RETURNS INT DETERMINISTIC NO SQL BEGIN SET @touched = x; RETURN x + 1; END//
DELIMITER ;
CREATE FUNCTION `concat`(a VARCHAR(10)) RETURNS VARCHAR(10) DETERMINISTIC NO SQL RETURN a;
CREATE FUNCTION `1fn`() RETURNS INT DETERMINISTIC NO SQL RETURN 1;
INSERT INTO member (email, name, age) VALUES (CONCAT('a', '@example.com'), 'a', fn_bump(1));
UPDATE member SET age = fn_bump(age) WHERE email = 'a@example.com';
SELECT __DB__.fn_bump(1), `fn_bump`(2), 1fn();
DO fn_bump(3);
DROP FUNCTION fn_bump;
DROP FUNCTION `concat`;
DROP FUNCTION `1fn`;
ALTER TABLE member ADD COLUMN nick VARCHAR(20);
