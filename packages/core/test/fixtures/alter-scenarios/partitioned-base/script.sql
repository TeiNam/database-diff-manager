ALTER TABLE logs ADD COLUMN src VARCHAR(10) NOT NULL DEFAULT 'app' AFTER id, ADD INDEX ix_src (src);
ALTER TABLE logs MODIFY created DATETIME NOT NULL;
ALTER TABLE logs DROP COLUMN msg;
ALTER TABLE logs ADD UNIQUE KEY uq_src (src, created);
ALTER TABLE cols ADD COLUMN extra INT, ADD UNIQUE KEY uq_cols (`my col`, created, msg);
ALTER TABLE keyed COMMENT = 'keyed';
RENAME TABLE keyed TO keyed2;
