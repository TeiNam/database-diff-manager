-- 스키마 v7: 버전마다 TARGET 완전성 증거 (SchemaModel.evidence — complete·incomplete·unknown, 15회차 원칙 전환).
-- 이 버전을 TARGET 으로 비교할 때 증거가 complete 가 아니면 부재 기반 파괴 문장(객체·컬럼·파티션 삭제)을 수동 확인으로 돌린다.
-- judged_by: ingest(업로드 때 판정), backfill(기동 시 원문으로 다시 판정), v6(006 의 불완전 표시를 옮긴 것 — 기동 시 원문으로 다시 판정한다).
-- 행이 없는 버전(006 이전에 올린 버전)도 기동 시 JS 단계(backfillEvidence)가 원문으로 판정해 채운다. 원문이 없으면 unknown
CREATE TABLE schema_version_evidence (
  version_id INTEGER PRIMARY KEY REFERENCES schema_versions(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('complete', 'incomplete', 'unknown')),
  evidence_json TEXT NOT NULL,
  judged_by TEXT NOT NULL CHECK (judged_by IN ('ingest', 'backfill', 'v6'))
) STRICT;

INSERT INTO schema_version_evidence (version_id, level, evidence_json, judged_by)
  SELECT version_id, 'incomplete',
         CASE WHEN json_valid(incomplete_json) THEN json_set(incomplete_json, '$.level', 'incomplete')
              ELSE '{"level":"incomplete","reason":"저장된 불완전 표시를 읽지 못했습니다","objects":[]}' END,
         'v6'
    FROM schema_version_incomplete;

DROP TABLE schema_version_incomplete;
