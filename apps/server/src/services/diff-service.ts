import { canonicalJson, diffSchemas, flowRenameMappings, generateDdl, holdAllStatements, renderDdl, type RenameMapping, type SchemaDiff, type SchemaModel, type Statement } from '@tdm/core';
import type { Db } from '../db/connection';
import { hasSavedRenames, listRenames } from '../repos/renames';
import { getVersionMeta, loadVersion, type VersionDetail, type VersionMeta } from '../repos/versions';
import type { AppCache } from './cache';
import { migrationFlowFor, migrationRefFor, type MigrationRef } from './migration-service';

export type RenameSource = 'dms' | 'manual';
// reversed: 역쌍(target, base)에 저장된 수동 매핑을 뒤집어 적용한 것 (이 쌍에는 저장되어 있지 않다)
export type SourcedRename = RenameMapping & { source: RenameSource; reversed?: true };

export interface DiffResponse {
  base: VersionMeta;
  target: VersionMeta;
  baseModel: SchemaModel;
  targetModel: SchemaModel;
  diff: SchemaDiff;
  statements: Statement[];
  ddl: string;
  renames: SourcedRename[];
  // 예전 파서로 저장된 모델(stale-model)인 BASE·TARGET 버전 (16회차 2). 있으면 실행 문장을 모두 수동 확인으로 돌린다
  staleModels: StaleModel[];
}

export interface StaleModel {
  side: 'base' | 'target';
  versionId: number;
  versionNo: number;
  reason: string;
}

const STALE_NOTE = '예전 파서로 저장된 버전이 낀 비교라 어느 문장도 실행하지 않습니다 — 같은 원문을 다시 올려 새 버전끼리 비교하세요';

// stale 버전이 낀 diff 의 실행 문장을 모두 수동 확인으로 돌린다 (저장 모델이 원문과 달라 어떤 문장이 원문과 다른 모델에서 나왔는지 모른다)
function staleModelsOf(base: VersionDetail, target: VersionDetail): StaleModel[] {
  return ([['base', base], ['target', target]] as const).flatMap(([side, v]) =>
    (v.staleReason ? [{ side, versionId: v.version.id, versionNo: v.version.versionNo, reason: v.staleReason }] : []));
}

// rename 대상 식별 키 (kind, table, from). 라우트와 공유한다
export const renameKey = (r: RenameMapping) => `${r.kind}:${r.table ?? ''}:${r.from}`;

// 매핑 전체 식별 키 (kind, table, from, to)
export const renameFullKey = (r: RenameMapping) => `${renameKey(r)}>${r.to}`;

// DMS 컬럼·인덱스 매핑의 table 은 DMS 테이블 대응의 TARGET 이름이다. 수동 테이블 rename 이 같은 원본 테이블을 다른 이름으로
// 덮으면(members→member 를 members→customer 로) 최종 테이블 대응으로 table 을 다시 정한다. 최종 대응에서 원본 테이블이
// 갈 곳이 없으면(다른 테이블이 그 이름을 차지) 그 매핑은 뺀다
export function retargetDms(dms: RenameMapping[], manual: RenameMapping[]): RenameMapping[] {
  const manualTables = manual.filter((r) => r.kind === 'table');
  if (!manualTables.length) return dms;
  const dmsTables = dms.filter((r) => r.kind === 'table');
  const dmsBaseOf = new Map(dmsTables.map((r): [string, string] => [r.to, r.from]));
  const manualFrom = new Set(manualTables.map((r) => r.from));
  const finalMap = new Map([
    ...dmsTables.filter((r) => !manualFrom.has(r.from)).map((r): [string, string] => [r.from, r.to]),
    ...manualTables.map((r): [string, string] => [r.from, r.to]),
  ]);
  const finalTargets = new Set(finalMap.values());
  const finalOf = (base: string) => finalMap.get(base) ?? (finalTargets.has(base) ? undefined : base);
  return dms.flatMap((r) => {
    if (r.kind === 'table' || r.table === undefined) return [r];
    const table = finalOf(dmsBaseOf.get(r.table) ?? r.table);
    if (table === undefined) return [];
    return table === r.table ? [r] : [{ ...r, table }];
  });
}

// 같은 대상(kind, table, from)이면 수동 매핑이 DMS 매핑을 이긴다. DMS 컬럼·인덱스 매핑은 최종 테이블 대응으로 옮긴 뒤 비교한다
export function mergeRenames(dms: RenameMapping[], manual: RenameMapping[], isReversed = false): SourcedRename[] {
  const manualKeys = new Set(manual.map(renameKey));
  return [
    ...retargetDms(dms, manual).filter((r) => !manualKeys.has(renameKey(r))).map((r) => ({ ...r, source: 'dms' as const })),
    ...manual.map((r) => ({ ...r, source: 'manual' as const, ...(isReversed ? { reversed: true as const } : {}) })),
  ];
}

