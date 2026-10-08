import { buildMigrationFlow, DmsParseError, parseDmsMapping, type DmsMapping, type DmsWarning, type MigrationFlow, type RenameDirection, type SchemaModel } from '@tdm/core';
import type { Db } from '../db/connection';
import { AppError } from '../errors';
import { getSchema } from '../repos/catalog';
import { addMigration, getMigration, getMigrationSource, latestMigrationId, type MigrationMeta } from '../repos/migrations';
import { getVersionMeta, loadVersion, type VersionMeta } from '../repos/versions';
import type { AppCache } from './cache';

export type MigrationFlowResponse =
  | { mapping: null }
  | { mapping: MigrationMeta; flow: MigrationFlow; warnings: DmsWarning[] };

export interface MigrationUpload {
  fromSchemaId: number;
  toSchemaId: number;
  filename: string;
  source: string;
  note?: string;
  userId: number;
}

export interface ParsedMigration {
  meta: MigrationMeta;
  mapping: DmsMapping;
  warnings: DmsWarning[];
}

// 버전 쌍에 걸린 최신 전환 매핑. forward 는 BASE→TARGET 쌍, reverse 는 TARGET→BASE 쌍(되돌리기 비교)
export interface MigrationRef {
  id: number;
  direction: RenameDirection;
}

// 파싱 불가·지정 스키마 룰 없음은 400. 업로드 자체를 거부한다. fromSchema 는 BASE(As-Is) Schema 이름
export function parseOrReject(source: string, fromSchema: string): { mapping: DmsMapping; warnings: DmsWarning[] } {
  try {
    return parseDmsMapping(source, { fromSchema });
  } catch (e) {
    if (e instanceof DmsParseError) throw new AppError(400, e.message);
    throw e;
  }
}

// 파일의 schema 이름이 Schema 이름과 다르면 경고만 한다 (Schema 이름을 바꿔 올리는 경우가 있다)
export function schemaNameWarnings(mapping: DmsMapping, fromName: string, toName: string): DmsWarning[] {
  const out: DmsWarning[] = [];
  const differs = (a: string, b: string) => a.toLowerCase() !== b.toLowerCase();
  if (!mapping.fromSchema.includes('%') && differs(mapping.fromSchema, fromName)) {
    out.push({ ruleId: '', code: 'invalid', message: `파일의 As-Is schema-name '${mapping.fromSchema}' 이 BASE Schema '${fromName}' 과 다릅니다` });
  }
  if (mapping.toSchema !== undefined && differs(mapping.toSchema, toName)) {
    out.push({ ruleId: '', code: 'invalid', message: `파일의 To-Be schema 이름 '${mapping.toSchema}' 이 TARGET Schema '${toName}' 과 다릅니다` });
  }
  return out;
}

export function uploadMigration(db: Db, input: MigrationUpload): { migration: MigrationMeta; warnings: DmsWarning[] } {
  if (input.fromSchemaId === input.toSchemaId) throw new AppError(400, 'As-Is 와 To-Be Schema 가 같습니다');
  const from = getSchema(db, input.fromSchemaId);
  const to = getSchema(db, input.toSchemaId);
  const { mapping, warnings } = parseOrReject(input.source, from.name);
  const migration = addMigration(db, { ...input, ruleCount: mapping.ruleCount });
  return { migration, warnings: [...schemaNameWarnings(mapping, from.name, to.name), ...warnings] };
}

// 정방향 쌍을 먼저 보고, 없으면 역쌍을 본다. id 만 조회한다 (원문은 캐시 miss 때만 읽는다)
export function migrationRefFor(db: Db, base: VersionMeta, target: VersionMeta): MigrationRef | undefined {
  const forward = latestMigrationId(db, base.schemaId, target.schemaId);
  if (forward !== undefined) return { id: forward, direction: 'forward' };
  const reverse = latestMigrationId(db, target.schemaId, base.schemaId);
  return reverse === undefined ? undefined : { id: reverse, direction: 'reverse' };
}

// 저장된 매핑은 업로드 때 검증됐다. 이 변경 이전에 올린 매핑이 지정 스키마 룰을 못 찾으면 예전처럼 파일의 첫 스키마로 읽는다
function parseStored(source: string, fromSchema: string): { mapping: DmsMapping; warnings: DmsWarning[] } {
  try {
    return parseDmsMapping(source, { fromSchema });
  } catch (e) {
    if (e instanceof DmsParseError) return parseDmsMapping(source);
    throw e;
  }
}

// 매핑 id 별 파싱 결과 (캐시). As-Is Schema 이름은 매핑의 from Schema 라 id 로 정해진다
export function parsedMigration(db: Db, cache: AppCache, id: number): ParsedMigration {
  const key = String(id);
  const cached = cache.parsed.get(key);
  if (cached) return cached;
  const meta = getMigration(db, id);
  const parsed = { meta, ...parseStored(getMigrationSource(db, id).text, getSchema(db, meta.fromSchemaId).name) };
  cache.parsed.set(key, parsed);
  return parsed;
}

// 전환 표 (캐시). 모델은 캐시 miss 때만 쓴다. 이미 읽어 둔 모델이 있으면 넘겨 다시 읽지 않는다
export function migrationFlowFor(db: Db, cache: AppCache, id: number, asIsId: number, toBeId: number, models?: { asIs: SchemaModel; toBe: SchemaModel }): MigrationFlow {
  const key = `${id}:${asIsId}:${toBeId}`;
  const cached = cache.flows.get(key);
  if (cached) return cached;
  const { asIs, toBe } = models ?? { asIs: loadVersion(db, asIsId).model, toBe: loadVersion(db, toBeId).model };
  const flow = buildMigrationFlow(asIs, toBe, parsedMigration(db, cache, id).mapping);
  cache.flows.set(key, flow);
  return flow;
}

// BASE 버전의 Schema → TARGET 버전의 Schema 쌍에 걸린 최신 리비전만 쓴다 (역방향 전환 표는 보여 주지 않는다)
export function computeMigrationFlow(db: Db, cache: AppCache, baseId: number, targetId: number): MigrationFlowResponse {
  const base = getVersionMeta(db, baseId);
  const target = getVersionMeta(db, targetId);
  const id = latestMigrationId(db, base.schemaId, target.schemaId);
  if (id === undefined) return { mapping: null };
  const { meta, mapping, warnings } = parsedMigration(db, cache, id);
  const flow = migrationFlowFor(db, cache, id, baseId, targetId);
  return { mapping: meta, flow, warnings: [...schemaNameWarnings(mapping, base.schemaName, target.schemaName), ...warnings] };
}
