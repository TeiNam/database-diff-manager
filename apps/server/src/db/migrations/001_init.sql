CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE databases (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE schemas (
  id INTEGER PRIMARY KEY,
  database_id INTEGER NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE (database_id, name)
);
CREATE TABLE schema_versions (
  id INTEGER PRIMARY KEY,
  schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  source_format TEXT NOT NULL CHECK (source_format IN ('sql', 'md')),
  source_filename TEXT NOT NULL,
  source_text TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  model_hash TEXT NOT NULL,
  note TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL,
  UNIQUE (schema_id, version_no)
);
CREATE TABLE objects (
  id INTEGER PRIMARY KEY,
  schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('table', 'view')),
  name TEXT NOT NULL,
  UNIQUE (schema_id, kind, name)
);
CREATE TABLE object_revisions (
  id INTEGER PRIMARY KEY,
  object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  model_json TEXT NOT NULL,
  fidelity TEXT NOT NULL,
  parse_error TEXT,
  UNIQUE (object_id, revision_no)
);
CREATE TABLE version_objects (
  version_id INTEGER NOT NULL REFERENCES schema_versions(id) ON DELETE CASCADE,
  revision_id INTEGER NOT NULL REFERENCES object_revisions(id),
  PRIMARY KEY (version_id, revision_id)
);
CREATE TABLE rename_mappings (
  id INTEGER PRIMARY KEY,
  base_version_id INTEGER NOT NULL REFERENCES schema_versions(id) ON DELETE CASCADE,
  target_version_id INTEGER NOT NULL REFERENCES schema_versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('table', 'column', 'index')),
  table_name TEXT,
  old_name TEXT NOT NULL,
  new_name TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  UNIQUE (base_version_id, target_version_id, kind, table_name, old_name)
);
CREATE INDEX ix_versions_uploaded ON schema_versions (schema_id, uploaded_at);
CREATE INDEX ix_revisions_object ON object_revisions (object_id, revision_no);
CREATE INDEX ix_version_objects_revision ON version_objects (revision_id);
CREATE INDEX ix_sessions_user ON sessions (user_id);
