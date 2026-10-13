-- 스키마를 바꾸지 않는 문장(트랜잭션 제어·LOCK·UNLOCK TABLES·데이터 문장)은 무시한다. MySQL 도 SHOW CREATE 결과가 그대로다
START TRANSACTION;
INSERT INTO member (email, name) VALUES ('a@example.com', 'a');
UPDATE member SET name = 'b' WHERE email = 'a@example.com';
COMMIT;
LOCK TABLES member WRITE;
ALTER TABLE member ADD COLUMN nick VARCHAR(20);
UNLOCK TABLES;
BEGIN;
DELETE FROM member WHERE email = 'a@example.com';
ROLLBACK;
REPLACE INTO member (id, email) VALUES (10, 'r@example.com');
TRUNCATE TABLE orders;
