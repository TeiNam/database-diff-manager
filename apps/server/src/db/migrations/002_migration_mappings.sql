-- DMS 전환 매핑: As-Is Schema → To-Be Schema 쌍에 리비전으로 쌓는다
CREATE TABLE migration_mappings (
  id INTEGER PRIMARY KEY,
  from_schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  to_schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  filename TEXT NOT NULL,
  source TEXT NOT NULL,
  rule_count INTEGER NOT NULL,
  note TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL,
  UNIQUE (from_schema_id, to_schema_id, revision),
  CHECK (from_schema_id <> to_schema_id)
);
CREATE INDEX ix_migration_mappings_to ON migration_mappings (to_schema_id);
