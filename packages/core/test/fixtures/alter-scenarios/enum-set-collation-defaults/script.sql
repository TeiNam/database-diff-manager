-- ENUM·SET 기본값의 멤버는 컬럼 콜레이션으로 찾는다: _bin·_cs 는 대소문자까지 같은 멤버, _ci 는 대소문자를 무시한다 (테이블에서 물려받은 콜레이션도 같다)
ALTER TABLE e ALTER COLUMN v SET DEFAULT 'A', ALTER COLUMN s SET DEFAULT 'A,a';
ALTER TABLE e ADD COLUMN y SET('a','b') COLLATE utf8mb4_0900_as_cs DEFAULT 'b,a', ADD COLUMN u ENUM('a','b') DEFAULT 'B', ADD COLUMN w ENUM('x','y') CHARACTER SET latin1 COLLATE latin1_general_cs DEFAULT 'y';
ALTER TABLE inh ALTER COLUMN v SET DEFAULT 'A', ADD COLUMN w SET('x','y') DEFAULT 'y';
CREATE TABLE cs (id INT PRIMARY KEY, v ENUM('x','y') DEFAULT 'y') DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
