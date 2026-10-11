-- [~] TABLE t1
ALTER TABLE `t1`
  MODIFY COLUMN `b` int DEFAULT NULL AFTER `c`;

-- [~] VIEW v_a
-- DEFINER 없이 생성합니다 — 실행한 사용자가 DEFINER 가 됩니다
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v_a` AS select `t1`.`a` AS `a`,`t1`.`c` AS `c` from `t1`;
