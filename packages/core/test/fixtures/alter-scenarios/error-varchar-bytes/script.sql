-- 엄격 SQL_MODE 의 MySQL 은 65535 바이트(utf8mb4 16383자)를 넘는 VARCHAR 를 1074 로 거부한다. 엄격하지 않은 세션은 mediumtext 로 바꿔 받는다
ALTER TABLE member ADD body VARCHAR(16384);
