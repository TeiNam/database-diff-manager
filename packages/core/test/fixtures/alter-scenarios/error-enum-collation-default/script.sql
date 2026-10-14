-- COLLATE utf8mb4_bin 컬럼에서 대소문자만 같은 'A' 는 ENUM('a','b') 의 멤버가 아니다
ALTER TABLE member ADD COLUMN w ENUM('a','b') COLLATE utf8mb4_bin DEFAULT 'A';
