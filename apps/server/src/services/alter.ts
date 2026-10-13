// ALTER 스크립트를 기준 버전 모델에 적용해 새 버전을 만든다: core applyScript → printSqlDump(원문) → ingest (같은 트랜잭션에서
// 파생 정보·rename 매핑을 쓰고, 완전성 판정은 기준 버전에서 물려받는다)
import { applyScript, ApplyFailure, diffSchemas, parseSqlDump, printSqlDump, type ApplyDefaults, type RenameMapping, type SchemaDiff, type SchemaEvidence, type SchemaModel } from '@tdm/core';
import type { Db } from '../db/connection';
import { AppError } from '../errors';
import { saveDerivation } from '../repos/derivations';
import { loadEvidence } from '../repos/evidence';
import { writeRenames } from '../repos/renames';
import { loadVersion } from '../repos/versions';
import { ingest } from './ingest';

export interface AlterInput {
  baseId: number;
  script: string;
  filename?: string;
  note?: string;
  defaults?: Partial<ApplyDefaults>;
  dryRun?: boolean;
  userId: number;
}

export interface AlterChange {
  kind: 'table' | 'view' | 'function' | 'procedure';
  name: string;
  op: 'add' | 'drop' | 'modify' | 'rename';
}

export type AlterResult =
  | { status: 'preview'; applied: number; changes: AlterChange[]; renames: RenameMapping[] }
  | { status: 'ok' | 'duplicate'; versionId: number; versionNo: number; applied: number; changes: AlterChange[] };

const NO_EVIDENCE: SchemaEvidence = { level: 'unknown', reason: '기준 버전의 완전성 판정이 없습니다', objects: [] };

export function applyAlter(db: Db, input: AlterInput): AlterResult {
  const base = loadVersion(db, input.baseId);
  if (base.version.sourceFormat !== 'sql') throw new AppError(400, 'MD 로 올린 버전에는 ALTER 를 적용할 수 없습니다 — SQL 덤프 버전을 기준으로 고르세요');
  if (base.staleReason) throw new AppError(400, `기준 버전 v${base.version.versionNo} 은 예전 파서로 저장된 모델이라 ALTER 를 적용할 수 없습니다 — 같은 원문을 다시 올린 버전을 기준으로 고르세요`);
  // 저장 때 쓸 파일 이름. 미리보기도 같은 검사를 거쳐야 미리보기가 통과한 요청이 저장에서 거부되지 않는다
  const filename = input.filename ?? 'alter.sql';
  if (!/\.sql$/i.test(filename)) throw new AppError(400, 'ALTER 스크립트 파일 이름은 .sql 로 끝나야 합니다');
  // 기본값 병합(문자셋만 주면 그 문자셋의 기본 콜레이션)은 core 가 한다 — 여기서 MYSQL_DEFAULTS 와 먼저 합치면 문자셋만 준 요청이 1253 으로 실패한다
  const result = applyScript(base.model, input.script, { schemaName: base.version.schemaName, ...(input.defaults ? { defaults: input.defaults } : {}) });
  if (!result.ok) {
    const { index, line, reason } = result.error;
    throw new AppError(400, index > 0 ? `${index}번째 문장 (줄 ${line}): ${reason}` : reason, { error: result.error });
  }
  const text = printDump(result.model, base.version.schemaName);
  const changes = changesOf(diffSchemas(base.model, parseSqlDump(text).model, result.renames));
  if (!changes.length) throw new AppError(400, '변경 없음 — 스크립트를 적용해도 기준 버전과 같습니다');
  if (input.dryRun) return { status: 'preview', applied: result.applied, changes, renames: result.renames };
  const saved = ingest(db, {
    databaseName: base.version.databaseName, schemaName: base.version.schemaName, filename, text, note: input.note, userId: input.userId,
    evidence: loadEvidence(db, input.baseId) ?? NO_EVIDENCE,
    onCreated: (versionId) => {
      saveDerivation(db, versionId, { baseVersionId: input.baseId, baseVersionNo: base.version.versionNo, script: input.script, statementCount: result.applied, defaults: result.defaults });
      writeRenames(db, input.baseId, versionId, result.renames, input.userId);
    },
  });
  return { status: saved.status, versionId: saved.versionId, versionNo: saved.versionNo, applied: result.applied, changes };
}

// 결과 모델을 td-export 형식 덤프로 출력한다. core 가 출력할 수 없다고 알린 경우(ApplyFailure — 스키마 이름·루틴 본문에 쓸 수 없는 문자열)만
// 400 으로 바꾸고, 그 밖의 예외는 서버 오류로 그대로 던진다
function printDump(model: SchemaModel, schemaName: string): string {
  try {
    return printSqlDump({ ...model, name: schemaName });
  } catch (e) {
    if (e instanceof ApplyFailure) throw new AppError(400, e.message);
    throw e;
  }
}

function changesOf(diff: SchemaDiff): AlterChange[] {
  return [
    ...diff.tables.map((t): AlterChange => ({ kind: 'table', name: t.name, op: t.op })),
    ...diff.views.map((v): AlterChange => ({ kind: 'view', name: v.name, op: v.op })),
    ...diff.routines.map((r): AlterChange => ({ kind: r.kind, name: r.name, op: r.op })),
  ];
}
