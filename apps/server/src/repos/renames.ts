import type { RenameMapping } from '@tdm/core';
import { all, one, run, tx, type Db } from '../db/connection';

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

// 이 쌍에 매핑을 명시적으로 저장한 적이 있는지 (빈 목록 저장 포함)
export function hasSavedRenames(db: Db, baseId: number, targetId: number): boolean {
  return one(db, 'SELECT 1 AS x FROM rename_mapping_sets WHERE base_version_id = ? AND target_version_id = ?', baseId, targetId) !== undefined;
}

// (base, target) 쌍의 매핑 전체를 바꾸고, 이 쌍에 저장했음을 기록한다 (같은 버전끼리는 매핑이 없어 기록하지 않는다).
// 트랜잭션은 호출자가 연다 (ALTER 적용은 새 버전과 같은 트랜잭션에서 쓴다)
export function writeRenames(db: Db, baseId: number, targetId: number, renames: RenameMapping[], userId: number): void {
  run(db, 'DELETE FROM rename_mappings WHERE base_version_id = ? AND target_version_id = ?', baseId, targetId);
  if (baseId !== targetId) run(db, 'INSERT OR IGNORE INTO rename_mapping_sets (base_version_id, target_version_id) VALUES (?, ?)', baseId, targetId);
  for (const r of renames) {
    run(db, `INSERT INTO rename_mappings (base_version_id, target_version_id, kind, table_name, old_name, new_name, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`, baseId, targetId, r.kind, r.table ?? null, r.from, r.to, userId);
  }
}

export function replaceRenames(db: Db, baseId: number, targetId: number, renames: RenameMapping[], userId: number): void {
  tx(db, () => writeRenames(db, baseId, targetId, renames, userId));
}
