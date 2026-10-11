-- [~] TABLE point
-- RENAME INDEX x TO x: FK 를 다시 추가할 때 FK 가 만든 인덱스 이름이 FK 이름으로 바뀌지 않도록 고정합니다
-- FK 컬럼(또는 참조 컬럼)의 타입·문자셋·콜레이션이 바뀌어 FK 를 먼저 삭제하고 마지막에 다시 추가합니다 (error 3780)
-- FK 해제·컬럼 변경·FK 재추가는 묶음(member, point)을 함께 실행해야 합니다 (error 3780)
-- [수동 확인 필요] point: FK 로 묶여 컬럼 타입이 함께 바뀌는 테이블(member, point) 중 point 의 문장이 수동 확인이라 실행하지 않습니다 — 직접 작성하세요
-- ALTER TABLE `point`
--   DROP FOREIGN KEY `fk_point_member`,
--   RENAME INDEX `ix_point_member` TO `ix_point_member`

-- [~] TABLE member
-- FK 해제·컬럼 변경·FK 재추가는 묶음(member, point)을 함께 실행해야 합니다 (error 3780)
-- [수동 확인 필요] member: FK 로 묶여 컬럼 타입이 함께 바뀌는 테이블(member, point) 중 point 의 문장이 수동 확인이라 실행하지 않습니다 — 직접 작성하세요
-- ALTER TABLE `member`
--   MODIFY COLUMN `id` bigint NOT NULL AUTO_INCREMENT

-- [~] TABLE point
-- [수동 확인 필요] point: 생성 컬럼(`next_id`)의 VIRTUAL↔STORED 변경은 MODIFY 로 할 수 없습니다. 컬럼을 삭제한 뒤 다시 추가하세요
-- ALTER TABLE `point`
--   MODIFY COLUMN `member_id` bigint NOT NULL,
--   MODIFY COLUMN `next_id` bigint GENERATED ALWAYS AS ((`member_id` + 1)) STORED

-- [~] TABLE point
-- FK 해제·컬럼 변경·FK 재추가는 묶음(member, point)을 함께 실행해야 합니다 (error 3780)
-- [수동 확인 필요] point: FK 로 묶여 컬럼 타입이 함께 바뀌는 테이블(member, point) 중 point 의 문장이 수동 확인이라 실행하지 않습니다 — 직접 작성하세요
-- ALTER TABLE `point`
--   ADD CONSTRAINT `fk_point_member` FOREIGN KEY (`member_id`) REFERENCES `member` (`id`)
