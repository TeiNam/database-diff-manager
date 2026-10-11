-- [~] TABLE child
-- 본 ALTER 가 수동 확인이라 이 테이블의 다른 문장(FK 해제·추가 등)도 함께 실행하지 않습니다
-- [수동 확인 필요] child: 본 ALTER 가 수동 확인이라 이 테이블의 문장을 실행하지 않습니다 — 직접 작성하세요
-- ALTER TABLE `child`
--   DROP FOREIGN KEY `fk_child_parent`

-- [~] TABLE child
-- [수동 확인 필요] child: 생성 컬럼(`g`)의 VIRTUAL↔STORED 변경은 MODIFY 로 할 수 없습니다. 컬럼을 삭제한 뒤 다시 추가하세요
-- ALTER TABLE `child`
--   DROP INDEX `ix_child_parent`,
--   DROP COLUMN `pid`,
--   ADD COLUMN `new_pid` int NOT NULL AFTER `id`,
--   MODIFY COLUMN `g` int GENERATED ALWAYS AS ((`id` + 1)) STORED,
--   ADD INDEX `ix_child_parent` (`new_pid`)

-- [~] TABLE child
-- 본 ALTER 가 수동 확인이라 이 테이블의 다른 문장(FK 해제·추가 등)도 함께 실행하지 않습니다
-- [수동 확인 필요] child: 본 ALTER 가 수동 확인이라 이 테이블의 문장을 실행하지 않습니다 — 직접 작성하세요
-- ALTER TABLE `child`
--   ADD CONSTRAINT `fk_child_parent` FOREIGN KEY (`new_pid`) REFERENCES `parent` (`id`)
