-- [-] TABLE c
ALTER TABLE `c`
  DROP FOREIGN KEY `fk_c_p`;

-- [>] TABLE q
-- 얽힌 테이블 rename 을 한 문장으로 함께 적용합니다: p→q, q→p
RENAME TABLE `p` TO `__tdm_tmp_1`, `q` TO `p`, `__tdm_tmp_1` TO `q`;

-- [>] TABLE q
ALTER TABLE `q`
  ADD COLUMN `memo` varchar(50) DEFAULT NULL;

-- [>] TABLE p
ALTER TABLE `p`
  ADD COLUMN `memo` varchar(50) DEFAULT NULL;

-- [-] TABLE c
DROP TABLE `c`;
