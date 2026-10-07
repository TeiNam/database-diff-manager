import type { SchemaModel, SourceFormat, Table, View } from '@tdm/core';
import { all, one, run, tx, type Db } from '../db/connection';
import { AppError } from '../errors';
import { getSchema } from './catalog';

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
}

export interface VersionSummary extends VersionMeta {
  changedObjects: number; // 직전 버전 대비 추가·삭제·변경된 객체 수
}

export interface VersionObject {
  objectId: number;
  kind: 'table' | 'view';
  name: string;
  revisionNo: number;
}

export interface VersionDetail {
  version: VersionMeta;
  model: SchemaModel;
  objects: VersionObject[];
}

interface MetaRecord {
  id: number; schema_id: number; database_id: number; database_name: string; schema_name: string; version_no: number;
  source_format: SourceFormat; source_filename: string; note: string | null; uploaded_by: string; uploaded_at: string;
}

const META_SQL = `
  SELECT v.id, v.schema_id, s.database_id, d.name AS database_name, s.name AS schema_name, v.version_no,
         v.source_format, v.source_filename, v.note, u.username AS uploaded_by, v.uploaded_at
    FROM schema_versions v
    JOIN schemas s ON s.id = v.schema_id
    JOIN databases d ON d.id = s.database_id
    JOIN users u ON u.id = v.uploaded_by`;

const toMeta = (r: MetaRecord): VersionMeta => ({
  id: Number(r.id), schemaId: Number(r.schema_id), databaseId: Number(r.database_id), databaseName: r.database_name,
  schemaName: r.schema_name, versionNo: Number(r.version_no), sourceFormat: r.source_format, sourceFilename: r.source_filename,
  note: r.note, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
});

const NOT_FOUND = () => new AppError(404, '버전을 찾을 수 없습니다');

export function getVersionMeta(db: Db, id: number): VersionMeta {
  const r = one<MetaRecord>(db, `${META_SQL} WHERE v.id = ?`, id);
  if (!r) throw NOT_FOUND();
  return toMeta(r);
}

export function listVersions(db: Db, schemaId: number): VersionSummary[] {
  getSchema(db, schemaId);
  const metas = all<MetaRecord>(db, `${META_SQL} WHERE v.schema_id = ? ORDER BY v.version_no`, schemaId).map(toMeta);
  const links = all<{ version_id: number; object_id: number; content_hash: string }>(db, `
    SELECT vo.version_id, r.object_id, r.content_hash
      FROM version_objects vo JOIN object_revisions r ON r.id = vo.revision_id
      JOIN schema_versions v ON v.id = vo.version_id WHERE v.schema_id = ?`, schemaId);
  const byVersion = new Map<number, Map<number, string>>();
  for (const l of links) {
    const objects = byVersion.get(Number(l.version_id)) ?? new Map<number, string>();
    objects.set(Number(l.object_id), l.content_hash);
    byVersion.set(Number(l.version_id), objects);
  }
  let previous = new Map<number, string>(); // object_id -> content_hash (중간 버전 삭제 시 과대 계산 방지)
  const summaries = metas.map((meta) => {
    const current = byVersion.get(meta.id) ?? new Map<number, string>();
    const objectIds = new Set([...previous.keys(), ...current.keys()]);
    const changedObjects = [...objectIds].filter((o) => previous.get(o) !== current.get(o)).length;
    previous = current;
    return { ...meta, changedObjects };
  });
  return summaries.reverse();
}

export function loadVersion(db: Db, id: number): VersionDetail {
  const version = getVersionMeta(db, id);
  const rows = all<{ object_id: number; kind: 'table' | 'view'; name: string; revision_no: number; model_json: string }>(db, `
    SELECT o.id AS object_id, o.kind, o.name, r.revision_no, r.model_json
      FROM version_objects vo
      JOIN object_revisions r ON r.id = vo.revision_id
      JOIN objects o ON o.id = r.object_id
     WHERE vo.version_id = ? ORDER BY o.kind, o.name`, id);
  const model: SchemaModel = { name: version.schemaName, tables: [], views: [] };
  for (const r of rows) {
    const obj = JSON.parse(r.model_json) as Table | View;
    if (obj.kind === 'table') model.tables.push(obj);
    else model.views.push(obj);
  }
  const objects = rows.map((r) => ({ objectId: Number(r.object_id), kind: r.kind, name: r.name, revisionNo: Number(r.revision_no) }));
  return { version, model, objects };
}

export function getSource(db: Db, id: number): { filename: string; text: string } {
  const r = one<{ source_filename: string; source_text: string }>(db, 'SELECT source_filename, source_text FROM schema_versions WHERE id = ?', id);
  if (!r) throw NOT_FOUND();
  return { filename: r.source_filename, text: r.source_text };
}

// 스냅샷이 서로 독립이라 다른 버전에는 영향이 없다. 어떤 버전도 참조하지 않는 리비전·객체를 정리한다
export function deleteVersion(db: Db, id: number): void {
  getVersionMeta(db, id);
  tx(db, () => {
    run(db, 'DELETE FROM schema_versions WHERE id = ?', id);
    run(db, 'DELETE FROM object_revisions WHERE id NOT IN (SELECT revision_id FROM version_objects)');
    run(db, 'DELETE FROM objects WHERE id NOT IN (SELECT object_id FROM object_revisions)');
  });
}
