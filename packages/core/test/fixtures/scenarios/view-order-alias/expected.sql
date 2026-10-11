-- [+] VIEW a
-- DEFINER 없이 생성합니다 — 실행한 사용자가 DEFINER 가 됩니다
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `a` AS select 1 AS `z`;

-- [+] VIEW z
-- DEFINER 없이 생성합니다 — 실행한 사용자가 DEFINER 가 됩니다
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `z` AS select `a`.`z` AS `z` from `a`;
