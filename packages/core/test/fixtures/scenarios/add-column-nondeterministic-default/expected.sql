-- [+] TABLE t3
CREATE TABLE `t3` (
  `id` int NOT NULL,
  `u` binary(16) DEFAULT (uuid_to_bin(uuid())),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- [~] TABLE t
-- 비결정 함수(uuid·rand·sysdate·user 등) DEFAULT 식은 ADD COLUMN 때 행마다 다른 값이 되어 복제에 안전하지 않습니다 (error 1674)
-- [수동 확인 필요] t: 비결정 함수 DEFAULT 식 컬럼(u(uuid))을 기존 테이블에 추가하면 binlog 가 켜진 서버에서 error 1674 로 실패합니다 — 컬럼을 DEFAULT 없이 추가하고 값을 채운 뒤 ALTER COLUMN … SET DEFAULT 로 바꾸는 등 직접 작성하세요
-- ALTER TABLE `t`
--   ADD COLUMN `u` binary(16) DEFAULT (uuid_to_bin(uuid()))

-- [~] TABLE t2
ALTER TABLE `t2`
  ADD COLUMN `at` datetime DEFAULT (now());
