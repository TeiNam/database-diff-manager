-- 바이트 한도 경계 (리뷰 3회차 I-1): 키 파트는 3072 바이트(ROW_FORMAT=COMPACT 는 767)까지, VARCHAR 는 65535 바이트까지 MySQL 이 쓴 그대로 받는다
CREATE TABLE bl (
  id INT PRIMARY KEY,
  c VARCHAR(768),
  t TEXT,
  b BLOB,
  l VARCHAR(3072) CHARACTER SET latin1,
  KEY ix_c (c),
  KEY ix_t (t(768)),
  KEY ix_b (b(3072)),
  KEY ix_l (l)
) DEFAULT CHARSET=utf8mb4;
CREATE TABLE bc (id INT PRIMARY KEY, c VARCHAR(191), KEY ix_c (c)) DEFAULT CHARSET=utf8mb4 ROW_FORMAT=COMPACT;
CREATE TABLE bv (c VARCHAR(16383)) DEFAULT CHARSET=utf8mb4;
ALTER TABLE member ADD url VARCHAR(1000), ADD INDEX ix_url (url(768)), ADD FULLTEXT KEY ft_url (url);
