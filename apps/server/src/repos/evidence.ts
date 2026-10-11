import type { EvidenceLevel, SchemaEvidence } from '@tdm/core';
import { one, run, type Db } from '../db/connection';

// 판정 출처: ingest(업로드 때), backfill(기동 시 원문으로 다시 판정), v6(006 의 불완전 표시를 옮긴 것 — 다시 판정할 대상)
export type JudgedBy = 'ingest' | 'backfill' | 'v6';
// 판정 규칙 판 (v8). 파서·완전성 판정이 바뀌어 저장된 판정·모델을 원문으로 다시 확인해야 할 때 올린다 — 낮은 판의 버전은 기동 시
// 다시 판정한다. 1: 16회차 (MD 끝 표식 없는 마지막 섹션은 unknown, 저장 모델과 원문 재파싱 모델 비교)
// 2: 17회차 (원문 없는 버전·저장 모델 JSON 손상 버전도 stale). 파서·완전성 판정 결과가 바뀌면 test/judge-rev.test.ts 의 스냅샷
// 검사가 실패한다 — 이 판을 올리고 스냅샷을 다시 만든다 (17회차 5)
export const JUDGE_REV = 2;

const LEVELS: ReadonlySet<string> = new Set<EvidenceLevel>(['complete', 'incomplete', 'unknown']);
const UNREADABLE: SchemaEvidence = { level: 'incomplete', reason: '저장된 완전성 판정을 읽지 못했습니다', objects: [] };

// 저장 형식 (키 순서 고정 — 같은 판정은 같은 문자열이라 duplicate 판정에 쓴다)
export function evidenceJson(e: SchemaEvidence): string {
  return JSON.stringify({ level: e.level, ...(e.reason === undefined ? {} : { reason: e.reason }), objects: e.objects });
}

// 저장된 판정. 형식이 어긋나면 불완전으로 본다 (안전 쪽). 행이 없으면 undefined — diff 는 unknown 으로 본다
export function loadEvidence(db: Db, versionId: number): SchemaEvidence | undefined {
  const row = one<{ evidence_json: string }>(db, 'SELECT evidence_json FROM schema_version_evidence WHERE version_id = ?', versionId);
  if (!row) return undefined;
  try {
    const v = JSON.parse(row.evidence_json) as Partial<SchemaEvidence>;
    if (typeof v.level !== 'string' || !LEVELS.has(v.level)) return UNREADABLE;
    const objects = Array.isArray(v.objects) ? v.objects.filter((o): o is string => typeof o === 'string') : [];
    return { level: v.level, ...(typeof v.reason === 'string' ? { reason: v.reason } : {}), objects };
  } catch {
    return UNREADABLE;
  }
}

export const storedEvidenceJson = (db: Db, versionId: number): string | null =>
  one<{ evidence_json: string }>(db, 'SELECT evidence_json FROM schema_version_evidence WHERE version_id = ?', versionId)?.evidence_json ?? null;

// staleReason: 저장 모델이 원문을 지금 파서로 다시 파싱한 모델과 다를 때의 사유 (업로드 때는 항상 같아 null)
export function saveEvidence(db: Db, versionId: number, e: SchemaEvidence, judgedBy: JudgedBy, staleReason: string | null = null): void {
  run(db, `INSERT INTO schema_version_evidence (version_id, level, evidence_json, judged_by, judge_rev, stale_reason) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (version_id) DO UPDATE SET level = excluded.level, evidence_json = excluded.evidence_json, judged_by = excluded.judged_by,
             judge_rev = excluded.judge_rev, stale_reason = excluded.stale_reason`,
    versionId, e.level, evidenceJson(e), judgedBy, JUDGE_REV, staleReason);
}

// 예전 파서로 저장된 모델이면 그 사유 (16회차 2)
export const loadStaleReason = (db: Db, versionId: number): string | undefined =>
  one<{ stale_reason: string | null }>(db, 'SELECT stale_reason FROM schema_version_evidence WHERE version_id = ?', versionId)?.stale_reason ?? undefined;
