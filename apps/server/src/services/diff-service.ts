import { canonicalJson, diffSchemas, generateDdl, renderDdl, type RenameMapping, type SchemaDiff, type SchemaModel, type Statement } from '@tdm/core';
import type { Db } from '../db/connection';
import { listRenames } from '../repos/renames';
import { loadVersion, type VersionMeta } from '../repos/versions';

export interface DiffResponse {
  base: VersionMeta;
  target: VersionMeta;
  baseModel: SchemaModel;
  targetModel: SchemaModel;
  diff: SchemaDiff;
  statements: Statement[];
  ddl: string;
  renames: RenameMapping[];
}

// 버전 내용은 불변이라 키는 (base, target, rename 매핑)뿐이다. 버전 삭제 시 clear()로 비운다(id 재사용 대비)
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

export function computeDiff(db: Db, cache: DiffCache, baseId: number, targetId: number): DiffResponse {
  const renames = listRenames(db, baseId, targetId);
  const key = `${baseId}:${targetId}:${canonicalJson(renames)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const base = loadVersion(db, baseId);
  const target = loadVersion(db, targetId);
  const diff = diffSchemas(base.model, target.model, renames);
  const statements = generateDdl(diff);
  const result: DiffResponse = {
    base: base.version, target: target.version, baseModel: base.model, targetModel: target.model,
    diff, statements, ddl: renderDdl(statements, diff.partial), renames,
  };
  cache.set(key, result);
  return result;
}
