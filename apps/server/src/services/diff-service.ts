import { canonicalJson, diffSchemas, flowRenameMappings, generateDdl, renderDdl, type RenameMapping, type SchemaDiff, type SchemaModel, type Statement } from '@tdm/core';
import type { Db } from '../db/connection';
import { listRenames } from '../repos/renames';
import { getVersionMeta, loadVersion, type VersionDetail, type VersionMeta } from '../repos/versions';
import type { AppCache } from './cache';
import { migrationFlowFor, migrationRefFor, type MigrationRef } from './migration-service';

export type RenameSource = 'dms' | 'manual';
export type SourcedRename = RenameMapping & { source: RenameSource };

export interface DiffResponse {
  base: VersionMeta;
  target: VersionMeta;
  baseModel: SchemaModel;
  targetModel: SchemaModel;
  diff: SchemaDiff;
  statements: Statement[];
  ddl: string;
  renames: SourcedRename[];
}

// rename 대상 식별 키 (kind, table, from). 라우트와 공유한다
export const renameKey = (r: RenameMapping) => `${r.kind}:${r.table ?? ''}:${r.from}`;

// 같은 대상(kind, table, from)이면 수동 매핑이 DMS 매핑을 이긴다
export function mergeRenames(dms: RenameMapping[], manual: RenameMapping[]): SourcedRename[] {
  const manualKeys = new Set(manual.map(renameKey));
  return [
    ...dms.filter((r) => !manualKeys.has(renameKey(r))).map((r) => ({ ...r, source: 'dms' as const })),
    ...manual.map((r) => ({ ...r, source: 'manual' as const })),
  ];
}

// 최신 전환 매핑에서 나온 rename (매핑이 없으면 빈 배열). 역쌍 매핑이면 뒤집어 쓴다 (되돌리기 DDL 에 DROP 대신 RENAME)
function dmsRenamesFor(db: Db, cache: AppCache, ref: MigrationRef | undefined, base: VersionDetail, target: VersionDetail): RenameMapping[] {
  if (!ref) return [];
  const [asIs, toBe] = ref.direction === 'forward' ? [base, target] : [target, base];
  const flow = migrationFlowFor(db, cache, ref.id, asIs.version.id, toBe.version.id, { asIs: asIs.model, toBe: toBe.model });
  return flowRenameMappings(flow, ref.direction);
}

// diff 계산 재료. PUT /diff/renames 가 한 번 읽은 버전·DMS rename 을 computeDiff 에 그대로 넘긴다
export interface DiffInputs {
  ref: MigrationRef | undefined;
  base: VersionDetail;
  target: VersionDetail;
  dms: RenameMapping[];
}

const refFor = (db: Db, baseId: number, targetId: number) => migrationRefFor(db, getVersionMeta(db, baseId), getVersionMeta(db, targetId));

export function loadDiffInputs(db: Db, cache: AppCache, baseId: number, targetId: number, ref = refFor(db, baseId, targetId)): DiffInputs {
  const base = loadVersion(db, baseId);
  const target = loadVersion(db, targetId);
  return { ref, base, target, dms: dmsRenamesFor(db, cache, ref, base, target) };
}

// 버전 내용은 불변이라 캐시 키는 (base, target, 전환 매핑 방향·id, 수동 rename 매핑)뿐이다
export function computeDiff(db: Db, cache: AppCache, baseId: number, targetId: number, inputs?: DiffInputs): DiffResponse {
  const manual = listRenames(db, baseId, targetId);
  const ref = inputs ? inputs.ref : refFor(db, baseId, targetId);
  const key = `${baseId}:${targetId}:${ref ? `${ref.direction}:${ref.id}` : 'none'}:${canonicalJson(manual)}`;
  const cached = cache.diff.get(key);
  if (cached) return cached;
  const { base, target, dms } = inputs ?? loadDiffInputs(db, cache, baseId, targetId, ref);
  const renames = mergeRenames(dms, manual);
  const diff = diffSchemas(base.model, target.model, renames);
  const statements = generateDdl(diff);
  const result: DiffResponse = {
    base: base.version, target: target.version, baseModel: base.model, targetModel: target.model,
    diff, statements, ddl: renderDdl(statements, diff.partial), renames,
  };
  cache.diff.set(key, result);
  return result;
}
