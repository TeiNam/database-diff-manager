-- [~] TABLE member
ALTER TABLE `member`
  DROP FOREIGN KEY `fk_member_team`;

-- [~] TABLE member
ALTER TABLE `member`
  DROP CHECK `chk_name`,
  DROP INDEX `uq_name`,
  DROP INDEX `idx_name_code`,
  DROP COLUMN `name`,
  RENAME COLUMN `full_name` TO `name`,
  ADD UNIQUE INDEX `uq_name` (`name`),
  ADD INDEX `idx_name_code` (`name`,`code`),
  ADD CONSTRAINT `chk_name` CHECK ((`name` <> _utf8mb4''));

-- [~] TABLE member
ALTER TABLE `member`
  ADD CONSTRAINT `fk_member_team` FOREIGN KEY (`name`) REFERENCES `team` (`code`);
