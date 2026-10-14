-- SHOW CREATE 는 빈 인덱스 COMMENT 를 찍지 않는다 (ALTER TABLE ADD INDEX·CREATE INDEX·CREATE TABLE 모두)
ALTER TABLE member ADD INDEX ix_age (age) COMMENT '', ADD UNIQUE KEY uq_name (name) COMMENT 'x';
CREATE INDEX ix_created ON member (created_at) COMMENT '';
CREATE TABLE t (a INT, KEY ka (a) COMMENT '');
