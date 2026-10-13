-- 스키마 v9: ALTER 스크립트를 적용해 만든 버전(파생 버전)의 기준 버전·스크립트·스키마 기본 문자셋.
-- 파생 버전의 원문(schema_version_sources)은 결과 모델을 td-export 0.1.52 형식으로 출력한 덤프다 — 완전성 판정은 원문이 아니라
-- 기준 버전에서 물려받는다 (출력한 덤프에는 늘 헤더·트레일러가 있다). base_version_no 는 기준 버전이 지워져도 '기준 vN' 을 보여 준다
CREATE TABLE schema_version_derivations (
  version_id INTEGER PRIMARY KEY REFERENCES schema_versions (id) ON DELETE CASCADE,
  base_version_id INTEGER REFERENCES schema_versions (id) ON DELETE SET NULL,
  base_version_no INTEGER NOT NULL CHECK (base_version_no > 0),
  script TEXT NOT NULL CHECK (length(script) > 0),
  statement_count INTEGER NOT NULL CHECK (statement_count > 0),
  default_charset TEXT NOT NULL CHECK (length(default_charset) > 0),
  default_collation TEXT NOT NULL CHECK (length(default_collation) > 0)
) STRICT;
CREATE INDEX ix_version_derivations_base ON schema_version_derivations (base_version_id);
