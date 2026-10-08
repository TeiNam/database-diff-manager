-- foreign_keys: off
-- 스키마 v3: 테이블을 다시 만들어 DB 제약을 강화한다 (STRICT, 원문 분리, 번호 재사용 방지, 인덱스 정리)
-- 사용자 계정은 보존하고, 세션과 업로드 데이터(Database·Schema·버전·매핑)는 비운다 (정의서를 다시 올리면 된다)
-- 실행기가 foreign_keys 를 끈 채 한 트랜잭션으로 실행하고, 끝에 foreign_key_check 로 검증한다

-- 1. 사용자: 대소문자만 다른 이름은 먼저 생긴 것(id 가 작은 것)만 남긴다
CREATE TABLE users_v3 (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'dba', 'viewer')),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;
INSERT OR IGNORE INTO users_v3 (id, username, password_hash, role, disabled, created_at)
  SELECT id, username, password_hash, role, CASE WHEN disabled = 0 THEN 0 ELSE 1 END, created_at FROM users ORDER BY id;

-- 2. 기존 테이블 정리 (인덱스도 함께 지워진다)
DROP TABLE sessions;
DROP TABLE rename_mappings;
DROP TABLE version_objects;
DROP TABLE object_revisions;
DROP TABLE objects;
DROP TABLE migration_mappings;
DROP TABLE schema_versions;
DROP TABLE schemas;
DROP TABLE databases;
DROP TABLE users;
ALTER TABLE users_v3 RENAME TO users;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX ix_sessions_user ON sessions (user_id);
CREATE INDEX ix_sessions_expires ON sessions (expires_at);

-- 3. 카탈로그
CREATE TABLE databases (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL
) STRICT;

-- next_version_no: 다음 업로드에 쓸 버전 번호. 최신 버전을 지워도 번호를 재사용하지 않는다
CREATE TABLE schemas (
  id INTEGER PRIMARY KEY,
  database_id INTEGER NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  next_version_no INTEGER NOT NULL DEFAULT 1 CHECK (next_version_no >= 1),
  UNIQUE (database_id, name)
) STRICT;

-- 4. 버전: 메타만 두고 원문은 schema_version_sources 로 분리한다 (목록 조회가 큰 원문 페이지를 읽지 않게)
CREATE TABLE schema_versions (
  id INTEGER PRIMARY KEY,
  schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  source_format TEXT NOT NULL CHECK (source_format IN ('sql', 'md')),
  source_filename TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  model_hash TEXT NOT NULL,
  note TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL,
  UNIQUE (schema_id, version_no),
  UNIQUE (id, schema_id)
) STRICT;

CREATE TABLE schema_version_sources (
  version_id INTEGER PRIMARY KEY REFERENCES schema_versions(id) ON DELETE CASCADE,
  source_text TEXT NOT NULL
) STRICT;

-- 5. 객체와 리비전. next_revision_no: 다음 리비전 번호 (재사용 방지)
CREATE TABLE objects (
  id INTEGER PRIMARY KEY,
  schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('table', 'view')),
  name TEXT NOT NULL,
  next_revision_no INTEGER NOT NULL DEFAULT 1 CHECK (next_revision_no >= 1),
  UNIQUE (schema_id, kind, name),
  UNIQUE (id, schema_id)
) STRICT;

-- 큰 model_json 은 마지막 컬럼에 둔다 (메타 컬럼을 읽을 때 오버플로 페이지를 따라가지 않게)
CREATE TABLE object_revisions (
  id INTEGER PRIMARY KEY,
  object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  content_hash TEXT NOT NULL,
  fidelity TEXT NOT NULL CHECK (fidelity IN ('full', 'partial')),
  parse_error TEXT,
  model_json TEXT NOT NULL,
  UNIQUE (object_id, revision_no),
  UNIQUE (id, object_id)
) STRICT;
-- 객체 이력 조회용 커버링 인덱스 (UNIQUE (object_id, revision_no) 와 앞부분이 같아 별도 ix_revisions_object 는 두지 않는다)
CREATE INDEX ix_revisions_history ON object_revisions (object_id, revision_no, fidelity, parse_error);

-- 버전 스냅샷: 버전당 객체는 한 리비전만, 버전·객체·리비전이 같은 Schema·같은 객체 소속인지 DB 가 강제한다
CREATE TABLE version_objects (
  version_id INTEGER NOT NULL,
  schema_id INTEGER NOT NULL,
  object_id INTEGER NOT NULL,
  revision_id INTEGER NOT NULL,
  PRIMARY KEY (version_id, object_id),
  FOREIGN KEY (version_id, schema_id) REFERENCES schema_versions(id, schema_id) ON DELETE CASCADE,
  FOREIGN KEY (object_id, schema_id) REFERENCES objects(id, schema_id),
  FOREIGN KEY (revision_id, object_id) REFERENCES object_revisions(id, object_id)
) STRICT;
CREATE INDEX ix_version_objects_revision ON version_objects (revision_id);
-- 객체 삭제 시 FK 검사가 version_objects 를 훑지 않게 한다
CREATE INDEX ix_version_objects_object ON version_objects (object_id);

-- 6. 수동 rename 매핑. table 매핑에는 table_name 이 없고 column·index 매핑에는 있다
CREATE TABLE rename_mappings (
  id INTEGER PRIMARY KEY,
  base_version_id INTEGER NOT NULL REFERENCES schema_versions(id) ON DELETE CASCADE,
  target_version_id INTEGER NOT NULL REFERENCES schema_versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('table', 'column', 'index')),
  table_name TEXT,
  old_name TEXT NOT NULL,
  new_name TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  CHECK ((kind = 'table') = (table_name IS NULL)),
  CHECK (base_version_id <> target_version_id)
) STRICT;
-- NULL 끼리는 UNIQUE 에서 서로 다르게 취급되므로 coalesce 로 table 매핑 중복도 막는다
CREATE UNIQUE INDEX ux_renames ON rename_mappings (base_version_id, target_version_id, kind, coalesce(table_name, ''), old_name);
CREATE INDEX ix_renames_target ON rename_mappings (target_version_id);

-- 7. DMS 전환 매핑: 메타만 두고 원문은 migration_mapping_sources 로 분리한다
CREATE TABLE migration_mappings (
  id INTEGER PRIMARY KEY,
  from_schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  to_schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  filename TEXT NOT NULL,
  rule_count INTEGER NOT NULL CHECK (rule_count >= 0),
  note TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL,
  UNIQUE (from_schema_id, to_schema_id, revision),
  CHECK (from_schema_id <> to_schema_id)
) STRICT;
CREATE INDEX ix_migration_mappings_to ON migration_mappings (to_schema_id);

CREATE TABLE migration_mapping_sources (
  migration_id INTEGER PRIMARY KEY REFERENCES migration_mappings(id) ON DELETE CASCADE,
  source TEXT NOT NULL
) STRICT;

-- (As-Is, To-Be) 쌍의 다음 리비전 번호 (최신 리비전을 지워도 번호를 재사용하지 않는다)
CREATE TABLE migration_pairs (
  from_schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  to_schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  next_revision INTEGER NOT NULL DEFAULT 1 CHECK (next_revision >= 1),
  PRIMARY KEY (from_schema_id, to_schema_id)
) STRICT;
CREATE INDEX ix_migration_pairs_to ON migration_pairs (to_schema_id);
