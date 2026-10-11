import type { SchemaEvidence, SchemaModel, SourceFormat } from '@tdm/core';
import { all, one, run, tx, type Db } from '../db/connection';
import { JUDGE_REV, saveEvidence } from '../repos/evidence';
import { loadVersion } from '../repos/versions';
import { modelHash, parseSource } from './ingest';

// 원문이 없는 버전: 증거가 없으므로 unknown (TARGET 이면 삭제 문장은 수동 확인)
const NO_SOURCE: SchemaEvidence = { level: 'unknown', reason: '원문이 없어 완전성을 판정할 수 없습니다', objects: [] };
// 저장 모델이 원문을 지금 파서로 다시 파싱한 모델과 다른 버전 (16회차 2). 화면·DDL 에 같은 문구로 보인다
export const STALE_MODEL_REASON = '예전 파서로 저장된 모델입니다 — 원문을 지금 파서로 다시 읽은 모델과 달라 이 버전이 낀 비교의 문장을 실행하지 않습니다. 같은 원문을 다시 올려 새 버전으로 비교하세요';
const UNPARSABLE_REASON = '원문을 지금 파서로 다시 읽지 못해 예전 파서로 저장된 모델을 확인할 수 없습니다 — 이 버전이 낀 비교의 문장을 실행하지 않습니다';

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
  const src = one<{ source_format: SourceFormat; source_text: string }>(db, `
    SELECT v.source_format, s.source_text FROM schema_versions v JOIN schema_version_sources s ON s.version_id = v.id WHERE v.id = ?`, versionId);
  if (src) {
    const parsed = reparse(src.source_format, src.source_text);
    if ('error' in parsed) {
      saveEvidence(db, versionId, { level: 'incomplete', reason: `원문을 다시 판정하지 못했습니다: ${parsed.error}`, objects: [] }, 'backfill', UNPARSABLE_REASON);
      return;
    }
    // 저장 모델과 다시 파싱한 모델을 객체 순서와 무관한 modelHash 로 비교한다 (같은 원문 재업로드의 duplicate 판정과 같은 기준)
    const staleReason = modelHash(parsed.model) === modelHash(loadVersion(db, versionId).model) ? null : STALE_MODEL_REASON;
    saveEvidence(db, versionId, parsed.model.evidence ?? NO_SOURCE, 'backfill', staleReason);
    return;
  }
  // 원문이 없으면 006 의 불완전 표시는 그대로 두고(출처만 바꿔 다시 고르지 않는다), 판정이 없으면 unknown.
  // 저장 모델을 확인할 원문이 없으니 stale 표시는 바꾸지 않는다
  const moved = run(db, "UPDATE schema_version_evidence SET judged_by = 'backfill', judge_rev = ? WHERE version_id = ?", JUDGE_REV, versionId).changes;
  if (!moved) saveEvidence(db, versionId, NO_SOURCE, 'backfill');
}

// 파싱이 예외로 끝나는 원문(지금 규칙으로 읽을 수 없는 옛 원문)은 불완전이고 저장 모델도 확인할 수 없다 (안전 쪽)
function reparse(format: SourceFormat, text: string): { model: SchemaModel } | { error: string } {
  try {
    return { model: parseSource(format, text).model };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
