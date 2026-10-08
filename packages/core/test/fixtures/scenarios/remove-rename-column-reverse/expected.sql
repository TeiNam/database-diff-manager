-- [~] TABLE member
ALTER TABLE `member`
  ADD COLUMN `name` varchar(30) NOT NULL AFTER `id`,
  RENAME COLUMN `name` TO `full_name`;
