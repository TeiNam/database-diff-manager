USE __DB__;
ALTER TABLE __DB__.member ADD COLUMN q INT;
CREATE INDEX ix_q ON `__DB__`.`member` (q);
RENAME TABLE __DB__.orders TO __DB__.orders2;
