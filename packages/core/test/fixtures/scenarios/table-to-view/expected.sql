-- [-] TABLE x
DROP TABLE `x`;

-- [+] VIEW x
-- DEFINER 없이 생성합니다 — 실행한 사용자가 DEFINER 가 됩니다
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `x` AS select `src`.`a` AS `a` from `src`;
