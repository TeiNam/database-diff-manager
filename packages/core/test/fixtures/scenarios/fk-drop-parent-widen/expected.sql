-- [~] TABLE comment
ALTER TABLE `comment`
  DROP FOREIGN KEY `fk_comment_member`;

-- [~] TABLE member
ALTER TABLE `member`
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT;
