-- [~] TABLE t
-- 컬럼 rename x→z 이 같은 목적지(또는 같은 원본)로 가는 다른 컬럼 매핑과 겹쳐 어느 것도 적용하지 않았습니다 — 서로 다른 원본의 값이 한 대상에 합쳐집니다
-- 컬럼 rename y→z 이 같은 목적지(또는 같은 원본)로 가는 다른 컬럼 매핑과 겹쳐 어느 것도 적용하지 않았습니다 — 서로 다른 원본의 값이 한 대상에 합쳐집니다
-- [수동 확인 필요] t: 컬럼 rename 매핑 충돌 — 값 대응을 확인해 직접 작성하세요
-- ALTER TABLE `t`
--   DROP COLUMN `x`,
--   DROP COLUMN `y`,
--   ADD COLUMN `z` int NOT NULL

-- [~] TABLE u
ALTER TABLE `u`
  ADD COLUMN `memo` varchar(50) DEFAULT NULL;
