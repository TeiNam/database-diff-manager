-- ROW_FORMAT=COMPACT 의 키 파트 한도는 767 바이트(utf8mb4 191자)다. MySQL 은 같은 문장에서 바꾼 ROW_FORMAT 으로 키를 본다
ALTER TABLE member ADD c VARCHAR(255), ROW_FORMAT=COMPACT, ADD INDEX ix_c (c);
