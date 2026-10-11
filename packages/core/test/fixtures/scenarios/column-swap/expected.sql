-- [~] TABLE member
ALTER TABLE `member`
  RENAME COLUMN `first_name` TO `last_name`,
  RENAME COLUMN `last_name` TO `first_name`;
