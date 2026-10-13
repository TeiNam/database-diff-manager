ALTER TABLE member ADD INDEX (age), ADD UNIQUE (name), ADD INDEX ix_created (created_at DESC), ADD FULLTEXT INDEX ft_memo (memo) WITH PARSER ngram, ADD INDEX ix_email_prefix (email(10)) COMMENT '접두';
ALTER TABLE member ADD KEY (age), RENAME INDEX name_age TO ix_name_age, ALTER INDEX ix_created INVISIBLE;
CREATE INDEX ix_amount USING BTREE ON orders (amount) ALGORITHM=INPLACE LOCK=NONE;
DROP INDEX ix_email_prefix ON member;
ALTER TABLE member DROP INDEX `name`;
