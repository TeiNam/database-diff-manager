-- [+] TABLE c
-- 테이블 rename a→c 이 같은 목적지(또는 같은 원본)로 가는 다른 테이블 매핑과 겹쳐 어느 것도 적용하지 않았습니다 — 서로 다른 원본의 값이 한 대상에 합쳐집니다
-- 테이블 rename b→c 이 같은 목적지(또는 같은 원본)로 가는 다른 테이블 매핑과 겹쳐 어느 것도 적용하지 않았습니다 — 서로 다른 원본의 값이 한 대상에 합쳐집니다
-- [수동 확인 필요] c: 테이블 rename 매핑 충돌 — 값 대응을 확인해 직접 작성하세요
-- CREATE TABLE `c` (
--   `id` int NOT NULL,
--   `v` varchar(20) NOT NULL,
--   PRIMARY KEY (`id`)
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

-- [~] TABLE u
ALTER TABLE `u`
  ADD COLUMN `memo` varchar(50) DEFAULT NULL;

-- [-] TABLE a
-- 테이블 rename a→c 이 같은 목적지(또는 같은 원본)로 가는 다른 테이블 매핑과 겹쳐 어느 것도 적용하지 않았습니다 — 서로 다른 원본의 값이 한 대상에 합쳐집니다
-- [수동 확인 필요] a: 테이블 rename 매핑 충돌 — 값 대응을 확인해 직접 작성하세요
-- DROP TABLE `a`

-- [-] TABLE b
-- 테이블 rename b→c 이 같은 목적지(또는 같은 원본)로 가는 다른 테이블 매핑과 겹쳐 어느 것도 적용하지 않았습니다 — 서로 다른 원본의 값이 한 대상에 합쳐집니다
-- [수동 확인 필요] b: 테이블 rename 매핑 충돌 — 값 대응을 확인해 직접 작성하세요
-- DROP TABLE `b`
