-- [~] TABLE lit
ALTER TABLE `lit`
  MODIFY COLUMN `b2` binary(2) DEFAULT 'B\0',
  MODIFY COLUMN `b4` varbinary(4) DEFAULT 'A''\r\\',
  ADD COLUMN `b6` varbinary(3) DEFAULT '\0''\\';
