-- [MD 기반] 일부 속성(Normal 인덱스 종류, 기본값, 생성 컬럼, 문자셋·콜레이션, CHECK, 파티션)은 비교하지 않았습니다

-- [+] TABLE items
-- [MD 기반 미확인] 테이블 `items`: checks, partition (DDL에 포함하지 않음)
-- [MD 기반 미확인] 컬럼 `id`: default
-- [MD 기반 미확인] 컬럼 `name`: charset, collation, default
-- [MD 기반 미확인] 인덱스 `PRIMARY`: partDetails, comment
-- [수동 확인 필요] items: 생성 컬럼(`dbl`)의 표현식을 알 수 없습니다. /* 표현식 미상 */를 채운 뒤 실행하세요
-- CREATE TABLE `items` (
--   `id` int NOT NULL,
--   `name` varchar(30) NOT NULL,
--   `dbl` int GENERATED ALWAYS AS (/* 표현식 미상 */) STORED,
--   PRIMARY KEY (`id`)
-- ) ENGINE=InnoDB COLLATE=utf8mb4_0900_ai_ci

-- [~] TABLE orders
-- [MD 기반 미확인] 컬럼 `note`: charset, collation, default
-- [MD 기반 미확인] 인덱스 `ix_memo`: partDetails
ALTER TABLE `orders`
  DROP INDEX `ix_memo`,
  MODIFY COLUMN `code` varchar(20) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL DEFAULT '',
  MODIFY COLUMN `total` bigint GENERATED ALWAYS AS ((`amt` * 2)) VIRTUAL,
  ADD COLUMN `note` varchar(10),
  ADD INDEX `ix_memo` (`memo`,`amt`);
