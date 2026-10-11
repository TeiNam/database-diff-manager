-- [~] TABLE comment
-- FK 컬럼(또는 참조 컬럼)의 타입·문자셋·콜레이션이 바뀌어 FK 를 먼저 삭제하고 마지막에 다시 추가합니다 (error 3780)
ALTER TABLE `comment`
  DROP FOREIGN KEY `fk_comment_member`;

-- [~] TABLE post
-- RENAME INDEX x TO x: FK 를 다시 추가할 때 FK 가 만든 인덱스 이름이 FK 이름으로 바뀌지 않도록 고정합니다
-- FK 컬럼(또는 참조 컬럼)의 타입·문자셋·콜레이션이 바뀌어 FK 를 먼저 삭제하고 마지막에 다시 추가합니다 (error 3780)
ALTER TABLE `post`
  DROP FOREIGN KEY `fk_post_member`,
  RENAME INDEX `ix_post_member` TO `ix_post_member`;

-- [~] TABLE member
ALTER TABLE `member`
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT;

-- [~] TABLE comment
ALTER TABLE `comment`
  MODIFY COLUMN `member_id` bigint unsigned NOT NULL;

-- [~] TABLE post
ALTER TABLE `post`
  MODIFY COLUMN `member_id` bigint unsigned DEFAULT NULL;

-- [~] TABLE comment
ALTER TABLE `comment`
  ADD CONSTRAINT `fk_comment_member` FOREIGN KEY (`member_id`) REFERENCES `member` (`id`) ON DELETE CASCADE;

-- [~] TABLE post
ALTER TABLE `post`
  ADD CONSTRAINT `fk_post_member` FOREIGN KEY (`member_id`) REFERENCES `member` (`id`);
