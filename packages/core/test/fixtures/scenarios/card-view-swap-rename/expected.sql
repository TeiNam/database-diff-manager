-- [>] TABLE voucher
-- 얽힌 테이블 rename 을 한 문장으로 함께 적용합니다: coupon→voucher, voucher→coupon
RENAME TABLE `coupon` TO `__tdm_tmp_1`, `voucher` TO `coupon`, `__tdm_tmp_1` TO `voucher`;

-- [+] VIEW v_coupon
-- DEFINER 없이 생성합니다 — 실행한 사용자가 DEFINER 가 됩니다
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v_coupon` AS select `coupon`.`id` AS `id`,`coupon`.`amount` AS `amount` from `coupon`;
