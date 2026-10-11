import type { SchemaEvidence, SourceFormat } from '@tdm/core';
import { all, one, run, tx, type Db } from '../db/connection';
import { saveEvidence } from '../repos/evidence';
import { parseSource } from './ingest';

// 원문이 없는 버전: 증거가 없으므로 unknown (TARGET 이면 삭제 문장은 수동 확인)
const NO_SOURCE: SchemaEvidence = { level: 'unknown', reason: '원문이 없어 완전성을 판정할 수 없습니다', objects: [] };

// 마이그레이션 직후 JS 단계 (15회차 1): 판정이 없거나(006 이전 버전) 006 의 표시를 옮긴 버전을 원문으로 다시 판정한다.
// 버전 하나씩 원문 하나만 읽어 한 트랜잭션으로 저장한다 (대용량 DB 도 메모리를 원문 하나만큼만 쓴다). 다시 열면 할 일이 없다 (멱등)
export function backfillEvidence(db: Db): number {
  const ids = all<{ id: number }>(db, `
    SELECT v.id FROM schema_versions v LEFT JOIN schema_version_evidence e ON e.version_id = v.id
     WHERE e.version_id IS NULL OR e.judged_by = 'v6' ORDER BY v.id`).map((r) => Number(r.id));
  for (const id of ids) tx(db, () => judgeVersion(db, id));
  return ids.length;
}

function judgeVersion(db: Db, versionId: number): void {
  const src = one<{ source_format: SourceFormat; source_text: string }>(db, `
    SELECT v.source_format, s.source_text FROM schema_versions v JOIN schema_version_sources s ON s.version_id = v.id WHERE v.id = ?`, versionId);
  if (src) {
    saveEvidence(db, versionId, judge(src.source_format, src.source_text), 'backfill');
    return;
  }
  // 원문이 없으면 006 의 불완전 표시는 그대로 두고(출처만 바꿔 다시 고르지 않는다), 판정이 없으면 unknown
  const moved = run(db, "UPDATE schema_version_evidence SET judged_by = 'backfill' WHERE version_id = ?", versionId).changes;
  if (!moved) saveEvidence(db, versionId, NO_SOURCE, 'backfill');
}

// 파싱이 예외로 끝나는 원문(지금 규칙으로 읽을 수 없는 옛 원문)은 불완전으로 본다 (안전 쪽)
function judge(format: SourceFormat, text: string): SchemaEvidence {
  try {
    return parseSource(format, text).model.evidence ?? NO_SOURCE;
  } catch (e) {
    return { level: 'incomplete', reason: `원문을 다시 판정하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, objects: [] };
  }
}
