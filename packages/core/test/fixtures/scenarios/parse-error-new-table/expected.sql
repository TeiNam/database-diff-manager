-- [+] TABLE pe
-- [수동 확인 필요] pe: 파싱할 수 없는 테이블 정의입니다 — 원문을 확인해 직접 실행하세요
-- CREATE TABLE `pe` (
--   `id` int NOT NULL,
--   `a` int DEFAULT NULL,
--   PRIMARY KEY (`id`),
--   KEY `ix` (`a`) /*!80021 SECONDARY_ENGINE_ATTRIBUTE '{"y": 2}' */
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

-- [+] TABLE pe_child
-- FK fk_pe_child_pe 가 수동 확인 테이블을 참조합니다
-- [수동 확인 필요] pe_child: 참조하는 테이블의 문장이 수동 확인이라 FK 변경을 실행하지 않습니다 — 직접 작성하세요
-- CREATE TABLE `pe_child` (
--   `id` int NOT NULL,
--   `pe_id` int NOT NULL,
--   PRIMARY KEY (`id`),
--   KEY `fk_pe_child_pe` (`pe_id`)
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

-- [+] TABLE memo
CREATE TABLE `memo` (
  `id` int NOT NULL,
  `member_id` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_memo_member` (`member_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- [+] TABLE pe_child
-- FK fk_pe_child_pe 가 수동 확인 테이블을 참조합니다
-- [수동 확인 필요] pe_child: 참조하는 테이블의 문장이 수동 확인이라 FK 변경을 실행하지 않습니다 — 직접 작성하세요
-- ALTER TABLE `pe_child`
--   ADD CONSTRAINT `fk_pe_child_pe` FOREIGN KEY (`pe_id`) REFERENCES `pe` (`id`)

-- [+] TABLE memo
ALTER TABLE `memo`
  ADD CONSTRAINT `fk_memo_member` FOREIGN KEY (`member_id`) REFERENCES `member` (`id`);
