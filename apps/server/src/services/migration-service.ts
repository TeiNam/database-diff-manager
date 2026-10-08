import { buildMigrationFlow, DmsParseError, parseDmsMapping, type DmsMapping, type DmsWarning, type MigrationFlow } from '@tdm/core';
import type { Db } from '../db/connection';
import { AppError } from '../errors';
import { getSchema } from '../repos/catalog';
import { addMigration, latestMigration, type MigrationMeta } from '../repos/migrations';
import { getVersionMeta, loadVersion } from '../repos/versions';

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

// 파싱 불가는 400. 업로드 자체를 거부한다
export function parseOrReject(source: string): { mapping: DmsMapping; warnings: DmsWarning[] } {
  try {
    return parseDmsMapping(source);
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
  const { mapping, warnings } = parseOrReject(input.source);
  const migration = addMigration(db, { ...input, ruleCount: mapping.ruleCount });
  return { migration, warnings: [...schemaNameWarnings(mapping, from.name, to.name), ...warnings] };
}

// BASE 버전의 Schema → TARGET 버전의 Schema 쌍에 걸린 최신 리비전만 쓴다 (역방향에는 적용하지 않는다)
export function computeMigrationFlow(db: Db, baseId: number, targetId: number): MigrationFlowResponse {
  const base = getVersionMeta(db, baseId);
  const target = getVersionMeta(db, targetId);
  const latest = latestMigration(db, base.schemaId, target.schemaId);
  if (!latest) return { mapping: null };
  const { source, ...meta } = latest;
  const { mapping, warnings } = parseDmsMapping(source);
  const flow = buildMigrationFlow(loadVersion(db, baseId).model, loadVersion(db, targetId).model, mapping);
  return { mapping: meta, flow, warnings: [...schemaNameWarnings(mapping, base.schemaName, target.schemaName), ...warnings] };
}
