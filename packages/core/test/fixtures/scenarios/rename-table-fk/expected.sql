-- [>] TABLE member
RENAME TABLE `members` TO `member`;

-- [>] TABLE member
ALTER TABLE `member`
  RENAME COLUMN `code` TO `member_code`;
