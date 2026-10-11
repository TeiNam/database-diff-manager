-- 스키마 v6: 업로드 원문이 완전한 td-export 출력임을 확인하지 못한 버전의 판정 (SchemaModel.incomplete JSON — 사유·끊겼을 수 있는 객체, 14회차 1)
-- 드문 표시라 별도 테이블에 불완전한 버전만 둔다. 행이 없으면 완전(또는 이 판정 전에 올린 버전)이다.
-- 이 버전을 TARGET 으로 비교하면 객체 DROP·DROP COLUMN·끊긴 객체의 문장을 수동 확인으로 돌린다
CREATE TABLE schema_version_incomplete (
  version_id INTEGER PRIMARY KEY REFERENCES schema_versions(id) ON DELETE CASCADE,
  incomplete_json TEXT NOT NULL
) STRICT;
