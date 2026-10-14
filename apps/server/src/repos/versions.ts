import type { Routine, SchemaModel, SourceFormat, Table, View } from '@tdm/core';
import { all, one, run, tx, type Db } from '../db/connection';
import { AppError } from '../errors';
import { getSchema } from './catalog';
import { loadEvidence, loadStaleReason } from './evidence';

export interface VersionMeta {
  id: number;
  schemaId: number;
  databaseId: number;
  databaseName: string;
  schemaName: string;
  versionNo: number;
  sourceFormat: SourceFormat;
  sourceFilename: string;
  note: string | null;
  uploadedBy: string;
  uploadedAt: string;
  derivedFrom?: { baseVersionNo: number; statementCount: number; defaults: { charset: string; collation: string } }; // ALTER 적용으로 만든 버전 (009)
}

export interface VersionSummary extends VersionMeta {
  changedObjects: number; // 직전 버전 대비 추가·삭제·변경된 객체 수
}

export type ObjectKind = 'table' | 'view' | 'function' | 'procedure';
const ROUTINE_KINDS: ReadonlySet<string> = new Set(['function', 'procedure']);

export interface VersionObject {
  objectId: number;
  kind: ObjectKind;
  name: string;
  revisionNo: number;
}

export interface VersionDetail {
  version: VersionMeta;
  model: SchemaModel;
  objects: VersionObject[];
  staleReason?: string; // 예전 파서로 저장된 모델 (원문 재파싱 모델과 다름, 16회차 2) — 이 버전이 낀 diff 의 실행 문장은 모두 수동 확인
}

interface MetaRecord {
  id: number; schema_id: number; database_id: number; database_name: string; schema_name: string; version_no: number;
  source_format: SourceFormat; source_filename: string; note: string | null; uploaded_by: string; uploaded_at: string;
  base_version_no: number | null; statement_count: number | null; default_charset: string | null; default_collation: string | null;
}

const META_SQL = `
  SELECT v.id, v.schema_id, s.database_id, d.name AS database_name, s.name AS schema_name, v.version_no,
         v.source_format, v.source_filename, v.note, u.username AS uploaded_by, v.uploaded_at,
         dv.base_version_no, dv.statement_count, dv.default_charset, dv.default_collation
    FROM schema_versions v
    JOIN schemas s ON s.id = v.schema_id
    JOIN databases d ON d.id = s.database_id
    JOIN users u ON u.id = v.uploaded_by
    LEFT JOIN schema_version_derivations dv ON dv.version_id = v.id`;

const toMeta = (r: MetaRecord): VersionMeta => ({
  id: Number(r.id), schemaId: Number(r.schema_id), databaseId: Number(r.database_id), databaseName: r.database_name,
  schemaName: r.schema_name, versionNo: Number(r.version_no), sourceFormat: r.source_format, sourceFilename: r.source_filename,
  note: r.note, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
  ...(r.base_version_no === null ? {} : {
    derivedFrom: { baseVersionNo: Number(r.base_version_no), statementCount: Number(r.statement_count), defaults: { charset: r.default_charset!, collation: r.default_collation! } },
  }),
});

const NOT_FOUND = () => new AppError(404, '버전을 찾을 수 없습니다');

export function getVersionMeta(db: Db, id: number): VersionMeta {
  const r = one<MetaRecord>(db, `${META_SQL} WHERE v.id = ?`, id);
  if (!r) throw NOT_FOUND();
  return toMeta(r);
}

// 버전을 가리키는 지문. 행 ID 는 가장 큰 ID 의 버전을 지우면 다른 업로드가 다시 쓰므로(SQLite rowid) ID 만으로는 같은 버전이라 할 수 없다.
// 스키마 ID, 버전 번호(스키마마다 번호를 다시 쓰지 않는다), 저장된 모델 해시를 함께 본다 — 스키마까지 통째로 지우고 다시 만들어 앞의 둘이 같아져도 모델이 다르면 해시가 다르다
export interface VersionFingerprint {
  schemaId: number;
  versionNo: number;
  modelHash: string;
}

export function getVersionFingerprint(db: Db, id: number): VersionFingerprint {
  const r = one<{ schema_id: number; version_no: number; model_hash: string }>(db, 'SELECT schema_id, version_no, model_hash FROM schema_versions WHERE id = ?', id);
  if (!r) throw NOT_FOUND();
  return { schemaId: Number(r.schema_id), versionNo: Number(r.version_no), modelHash: r.model_hash };
}

export const isSameFingerprint = (a: VersionFingerprint, b: VersionFingerprint): boolean =>
  a.schemaId === b.schemaId && a.versionNo === b.versionNo && a.modelHash === b.modelHash;

