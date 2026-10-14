-- 엄격 SQL_MODE 의 MySQL 은 3072 바이트(utf8mb4 768자)를 넘는 키 파트를 1071 로 거부한다. 엄격하지 않은 세션은 prefix(url(768))로 줄여 받으므로 우리는 SQL_MODE 와 상관없이 거부한다
ALTER TABLE member ADD url VARCHAR(1000), ADD INDEX ix_url (url);
