// ALTER 스크립트를 기준 버전 모델에 적용해 새 버전을 만든다: core applyScript → printSqlDump(원문) → ingest (같은 트랜잭션에서
// 파생 정보·rename 매핑을 쓰고, 완전성 판정은 기준 버전에서 물려받는다)
import { applyScript, ApplyFailure, diffSchemas, parseSqlDump, printSqlDump, type ApplyDefaults, type RenameMapping, type SchemaDiff, type SchemaEvidence, type SchemaModel } from '@tdm/core';
import type { Db } from '../db/connection';
import { AppError } from '../errors';
import { saveDerivation } from '../repos/derivations';
import { loadEvidence } from '../repos/evidence';
import { writeRenames } from '../repos/renames';
import { getVersionFingerprint, isSameFingerprint, loadVersion, type VersionFingerprint } from '../repos/versions';
import { roundTripMismatches, type RoundTripInput } from './alter-round-trip';
import { ingest } from './ingest';

export interface AlterInput {
  baseId: number;
  script: string;
  filename?: string;
  note?: string;
  defaults?: Partial<ApplyDefaults>;
  dryRun?: boolean;
  expectedBase?: VersionFingerprint; // 미리보기가 돌려준 기준 버전 지문. 저장(dryRun 아님)에는 꼭 있어야 하고, 있으면 미리보기에서도 대조한다
  userId: number;
  requestId?: string; // 안전망이 막을 때 메시지와 서버 로그에 남긴다
  log?: { warn(details: object, message: string): void };
}

export interface AlterChange {
  kind: 'table' | 'view' | 'function' | 'procedure';
  name: string;
  op: 'add' | 'drop' | 'modify' | 'rename';
}

export type AlterResult =
  | { status: 'preview'; applied: number; changes: AlterChange[]; renames: RenameMapping[]; base: VersionFingerprint }
  | { status: 'ok' | 'duplicate'; versionId: number; versionNo: number; applied: number; changes: AlterChange[] };

const NO_EVIDENCE: SchemaEvidence = { level: 'unknown', reason: '기준 버전의 완전성 판정이 없습니다', objects: [] };
const MAX_LISTED_OBJECTS = 5;
const MISSING_EXPECTED_BASE = '저장하려면 미리보기가 돌려준 기준 버전 지문(expectedBase)이 필요합니다 — 먼저 미리보기를 실행하세요';
const STALE_BASE = '기준 버전이 바뀌었습니다 — 미리보기 뒤에 다른 곳에서 지우고 다시 올렸을 수 있습니다. 미리보기를 다시 실행하세요';

export function applyAlter(db: Db, input: AlterInput): AlterResult {
  // 기준 버전은 행 ID 로 가리키는데, 가장 큰 ID 의 버전을 지우면 다른 업로드가 그 ID 를 다시 쓴다.
  // 지문이 없으면 미리보기 뒤에 바뀐 버전에 그대로 적용되므로 저장은 지문을 요구한다 (R4-01)
  if (!input.dryRun && !input.expectedBase) throw new AppError(400, MISSING_EXPECTED_BASE);
  // 모델을 읽기 전에 먼저 가린다. 이 함수는 동기라 여기서 확인한 버전이 그대로 저장의 기준이 된다 (다른 요청이 끼어들지 않는다)
  const fingerprint = getVersionFingerprint(db, input.baseId); // 없는 버전은 404
  if (input.expectedBase && !isSameFingerprint(input.expectedBase, fingerprint)) throw new AppError(409, STALE_BASE);
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
  const reparsed = parseSqlDump(text);
  assertRoundTrip(input, { base: base.model, baseAgain: () => parseSqlDump(printDump(base.model, base.version.schemaName)), applied: result.model, reparsed });
  const changes = changesOf(diffSchemas(base.model, reparsed.model, result.renames));
  if (!changes.length) throw new AppError(400, '변경 없음 — 스크립트를 적용해도 기준 버전과 같습니다');
  if (input.dryRun) return { status: 'preview', applied: result.applied, changes, renames: result.renames, base: fingerprint };
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

// 출력한 덤프를 다시 읽은 모델이 적용 결과와 같아야 한다 (alter-round-trip.ts). 어긋나면 그대로 저장할 때 기준 버전의 판정을 물려받은 채 객체가 조용히
// 사라지거나 바뀐 버전이 생기므로 미리보기와 저장 모두 거부한다. 이 도구의 출력·읽기가 어긋난 것이라 스크립트를 고치거나 다시 뽑아 올려도 풀리지 않으므로,
// 진단할 수 있게 어긋난 객체 이름과 요청 ID 를 서버 로그에 남긴다 (스크립트는 남기지 않는다)
function assertRoundTrip(input: AlterInput, check: RoundTripInput): void {
  const objects = roundTripMismatches(check);
  if (!objects.length) return;
  input.log?.warn({ requestId: input.requestId, baseVersionId: input.baseId, objects }, 'ALTER 안전망: 출력한 덤프를 다시 읽은 결과가 적용 결과와 다릅니다');
  const listed = objects.slice(0, MAX_LISTED_OBJECTS).join(', ') + (objects.length > MAX_LISTED_OBJECTS ? ` 외 ${objects.length - MAX_LISTED_OBJECTS}개` : '');
  throw new AppError(400, `ALTER 결과를 덤프로 출력해 다시 읽으면 적용 결과와 달라 저장할 수 없습니다: ${listed} — 스크립트나 기준 버전의 문제가 아니라 이 도구의 출력·읽기가 어긋난 것이므로 관리자에게 알려 주세요${input.requestId ? ` (요청 ID ${input.requestId})` : ''}`);
}

function changesOf(diff: SchemaDiff): AlterChange[] {
  return [
    ...diff.tables.map((t): AlterChange => ({ kind: 'table', name: t.name, op: t.op })),
    ...diff.views.map((v): AlterChange => ({ kind: 'view', name: v.name, op: v.op })),
    ...diff.routines.map((r): AlterChange => ({ kind: r.kind, name: r.name, op: r.op })),
  ];
}
