import { all, one, run, type Db } from '../db/connection';
import { AppError } from '../errors';
import { isUniqueViolation } from './users';

export interface DatabaseRow {
  id: number;
  name: string;
  description: string | null;
  createdAt: string;
}

export interface TreeSchema {
  id: number;
  name: string;
  latestVersion: { id: number; versionNo: number; uploadedAt: string } | null;
}

export interface TreeDatabase extends DatabaseRow {
  schemas: TreeSchema[];
}

export interface SchemaRow {
  id: number;
  name: string;
  databaseId: number;
  databaseName: string;
}

interface DatabaseRecord { id: number; name: string; description: string | null; created_at: string }

const toDatabase = (r: DatabaseRecord): DatabaseRow => ({ id: Number(r.id), name: r.name, description: r.description, createdAt: r.created_at });
const DUPLICATE = () => new AppError(409, '이미 존재하는 Database 이름입니다');

export function getDatabase(db: Db, id: number): DatabaseRow {
  const r = one<DatabaseRecord>(db, 'SELECT id, name, description, created_at FROM databases WHERE id = ?', id);
  if (!r) throw new AppError(404, 'Database를 찾을 수 없습니다');
  return toDatabase(r);
}

export function createDatabase(db: Db, input: { name: string; description?: string }): DatabaseRow {
  try {
    const { lastInsertRowid } = run(db, 'INSERT INTO databases (name, description, created_at) VALUES (?, ?, ?)',
      input.name, input.description ?? null, new Date().toISOString());
    return getDatabase(db, lastInsertRowid);
  } catch (e) {
    if (isUniqueViolation(e)) throw DUPLICATE();
    throw e;
  }
}

export function updateDatabase(db: Db, id: number, patch: { name?: string; description?: string }): DatabaseRow {
  const current = getDatabase(db, id);
  try {
    run(db, 'UPDATE databases SET name = ?, description = ? WHERE id = ?', patch.name ?? current.name, patch.description ?? current.description, id);
  } catch (e) {
    if (isUniqueViolation(e)) throw DUPLICATE();
    throw e;
  }
  return getDatabase(db, id);
}

// 하위 Schema·버전·객체까지 함께 지워지므로 이름을 한 번 더 입력받는다
export function deleteDatabase(db: Db, id: number, confirmName: string): void {
  const current = getDatabase(db, id);
  if (current.name !== confirmName) throw new AppError(400, '확인용 이름이 일치하지 않습니다');
  run(db, 'DELETE FROM databases WHERE id = ?', id);
}

// 버전·객체 이력까지 함께 지워지므로(FK 연쇄) 이름을 한 번 더 입력받는다
export function deleteSchema(db: Db, id: number, confirmName: string): void {
  const current = getSchema(db, id);
  if (current.name !== confirmName) throw new AppError(400, '확인용 이름이 일치하지 않습니다');
  run(db, 'DELETE FROM schemas WHERE id = ?', id);
}

export function ensureDatabase(db: Db, name: string): number {
  const found = one<{ id: number }>(db, 'SELECT id FROM databases WHERE name = ?', name);
  if (found) return Number(found.id);
  return run(db, 'INSERT INTO databases (name, created_at) VALUES (?, ?)', name, new Date().toISOString()).lastInsertRowid;
}

export function ensureSchema(db: Db, databaseId: number, name: string): number {
  const found = one<{ id: number }>(db, 'SELECT id FROM schemas WHERE database_id = ? AND name = ?', databaseId, name);
  if (found) return Number(found.id);
  return run(db, 'INSERT INTO schemas (database_id, name) VALUES (?, ?)', databaseId, name).lastInsertRowid;
}

export function getSchema(db: Db, id: number): SchemaRow {
  const r = one<{ id: number; name: string; database_id: number; database_name: string }>(db,
    'SELECT s.id, s.name, s.database_id, d.name AS database_name FROM schemas s JOIN databases d ON d.id = s.database_id WHERE s.id = ?', id);
  if (!r) throw new AppError(404, 'Schema를 찾을 수 없습니다');
  return { id: Number(r.id), name: r.name, databaseId: Number(r.database_id), databaseName: r.database_name };
}

interface TreeRecord extends DatabaseRecord {
  schema_id: number | null;
  schema_name: string | null;
  version_id: number | null;
  version_no: number | null;
  uploaded_at: string | null;
}

export function getTree(db: Db): TreeDatabase[] {
  const rows = all<TreeRecord>(db, `
    SELECT d.id, d.name, d.description, d.created_at, s.id AS schema_id, s.name AS schema_name,
           v.id AS version_id, v.version_no, v.uploaded_at
      FROM databases d
      LEFT JOIN schemas s ON s.database_id = d.id
      LEFT JOIN schema_versions v ON v.id = (
        SELECT id FROM schema_versions WHERE schema_id = s.id ORDER BY version_no DESC LIMIT 1)
     ORDER BY d.name, s.name`);
  const byId = new Map<number, TreeDatabase>();
  for (const r of rows) {
    const entry = byId.get(Number(r.id)) ?? { ...toDatabase(r), schemas: [] };
    byId.set(entry.id, entry);
    if (r.schema_id === null) continue;
    entry.schemas.push({
      id: Number(r.schema_id),
      name: r.schema_name!,
      latestVersion: r.version_id === null ? null : { id: Number(r.version_id), versionNo: Number(r.version_no), uploadedAt: r.uploaded_at! },
    });
  }
  return [...byId.values()];
}
