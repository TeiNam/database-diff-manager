import type { ApplyDefaults } from '@tdm/core';
import { one, run, type Db } from '../db/connection';

// ALTER 적용으로 만든 버전의 기준·스크립트 (009)
export interface Derivation {
  baseVersionId: number | null; // 기준 버전이 지워지면 null
  baseVersionNo: number;
  script: string;
  statementCount: number;
  defaults: ApplyDefaults;
}

export function saveDerivation(db: Db, versionId: number, d: Derivation): void {
  run(db, `INSERT INTO schema_version_derivations (version_id, base_version_id, base_version_no, script, statement_count, default_charset, default_collation)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
    versionId, d.baseVersionId, d.baseVersionNo, d.script, d.statementCount, d.defaults.charset, d.defaults.collation);
}

export function loadDerivation(db: Db, versionId: number): Derivation | undefined {
  const r = one<{ base_version_id: number | null; base_version_no: number; script: string; statement_count: number; default_charset: string; default_collation: string }>(db,
    'SELECT base_version_id, base_version_no, script, statement_count, default_charset, default_collation FROM schema_version_derivations WHERE version_id = ?', versionId);
  if (!r) return undefined;
  return {
    baseVersionId: r.base_version_id === null ? null : Number(r.base_version_id), baseVersionNo: Number(r.base_version_no), script: r.script,
    statementCount: Number(r.statement_count), defaults: { charset: r.default_charset, collation: r.default_collation },
  };
}
