CREATE TABLE IF NOT EXISTS member (x INT);
CREATE TABLE `tag` (
  tag_id int(11) NOT NULL AUTO_INCREMENT,
  label varchar(30) NOT NULL UNIQUE,
  slug VARCHAR(30) CHARACTER SET latin1 COLLATE latin1_bin NOT NULL,
  weight double precision DEFAULT 1.5,
  active bool NOT NULL DEFAULT true,
  created timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note text,
  PRIMARY KEY (tag_id),
  KEY ix_slug (slug),
  UNIQUE KEY uq_slug_label (slug, label)
) ENGINE=innodb DEFAULT CHARSET=utf8mb4 COMMENT='태그';
CREATE TABLE plain (id INT PRIMARY KEY, name VARCHAR(10));
