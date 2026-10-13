import type { SchemaEvidence, SchemaModel, SourceFormat } from '@tdm/core';
import { all, one, tx, type Db } from '../db/connection';
import { loadDerivation } from '../repos/derivations';
import { JUDGE_REV, loadEvidence, loadStaleReason, saveEvidence } from '../repos/evidence';
import { loadVersion } from '../repos/versions';
import { modelHash, parseSource } from './ingest';

// 원문이 없는 버전: 증거가 없으므로 unknown (TARGET 이면 삭제 문장은 수동 확인)
const NO_SOURCE: SchemaEvidence = { level: 'unknown', reason: '원문이 없어 완전성을 판정할 수 없습니다', objects: [] };
// 저장 모델이 원문을 지금 파서로 다시 파싱한 모델과 다른 버전 (16회차 2). 화면·DDL 에 같은 문구로 보인다
export const STALE_MODEL_REASON = '예전 파서로 저장된 모델입니다 — 원문을 지금 파서로 다시 읽은 모델과 달라 이 버전이 낀 비교의 문장을 실행하지 않습니다. 같은 원문을 다시 올려 새 버전으로 비교하세요';
const UNPARSABLE_REASON = '원문을 지금 파서로 다시 읽지 못해 예전 파서로 저장된 모델을 확인할 수 없습니다 — 이 버전이 낀 비교의 문장을 실행하지 않습니다';
// 원문이 없거나 읽을 수 없는 버전 (17회차 1): 저장 모델을 원문과 대조할 수 없으므로 stale 과 같이 모든 실행 문장을 보류한다
export const NO_SOURCE_STALE_REASON = '원문이 없어 모델을 검증할 수 없음 — 이 버전이 낀 비교의 문장을 실행하지 않습니다. 원문을 다시 올려 새 버전으로 비교하세요';
// 저장 모델 JSON 이 손상된 버전 (17회차 6): 기동을 막지 않고 그 버전만 보류한다
const BROKEN_MODEL_REASON = '저장된 모델을 읽지 못해 원문과 대조할 수 없습니다 — 이 버전이 낀 비교의 문장을 실행하지 않습니다';

// 마이그레이션 직후 JS 단계 (15회차 1, 16회차 2): 판정이 없거나(006 이전 버전), 006 의 표시를 옮겼거나, 판정 규칙 판(JUDGE_REV)이
// 낮은 버전을 원문으로 다시 판정한다. 버전 하나씩 원문 하나만 읽어 한 트랜잭션으로 저장한다 (대용량 DB 도 메모리를 원문 하나만큼만
// 쓴다). 다시 열면 할 일이 없다 (멱등)
export function backfillEvidence(db: Db): number {
  const ids = all<{ id: number }>(db, `
    SELECT v.id FROM schema_versions v LEFT JOIN schema_version_evidence e ON e.version_id = v.id
     WHERE e.version_id IS NULL OR e.judged_by = 'v6' OR e.judge_rev < ? ORDER BY v.id`, JUDGE_REV).map((r) => Number(r.id));
  for (const id of ids) tx(db, () => judgeVersion(db, id));
  return ids.length;
}

function judgeVersion(db: Db, versionId: number): void {
  const src = one<{ source_format: SourceFormat; source_text: unknown }>(db, `
    SELECT v.source_format, s.source_text FROM schema_versions v LEFT JOIN schema_version_sources s ON s.version_id = v.id WHERE v.id = ?`, versionId);
  // 원문이 없거나 문자열이 아니면(읽을 수 없는 원문) 006 의 불완전 표시는 그대로 두고 그 밖은 unknown 으로, 저장 모델은 stale 로 본다
  if (typeof src?.source_text !== 'string') {
    const kept = loadEvidence(db, versionId);
    saveEvidence(db, versionId, kept?.level === 'incomplete' ? kept : NO_SOURCE, 'backfill', NO_SOURCE_STALE_REASON);
    return;
  }
  const parsed = reparse(src.source_format, src.source_text);
  if ('error' in parsed) {
    saveEvidence(db, versionId, { level: 'incomplete', reason: `원문을 다시 판정하지 못했습니다: ${parsed.error}`, objects: [] }, 'backfill', UNPARSABLE_REASON);
    return;
  }
  const stored = storedModel(db, versionId);
  if (!stored) {
    saveEvidence(db, versionId, parsed.model.evidence ?? NO_SOURCE, 'backfill', BROKEN_MODEL_REASON);
    return;
  }
  // 저장 모델과 다시 파싱한 모델을 객체 순서와 무관한 modelHash 로 비교한다 (같은 원문 재업로드의 duplicate 판정과 같은 기준)
  const staleReason = modelHash(parsed.model) === modelHash(stored) ? null : STALE_MODEL_REASON;
  const derivation = loadDerivation(db, versionId);
  if (derivation) {
    // ALTER 적용 버전: 원문(출력한 덤프)에는 늘 헤더·트레일러가 있어 원문 판정은 항상 complete 다 — 기준 버전의 판정을 물려받는다.
    // 기준이 stale 이면 이 버전도 stale 이다 (기준 모델에 스크립트를 적용했으므로). 기준이 지워졌으면 저장된 판정을 유지한다.
    // 기준은 id 가 더 작아 먼저 판정된다
    const baseId = derivation.baseVersionId;
    const inherited = (baseId === null ? loadEvidence(db, versionId) : loadEvidence(db, baseId)) ?? NO_SOURCE;
    const baseStale = baseId === null ? undefined : loadStaleReason(db, baseId);
    // 기준이 지워졌으면 이미 붙은 사유를 이어받는다 — 풀릴 근거(기준의 재판정)가 사라졌으니 보수적으로 둔다
    const kept = baseId === null ? loadStaleReason(db, versionId) : undefined;
    saveEvidence(db, versionId, inherited, 'backfill', staleReason ?? kept ?? (baseStale ? `기준 버전 v${derivation.baseVersionNo} 이 ${STALE_MODEL_REASON}` : null));
    return;
  }
  saveEvidence(db, versionId, parsed.model.evidence ?? NO_SOURCE, 'backfill', staleReason);
}

// 저장 모델. JSON 이 손상돼 읽을 수 없으면 로그를 남기고 undefined (기동 중단 방지, 17회차 6)
function storedModel(db: Db, versionId: number): SchemaModel | undefined {
  try {
    return loadVersion(db, versionId).model;
  } catch (e) {
    console.warn(`버전 ${versionId} 의 저장 모델을 읽지 못해 stale 로 표시합니다:`, e instanceof Error ? e.message : e);
    return undefined;
  }
}

// 파싱이 예외로 끝나는 원문(지금 규칙으로 읽을 수 없는 옛 원문)은 불완전이고 저장 모델도 확인할 수 없다 (안전 쪽)
function reparse(format: SourceFormat, text: string): { model: SchemaModel } | { error: string } {
  try {
    return { model: parseSource(format, text).model };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
