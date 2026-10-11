-- [~] TABLE member
ALTER TABLE `member`
  DROP COLUMN `name`,
  RENAME COLUMN `full_name` TO `name`;