// (base, target) 매핑을 (target, base) 방향으로 뒤집는다. column/index 의 table 은 새 TARGET(옛 BASE) 쪽 이름으로 바꾼다.
// 테이블 대응은 뒤집은 수동 테이블 rename 이 우선이고, 없으면 (target, base) 방향 DMS 테이블 rename(옛 TARGET → 옛 BASE)을 쓴다
export function invertRenames(renames: RenameMapping[], reverseDms: RenameMapping[] = []): RenameMapping[] {
  const oldTableName = new Map([
    ...reverseDms.filter((r) => r.kind === 'table').map((r): [string, string] => [r.from, r.to]),
    ...renames.filter((r) => r.kind === 'table').map((r): [string, string] => [r.to, r.from]),
  ]);
  return renames.map((r) => (r.kind === 'table'
    ? { kind: r.kind, from: r.to, to: r.from }
    : { kind: r.kind, table: oldTableName.get(r.table ?? '') ?? r.table, from: r.to, to: r.from }));
}

// 이 쌍의 수동 매핑. 이 쌍에 저장한 적이 없으면(빈 목록 저장도 저장이다) 역쌍에 저장된 매핑을 돌려준다 (뒤집기는 DMS 를 읽은 뒤)
function manualRenamesFor(db: Db, baseId: number, targetId: number): { manual: RenameMapping[]; reverse?: RenameMapping[] } {
  const forward = listRenames(db, baseId, targetId);
  if (forward.length || baseId === targetId || hasSavedRenames(db, baseId, targetId)) return { manual: forward };
  const reverse = listRenames(db, targetId, baseId);
  return reverse.length ? { manual: [], reverse } : { manual: [] };
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

// 역쌍(정방향) diff 에서 최종 적용된 rename (renameFullKey 형식)과 그 diff 의 테이블 대응
function forwardApplied(db: Db, cache: AppCache, baseId: number, targetId: number): { keys: Set<string>; diff: SchemaDiff } {
  const { diff } = computeDiff(db, cache, baseId, targetId);
  return { keys: appliedRenameKeys(diff), diff };
}

// 이 방향 매핑을 뒤집은 정방향 매핑의 키. column/index 의 table(이 방향 TARGET = 정방향 BASE 이름)은 정방향 TARGET 이름으로 바꾼다
function forwardKeyOf(r: RenameMapping, forward: SchemaDiff): string {
  if (r.kind === 'table') return renameFullKey({ kind: 'table', from: r.to, to: r.from });
  const table = forward.tables.find((t) => t.oldName === r.table)?.name ?? r.table;
  return renameFullKey({ kind: r.kind, table, from: r.to, to: r.from });
}

// diff 결과의 rename op (renameFullKey 형식)
function appliedRenameKeys(diff: SchemaDiff): Set<string> {
  const out = new Set<string>();
  for (const t of diff.tables) {
    if (t.op === 'rename') out.add(renameFullKey({ kind: 'table', from: t.oldName!, to: t.name }));
    for (const c of t.columns) if (c.op === 'rename') out.add(renameFullKey({ kind: 'column', table: t.name, from: c.oldName!, to: c.name }));
    for (const i of t.indexes) if (i.op === 'rename') out.add(renameFullKey({ kind: 'index', table: t.name, from: i.oldName!, to: i.name }));
  }
  return out;
}

// 역쌍 수동 매핑을 뒤집어 쓰는 경우: 역쌍(정방향) diff 에서 최종 적용된(DMS·수동을 합친 결과의) rename 만 뒤집는다.
// 같은 대상 매핑·충돌로 빠진 수동 매핑과, 수동 매핑에 덮여 정방향에서 쓰이지 않은 DMS 매핑은 이 방향에서도 쓰지 않는다
function reversedRenames(dms: RenameMapping[], reverse: RenameMapping[], forward: { keys: Set<string>; diff: SchemaDiff }): SourcedRename[] {
  const manual = invertRenames(reverse.filter((r) => forward.keys.has(renameFullKey(r))), dms);
  return mergeRenames(dms, manual, true).filter((r) => r.source !== 'dms' || forward.keys.has(forwardKeyOf(r, forward.diff)));
}

// 버전 내용은 불변이라 캐시 키는 (base, target, 전환 매핑 방향·id, 수동 rename 매핑과 그 출처 방향)뿐이다
export function computeDiff(db: Db, cache: AppCache, baseId: number, targetId: number, inputs?: DiffInputs): DiffResponse {
  const { manual: forward, reverse } = manualRenamesFor(db, baseId, targetId);
  const ref = inputs ? inputs.ref : refFor(db, baseId, targetId);
  const key = `${baseId}:${targetId}:${ref ? `${ref.direction}:${ref.id}` : 'none'}:${reverse ? `rev:${canonicalJson(reverse)}` : `fwd:${canonicalJson(forward)}`}`;
  const cached = cache.diff.get(key);
  if (cached) return cached;
  const { base, target, dms } = inputs ?? loadDiffInputs(db, cache, baseId, targetId, ref);
  const renames = reverse ? reversedRenames(dms, reverse, forwardApplied(db, cache, targetId, baseId)) : mergeRenames(dms, forward);
  const diff = diffSchemas(base.model, target.model, renames);
  const staleModels = staleModelsOf(base, target);
  const generated = generateDdl(diff);
  const statements = staleModels.length
    ? holdAllStatements(generated, `${staleModels[0].reason} (v${staleModels.map((m) => m.versionNo).join('·v')})`, STALE_NOTE)
    : generated;
  const result: DiffResponse = {
    base: base.version, target: target.version, baseModel: base.model, targetModel: target.model,
    diff, statements, ddl: renderDdl(statements, diff.partial), renames, staleModels,
  };
  cache.diff.set(key, result);
  return result;
}
