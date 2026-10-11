-- [~] TABLE member
-- 8.4 restrict_fk_on_non_standard_key: FK coupon.fk_coupon_member 는 참조 컬럼과 같은 UNIQUE/PRIMARY 키가 필요합니다
-- [수동 확인 필요] member: 바뀌지 않는 FK(coupon.fk_coupon_member)가 참조하는 키를 UNIQUE 가 아니거나 부분·다른 컬럼 키로 바꾸면 MySQL 8.4(restrict_fk_on_non_standard_key=ON 기본)에서 error 1553 (needed in a foreign key constraint) 으로 실패합니다 — FK 를 먼저 정리하고 직접 작성하세요
-- ALTER TABLE `member`
--   DROP INDEX `uq_member_code`,
--   ADD INDEX `uq_member_code` (`code`)

-- [~] TABLE memo
ALTER TABLE `memo`
  ADD INDEX `ix_memo_id` (`id`);
