-- foreign_keys: off
-- 스키마 v4: objects.kind 에 MySQL 루틴(function, procedure)을 추가한다 (td-export 0.1.52+ SQL 출력)
-- SQLite 는 CHECK 를 바꿀 수 없으므로 objects 만 다시 만들고 데이터는 그대로 옮긴다 (id 보존 → 리비전·스냅샷 FK 유지)
-- 실행기가 foreign_keys 를 끈 채 한 트랜잭션으로 실행하고, 끝에 foreign_key_check 로 검증한다

CREATE TABLE objects_v4 (
  id INTEGER PRIMARY KEY,
  schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('table', 'view', 'function', 'procedure')),
  name TEXT NOT NULL,
  next_revision_no INTEGER NOT NULL DEFAULT 1 CHECK (next_revision_no >= 1),
  UNIQUE (schema_id, kind, name),
  UNIQUE (id, schema_id)
) STRICT;
INSERT INTO objects_v4 (id, schema_id, kind, name, next_revision_no)
  SELECT id, schema_id, kind, name, next_revision_no FROM objects ORDER BY id;

-- object_revisions·version_objects 의 REFERENCES objects(...) 는 이름으로 걸려 있어 새 테이블을 그대로 가리킨다
DROP TABLE objects;
ALTER TABLE objects_v4 RENAME TO objects;
