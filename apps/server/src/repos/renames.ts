import type { RenameMapping } from '@tdm/core';
import { all, run, tx, type Db } from '../db/connection';

interface RenameRecord {
  kind: RenameMapping['kind'];
  table_name: string | null;
  old_name: string;
  new_name: string;
}

export function listRenames(db: Db, baseId: number, targetId: number): RenameMapping[] {
  return all<RenameRecord>(db,
    'SELECT kind, table_name, old_name, new_name FROM rename_mappings WHERE base_version_id = ? AND target_version_id = ? ORDER BY id',
    baseId, targetId,
  ).map((r) => ({ kind: r.kind, ...(r.table_name === null ? {} : { table: r.table_name }), from: r.old_name, to: r.new_name }));
}

// (base, target) 쌍의 매핑 전체를 바꾼다
export function replaceRenames(db: Db, baseId: number, targetId: number, renames: RenameMapping[], userId: number): void {
  tx(db, () => {
    run(db, 'DELETE FROM rename_mappings WHERE base_version_id = ? AND target_version_id = ?', baseId, targetId);
    for (const r of renames) {
      run(db, `INSERT INTO rename_mappings (base_version_id, target_version_id, kind, table_name, old_name, new_name, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?)`, baseId, targetId, r.kind, r.table ?? null, r.from, r.to, userId);
    }
  });
}
