import { createHash } from 'node:crypto';
import { canonicalJson, parseMdDump, parseSqlDump, type ParsedDump, type ParseWarning, type SchemaModel, type SourceFormat, type Table, type View } from '@tdm/core';
import { one, run, tx, type Db } from '../db/connection';
import { AppError } from '../errors';
import { ensureDatabase, ensureSchema } from '../repos/catalog';

export interface IngestInput {
  databaseName: string;
  schemaName: string;
  filename: string;
  text: string;
  note?: string;
  userId: number;
}

export type IngestResult =
  | { status: 'ok'; versionId: number; versionNo: number; warnings: ParseWarning[] }
  | { status: 'duplicate'; versionId: number; versionNo: number; warnings: ParseWarning[] };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
// model_hash가 저장되므로 로케일과 무관한 코드 유닛 비교를 쓴다
const byName = <T extends { name: string }>(items: T[]) => [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

export function formatOf(filename: string): SourceFormat {
  const ext = /\.(sql|md)$/i.exec(filename)?.[1]?.toLowerCase();
  if (!ext) throw new AppError(400, '지원하지 않는 파일 형식입니다 (.sql, .md)');
  return ext as SourceFormat;
}

// 덤프 안 객체 순서가 바뀌어도 같은 모델로 본다
export function modelHash(model: SchemaModel): string {
  return sha256(canonicalJson({ tables: byName(model.tables), views: byName(model.views) }));
}

function parse(format: SourceFormat, text: string): ParsedDump {
  return format === 'sql' ? parseSqlDump(text) : parseMdDump(text);
}

function assertUniqueNames(model: SchemaModel): void {
  const seen = new Set<string>();
  for (const obj of [...model.tables, ...model.views]) {
    const key = `${obj.kind}:${obj.name}`;
    if (seen.has(key)) throw new AppError(400, `같은 이름의 객체가 두 번 정의되어 있습니다: ${obj.name}`);
    seen.add(key);
  }
}

export function ingest(db: Db, input: IngestInput): IngestResult {
  const format = formatOf(input.filename);
  const { model, warnings } = parse(format, input.text);
  if (!model.tables.length && !model.views.length) throw new AppError(400, '파일에서 테이블이나 뷰를 찾지 못했습니다');
  assertUniqueNames(model);
  const hash = modelHash(model);
  return tx(db, () => {
    const schemaId = ensureSchema(db, ensureDatabase(db, input.databaseName), input.schemaName);
    const latest = one<{ id: number; version_no: number; model_hash: string }>(db,
      'SELECT id, version_no, model_hash FROM schema_versions WHERE schema_id = ? ORDER BY version_no DESC LIMIT 1', schemaId);
    if (latest && latest.model_hash === hash) return { status: 'duplicate', versionId: Number(latest.id), versionNo: Number(latest.version_no), warnings };
    const versionNo = takeNumber(db, 'UPDATE schemas SET next_version_no = next_version_no + 1 WHERE id = ? RETURNING next_version_no - 1 AS n', schemaId);
    const versionId = run(db, `
      INSERT INTO schema_versions (schema_id, version_no, source_format, source_filename, source_sha256, model_hash, note, uploaded_by, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      schemaId, versionNo, format, input.filename, sha256(input.text), hash, input.note ?? null, input.userId, new Date().toISOString(),
    ).lastInsertRowid;
    run(db, 'INSERT INTO schema_version_sources (version_id, source_text) VALUES (?, ?)', versionId, input.text);
    for (const obj of [...model.tables, ...model.views]) linkObject(db, schemaId, versionId, obj);
    return { status: 'ok', versionId, versionNo, warnings };
  });
}

// 번호 카운터를 같은 트랜잭션 안에서 1 올리고 올리기 전 값을 쓴다 (지운 번호를 다시 쓰지 않는다)
function takeNumber(db: Db, sql: string, id: number): number {
  const r = one<{ n: number }>(db, sql, id);
  if (!r) throw new Error(`번호 카운터 행이 없습니다: ${id}`);
  return Number(r.n);
}

// 객체 내용 해시가 직전 리비전과 같으면 그 리비전을 재사용하고, 다르면 새 리비전을 만든다
function linkObject(db: Db, schemaId: number, versionId: number, obj: Table | View): void {
  const objectId = Number(one<{ id: number }>(db, 'SELECT id FROM objects WHERE schema_id = ? AND kind = ? AND name = ?', schemaId, obj.kind, obj.name)?.id
    ?? run(db, 'INSERT INTO objects (schema_id, kind, name) VALUES (?, ?, ?)', schemaId, obj.kind, obj.name).lastInsertRowid);
  const json = canonicalJson(obj);
  const contentHash = sha256(json);
  const last = one<{ id: number; content_hash: string }>(db,
    'SELECT id, content_hash FROM object_revisions WHERE object_id = ? ORDER BY revision_no DESC LIMIT 1', objectId);
  const revisionId = last && last.content_hash === contentHash
    ? Number(last.id)
    : run(db, 'INSERT INTO object_revisions (object_id, revision_no, content_hash, fidelity, parse_error, model_json) VALUES (?, ?, ?, ?, ?, ?)',
        objectId, takeNumber(db, 'UPDATE objects SET next_revision_no = next_revision_no + 1 WHERE id = ? RETURNING next_revision_no - 1 AS n', objectId),
        contentHash, obj.fidelity, obj.parseError ?? null, json).lastInsertRowid;
  run(db, 'INSERT INTO version_objects (version_id, schema_id, object_id, revision_id) VALUES (?, ?, ?, ?)', versionId, schemaId, objectId, revisionId);
}
