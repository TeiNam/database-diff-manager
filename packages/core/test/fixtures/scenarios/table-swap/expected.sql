-- [>] TABLE voucher
-- 얽힌 테이블 rename 을 한 문장으로 함께 적용합니다: coupon→voucher, voucher→coupon
RENAME TABLE `coupon` TO `__tdm_tmp_1`, `voucher` TO `coupon`, `__tdm_tmp_1` TO `voucher`;
