-- 스키마 v8: 버전 판정의 규칙 판(judge_rev)과 예전 파서로 저장된 모델 표시(stale_reason, 16회차 2).
-- judge_rev 가 지금 판(JS 의 JUDGE_REV)보다 낮은 버전은 기동 시 원문으로 다시 판정한다 — 기존 행은 0 이라 모두 한 번 다시 판정한다
-- (15회차 재판정은 저장 모델이 원문과 다른 버전도 complete 로 올렸다). stale_reason: 원문을 지금 파서로 다시 파싱한 모델이 저장
-- 모델과 다르면 그 사유(NULL 이면 같음). 그 버전이 BASE·TARGET 인 diff 의 실행 문장은 모두 수동 확인이다
ALTER TABLE schema_version_evidence ADD COLUMN judge_rev INTEGER NOT NULL DEFAULT 0 CHECK (judge_rev >= 0);
ALTER TABLE schema_version_evidence ADD COLUMN stale_reason TEXT CHECK (stale_reason IS NULL OR length(stale_reason) > 0);
