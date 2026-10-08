import { canonicalJson, diffSchemas, generateDdl, parseDmsMapping, renderDdl, toRenameMappings, type RenameMapping, type SchemaDiff, type SchemaModel, type Statement } from '@tdm/core';
import type { Db } from '../db/connection';
import { latestMigration } from '../repos/migrations';
import { listRenames } from '../repos/renames';
import { getVersionMeta, loadVersion, type VersionDetail, type VersionMeta } from '../repos/versions';

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

// 버전 내용은 불변이라 키는 (base, target, 전환 매핑 id, 수동 rename 매핑)뿐이다. 버전·매핑 삭제 시 clear()로 비운다(id 재사용 대비)
export class DiffCache {
  private readonly entries = new Map<string, DiffResponse>();

  constructor(private readonly max: number) {}

  get(key: string): DiffResponse | undefined {
    const value = this.entries.get(key);
    if (value) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: DiffResponse): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(): void {
    this.entries.clear();
  }
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

type LatestMigration = ReturnType<typeof latestMigration>;

export const latestMigrationFor = (db: Db, baseId: number, targetId: number): LatestMigration =>
  latestMigration(db, getVersionMeta(db, baseId).schemaId, getVersionMeta(db, targetId).schemaId);

// 최신 전환 매핑에서 나온 rename (매핑이 없으면 빈 배열)
export function dmsRenamesFor(migration: LatestMigration, baseModel: SchemaModel, targetModel: SchemaModel): RenameMapping[] {
  return migration ? toRenameMappings(parseDmsMapping(migration.source).mapping, baseModel, targetModel) : [];
}

// diff 계산 재료. PUT /diff/renames 가 한 번 계산한 DMS rename 을 computeDiff 에 그대로 넘겨 매핑 파싱·flow 를 다시 하지 않는다
export interface DiffInputs {
  migration: LatestMigration;
  base: VersionDetail;
  target: VersionDetail;
  dms: RenameMapping[];
}

export function loadDiffInputs(db: Db, baseId: number, targetId: number, migration = latestMigrationFor(db, baseId, targetId)): DiffInputs {
  const base = loadVersion(db, baseId);
  const target = loadVersion(db, targetId);
  return { migration, base, target, dms: dmsRenamesFor(migration, base.model, target.model) };
}

export function computeDiff(db: Db, cache: DiffCache, baseId: number, targetId: number, inputs?: DiffInputs): DiffResponse {
  const manual = listRenames(db, baseId, targetId);
  const migration = inputs?.migration ?? latestMigrationFor(db, baseId, targetId);
  const key = `${baseId}:${targetId}:${migration?.id ?? 0}:${canonicalJson(manual)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const { base, target, dms } = inputs ?? loadDiffInputs(db, baseId, targetId, migration);
  const renames = mergeRenames(dms, manual);
  const diff = diffSchemas(base.model, target.model, renames);
  const statements = generateDdl(diff);
  const result: DiffResponse = {
    base: base.version, target: target.version, baseModel: base.model, targetModel: target.model,
    diff, statements, ddl: renderDdl(statements, diff.partial), renames,
  };
  cache.set(key, result);
  return result;
}
