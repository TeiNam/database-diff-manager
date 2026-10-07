-- [~] TABLE member
ALTER TABLE `member`
  RENAME COLUMN `nick` TO `nickname`,
  RENAME INDEX `ix_old` TO `ix_email`;
