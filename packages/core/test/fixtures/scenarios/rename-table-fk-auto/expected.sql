-- [>] TABLE kid
-- RENAME INDEX x TO x: FK 를 다시 추가할 때 FK 가 만든 인덱스 이름이 FK 이름으로 바뀌지 않도록 고정합니다
ALTER TABLE `child`
  DROP FOREIGN KEY `child_ibfk_2`,
  RENAME INDEX `owner_id` TO `owner_id`;

-- [>] TABLE kid
RENAME TABLE `child` TO `kid`;

-- [>] TABLE b
-- 얽힌 테이블 rename 을 한 문장으로 함께 적용합니다: a→b, b→a
RENAME TABLE `a` TO `__tdm_tmp_1`, `b` TO `a`, `__tdm_tmp_1` TO `b`;

-- [>] TABLE kid
ALTER TABLE `kid`
  ADD CONSTRAINT `kid_ibfk_2` FOREIGN KEY (`owner_id`) REFERENCES `parent` (`id`) ON DELETE CASCADE;