export function listVersions(db: Db, schemaId: number): VersionSummary[] {
  getSchema(db, schemaId);
  const metas = all<MetaRecord>(db, `${META_SQL} WHERE v.schema_id = ? ORDER BY v.version_no`, schemaId).map(toMeta);
  const links = all<{ version_id: number; object_id: number; content_hash: string; kind: string }>(db, `
    SELECT vo.version_id, r.object_id, r.content_hash, o.kind
      FROM version_objects vo JOIN object_revisions r ON r.id = vo.revision_id
      JOIN objects o ON o.id = r.object_id
      JOIN schema_versions v ON v.id = vo.version_id WHERE v.schema_id = ?`, schemaId);
  const byVersion = new Map<number, Map<number, string>>();
  const routineIds = new Set<number>();
  for (const l of links) {
    const objects = byVersion.get(Number(l.version_id)) ?? new Map<number, string>();
    objects.set(Number(l.object_id), l.content_hash);
    byVersion.set(Number(l.version_id), objects);
    if (ROUTINE_KINDS.has(l.kind)) routineIds.add(Number(l.object_id));
  }
  let previous = new Map<number, string>(); // object_id -> content_hash (중간 버전 삭제 시 과대 계산 방지)
  let previousFormat: SourceFormat | undefined;
  const summaries = metas.map((meta) => {
    const current = byVersion.get(meta.id) ?? new Map<number, string>();
    // MD 에는 루틴이 없으므로 MD 가 낀 쌍에서는 루틴을 변경으로 세지 않는다 (diff 의 routinesUnknown 과 같은 기준)
    const skipRoutines = meta.sourceFormat === 'md' || previousFormat === 'md';
    const objectIds = [...new Set([...previous.keys(), ...current.keys()])].filter((o) => !(skipRoutines && routineIds.has(o)));
    const changedObjects = objectIds.filter((o) => previous.get(o) !== current.get(o)).length;
    previous = current;
    previousFormat = meta.sourceFormat;
    return { ...meta, changedObjects };
  });
  return summaries.reverse();
}

export function loadVersion(db: Db, id: number): VersionDetail {
  const version = getVersionMeta(db, id);
  const evidence = loadEvidence(db, id);
  const rows = all<{ object_id: number; kind: ObjectKind; name: string; revision_no: number; model_json: string }>(db, `
    SELECT o.id AS object_id, o.kind, o.name, r.revision_no, r.model_json
      FROM version_objects vo
      JOIN object_revisions r ON r.id = vo.revision_id
      JOIN objects o ON o.id = r.object_id
     WHERE vo.version_id = ? ORDER BY o.kind, o.name`, id);
  // MD 출처는 루틴을 알 수 없다 (diff 가 루틴을 비교하지 않도록 표시)
  const model: SchemaModel = {
    name: version.schemaName, tables: [], views: [], routines: [],
    ...(version.sourceFormat === 'md' ? { routinesUnknown: true } : {}), ...(evidence ? { evidence } : {}),
  };
  for (const r of rows) {
    const obj = JSON.parse(r.model_json) as Table | View | Routine;
    if (obj.kind === 'table') model.tables.push(obj);
    else if (obj.kind === 'view') model.views.push(obj);
    else model.routines.push(obj);
  }
  const objects = rows.map((r) => ({ objectId: Number(r.object_id), kind: r.kind, name: r.name, revisionNo: Number(r.revision_no) }));
  const staleReason = loadStaleReason(db, id);
  return { version, model, objects, ...(staleReason ? { staleReason } : {}) };
}

export function getSource(db: Db, id: number): { filename: string; text: string } {
  const r = one<{ source_filename: string; source_text: string }>(db, `
    SELECT v.source_filename, src.source_text FROM schema_versions v JOIN schema_version_sources src ON src.version_id = v.id WHERE v.id = ?`, id);
  if (!r) throw NOT_FOUND();
  return { filename: r.source_filename, text: r.source_text };
}

// 스냅샷이 서로 독립이라 다른 버전에는 영향이 없다. 지운 버전이 쓰던 리비전·객체 중 더 이상 참조되지 않는 것만 정리한다
// 순서: 버전(→ version_objects·원문 연쇄 삭제) → 고아 리비전 → 리비전이 남지 않은 객체 (FK 가 남은 참조를 막는다)
export function deleteVersion(db: Db, id: number): void {
  const { schemaId } = getVersionMeta(db, id);
  tx(db, () => {
    const links = all<{ object_id: number; revision_id: number }>(db, 'SELECT object_id, revision_id FROM version_objects WHERE version_id = ?', id);
    const revisionIds = JSON.stringify(links.map((l) => Number(l.revision_id)));
    const objectIds = JSON.stringify(links.map((l) => Number(l.object_id)));
    run(db, 'DELETE FROM schema_versions WHERE id = ?', id);
    run(db, `DELETE FROM object_revisions WHERE id IN (SELECT value FROM json_each(?))
               AND NOT EXISTS (SELECT 1 FROM version_objects vo WHERE vo.revision_id = object_revisions.id)`, revisionIds);
    run(db, `DELETE FROM objects WHERE schema_id = ? AND id IN (SELECT value FROM json_each(?))
               AND NOT EXISTS (SELECT 1 FROM object_revisions r WHERE r.object_id = objects.id)`, schemaId, objectIds);
  });
}
