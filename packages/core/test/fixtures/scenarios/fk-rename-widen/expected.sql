-- [~] TABLE comment
-- RENAME INDEX x TO x: FK 를 다시 추가할 때 FK 가 만든 인덱스 이름이 FK 이름으로 바뀌지 않도록 고정합니다
ALTER TABLE `comment`
  DROP FOREIGN KEY `fk_comment_member`,
  RENAME INDEX `fk_comment_member` TO `fk_comment_member`;

-- [~] TABLE member
ALTER TABLE `member`
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT;

-- [~] TABLE comment
ALTER TABLE `comment`
  MODIFY COLUMN `member_id` bigint unsigned NOT NULL;

-- [~] TABLE comment
ALTER TABLE `comment`
  ADD CONSTRAINT `fk_comment_owner` FOREIGN KEY (`member_id`) REFERENCES `member` (`id`);
