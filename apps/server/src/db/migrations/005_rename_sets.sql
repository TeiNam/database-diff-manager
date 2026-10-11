-- 스키마 v5: 수동 rename 매핑을 (base, target) 쌍에 명시적으로 저장한 적이 있는지 기록한다 (빈 목록 저장 포함)
-- 이 쌍에 저장한 적이 있으면 역쌍(target, base) 매핑을 뒤집어 쓰지 않는다 → 역쌍에서 사본을 저장했다가 모두 해제해도 되살아나지 않는다
CREATE TABLE rename_mapping_sets (
  base_version_id INTEGER NOT NULL REFERENCES schema_versions(id) ON DELETE CASCADE,
  target_version_id INTEGER NOT NULL REFERENCES schema_versions(id) ON DELETE CASCADE,
  PRIMARY KEY (base_version_id, target_version_id),
  CHECK (base_version_id <> target_version_id)
) STRICT;
-- 버전 삭제 시 target 쪽 FK 검사가 테이블을 훑지 않게 한다
CREATE INDEX ix_rename_sets_target ON rename_mapping_sets (target_version_id);

-- 이미 매핑이 저장된 쌍은 명시적으로 저장한 쌍이다
INSERT INTO rename_mapping_sets (base_version_id, target_version_id)
  SELECT DISTINCT base_version_id, target_version_id FROM rename_mappings;
