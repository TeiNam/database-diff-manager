import { all, one, type Db } from '../db/connection';
import { AppError } from '../errors';

export interface ObjectHistory {
  object: { id: number; kind: 'table' | 'view'; name: string; schemaId: number };
  revisions: { revisionNo: number; fidelity: string; parseError: string | null; firstVersion: { id: number; versionNo: number; uploadedAt: string } }[];
}

export function objectHistory(db: Db, objectId: number): ObjectHistory {
  const obj = one<{ id: number; kind: 'table' | 'view'; name: string; schema_id: number }>(db, 'SELECT id, kind, name, schema_id FROM objects WHERE id = ?', objectId);
  if (!obj) throw new AppError(404, '객체를 찾을 수 없습니다');
  const rows = all<{ revision_no: number; fidelity: string; parse_error: string | null; version_id: number; version_no: number; uploaded_at: string }>(db, `
    SELECT r.revision_no, r.fidelity, r.parse_error, v.id AS version_id, v.version_no, v.uploaded_at
      FROM object_revisions r
      JOIN schema_versions v ON v.id = (
        SELECT v2.id FROM version_objects vo JOIN schema_versions v2 ON v2.id = vo.version_id
         WHERE vo.revision_id = r.id ORDER BY v2.version_no LIMIT 1)
     WHERE r.object_id = ? ORDER BY r.revision_no`, objectId);
  return {
    object: { id: Number(obj.id), kind: obj.kind, name: obj.name, schemaId: Number(obj.schema_id) },
    revisions: rows.map((r) => ({
      revisionNo: Number(r.revision_no),
      fidelity: r.fidelity,
      parseError: r.parse_error,
      firstVersion: { id: Number(r.version_id), versionNo: Number(r.version_no), uploadedAt: r.uploaded_at },
    })),
  };
}
