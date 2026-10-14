-- 리뷰 10회차: 저장 함수 호출 뒤 함수가 바꿨을 수 있는 @OLD_FOREIGN_KEY_CHECKS 에서 되돌린 FOREIGN_KEY_CHECKS 는 그 SET 에서 거부하지 않고 모르는 값으로 둔다.
-- 뒤 문장이 켜져 있으면 FK 검사에 걸리면(부모 없는 FK) 켜져 있었는지 알 수 없어 MySQL 오류 번호 대신 다시 추출하도록 안내한다 (MySQL 은 되돌린 값 1 로 1824)
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;
CREATE FUNCTION fn_bump(x INT) RETURNS INT DETERMINISTIC NO SQL RETURN x + 1;
UPDATE member SET age = fn_bump(age);
DROP FUNCTION fn_bump;
SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
CREATE TABLE audit (id INT PRIMARY KEY, ref_id INT, FOREIGN KEY (ref_id) REFERENCES later_table (id));
