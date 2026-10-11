-- [~] TABLE coupon
-- RENAME INDEX x TO x: FK 를 다시 추가할 때 FK 가 만든 인덱스 이름이 FK 이름으로 바뀌지 않도록 고정합니다
-- 8.4 restrict_fk_on_non_standard_key: FK coupon.fk_coupon_member 는 참조 컬럼과 같은 UNIQUE/PRIMARY 키가 필요합니다 (8.0 은 실행 가능)
-- [수동 확인 필요] coupon: FK(coupon.fk_coupon_member)가 참조하는 member(code) 에 TARGET 에서 같은 컬럼의 UNIQUE/PRIMARY 키가 없습니다. MySQL 8.4 restrict_fk_on_non_standard_key=ON(기본)에서 실패하고(FK 추가 error 6125, 부모 인덱스 삭제 error 1553), 8.0 은 실행 가능합니다 — FK 와 부모 키를 함께 확인해 직접 작성하세요
-- ALTER TABLE `coupon`
--   DROP FOREIGN KEY `fk_coupon_member`,
--   RENAME INDEX `ix_coupon_member` TO `ix_coupon_member`

-- [~] TABLE member
-- 8.4 restrict_fk_on_non_standard_key: FK coupon.fk_coupon_member 는 참조 컬럼과 같은 UNIQUE/PRIMARY 키가 필요합니다 (8.0 은 실행 가능)
-- [수동 확인 필요] member: FK(coupon.fk_coupon_member)가 참조하는 member(code) 에 TARGET 에서 같은 컬럼의 UNIQUE/PRIMARY 키가 없습니다. MySQL 8.4 restrict_fk_on_non_standard_key=ON(기본)에서 실패하고(FK 추가 error 6125, 부모 인덱스 삭제 error 1553), 8.0 은 실행 가능합니다 — FK 와 부모 키를 함께 확인해 직접 작성하세요
-- ALTER TABLE `member`
--   DROP INDEX `uq_member_code`,
--   ADD INDEX `uq_member_code` (`code`)

-- [~] TABLE memo
ALTER TABLE `memo`
  ADD INDEX `ix_memo_id` (`id`);

-- [~] TABLE coupon
-- 8.4 restrict_fk_on_non_standard_key: FK coupon.fk_coupon_member 는 참조 컬럼과 같은 UNIQUE/PRIMARY 키가 필요합니다 (8.0 은 실행 가능)
-- [수동 확인 필요] coupon: FK(coupon.fk_coupon_member)가 참조하는 member(code) 에 TARGET 에서 같은 컬럼의 UNIQUE/PRIMARY 키가 없습니다. MySQL 8.4 restrict_fk_on_non_standard_key=ON(기본)에서 실패하고(FK 추가 error 6125, 부모 인덱스 삭제 error 1553), 8.0 은 실행 가능합니다 — FK 와 부모 키를 함께 확인해 직접 작성하세요
-- ALTER TABLE `coupon`
--   ADD CONSTRAINT `fk_coupon_member` FOREIGN KEY (`member_code`) REFERENCES `member` (`code`) ON DELETE CASCADE
