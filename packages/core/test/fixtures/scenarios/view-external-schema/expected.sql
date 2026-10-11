-- [~] TABLE user
-- [수동 확인 필요] user: 생성 컬럼(`g`)의 VIRTUAL↔STORED 변경은 MODIFY 로 할 수 없습니다. 컬럼을 삭제한 뒤 다시 추가하세요
-- ALTER TABLE `user`
--   DROP COLUMN `payload`,
--   MODIFY COLUMN `g` int GENERATED ALWAYS AS ((`id` + 1)) STORED

-- [~] VIEW v
-- DEFINER 없이 생성합니다 — 실행한 사용자가 DEFINER 가 됩니다
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select `u`.`User` AS `u` from `mysql`.`user` `u` where (`u`.`Host` = 'localhost');
