import { all, one, run, tx, type Db } from '../db/connection';
import { AppError } from '../errors';

export interface MigrationMeta {
  id: number;
  fromSchemaId: number;
  toSchemaId: number;
  revision: number;
  filename: string;
  ruleCount: number;
  note: string | null;
  uploadedBy: string;
  uploadedAt: string;
}

export interface MigrationInput {
  fromSchemaId: number;
  toSchemaId: number;
  filename: string;
  source: string;
  ruleCount: number;
  note?: string;
  userId: number;
}

interface MetaRecord {
  id: number; from_schema_id: number; to_schema_id: number; revision: number; filename: string;
  rule_count: number; note: string | null; uploaded_by: string; uploaded_at: string;
}

const META_COLUMNS = `m.id, m.from_schema_id, m.to_schema_id, m.revision, m.filename, m.rule_count, m.note,
  u.username AS uploaded_by, m.uploaded_at`;
const FROM = 'FROM migration_mappings m JOIN users u ON u.id = m.uploaded_by';
const META_SQL = `SELECT ${META_COLUMNS} ${FROM}`;

const toMeta = (r: MetaRecord): MigrationMeta => ({
  id: Number(r.id), fromSchemaId: Number(r.from_schema_id), toSchemaId: Number(r.to_schema_id), revision: Number(r.revision),
  filename: r.filename, ruleCount: Number(r.rule_count), note: r.note, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
});

const NOT_FOUND = () => new AppError(404, '전환 매핑을 찾을 수 없습니다');

export function getMigration(db: Db, id: number): MigrationMeta {
  const r = one<MetaRecord>(db, `${META_SQL} WHERE m.id = ?`, id);
  if (!r) throw NOT_FOUND();
  return toMeta(r);
}

// 같은 쌍의 다음 리비전 번호로 저장한다
export function addMigration(db: Db, input: MigrationInput): MigrationMeta {
  const id = tx(db, () => {
    const last = one<{ revision: number | null }>(db,
      'SELECT MAX(revision) AS revision FROM migration_mappings WHERE from_schema_id = ? AND to_schema_id = ?', input.fromSchemaId, input.toSchemaId);
    return run(db, `INSERT INTO migration_mappings (from_schema_id, to_schema_id, revision, filename, source, rule_count, note, uploaded_by, uploaded_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.fromSchemaId, input.toSchemaId, Number(last?.revision ?? 0) + 1, input.filename, input.source, input.ruleCount,
      input.note ?? null, input.userId, new Date().toISOString()).lastInsertRowid;
  });
  return getMigration(db, Number(id));
}

// 최신 리비전이 먼저 온다
export function listMigrations(db: Db, fromSchemaId: number, toSchemaId: number): MigrationMeta[] {
  return all<MetaRecord>(db, `${META_SQL} WHERE m.from_schema_id = ? AND m.to_schema_id = ? ORDER BY m.revision DESC`, fromSchemaId, toSchemaId).map(toMeta);
}

// 쌍의 최신 리비전 id 만 본다 (원문은 캐시 miss 때만 getMigrationSource 로 읽는다)
export function latestMigrationId(db: Db, fromSchemaId: number, toSchemaId: number): number | undefined {
  const r = one<{ id: number }>(db,
    'SELECT id FROM migration_mappings WHERE from_schema_id = ? AND to_schema_id = ? ORDER BY revision DESC LIMIT 1', fromSchemaId, toSchemaId);
  return r ? Number(r.id) : undefined;
}

export function getMigrationSource(db: Db, id: number): { filename: string; text: string } {
  const r = one<{ filename: string; source: string }>(db, 'SELECT filename, source FROM migration_mappings WHERE id = ?', id);
  if (!r) throw NOT_FOUND();
  return { filename: r.filename, text: r.source };
}

export function deleteMigration(db: Db, id: number): void {
  if (run(db, 'DELETE FROM migration_mappings WHERE id = ?', id).changes === 0) throw NOT_FOUND();
}
