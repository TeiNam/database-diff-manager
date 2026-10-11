// 예전 파서로 저장된 모델의 재판정 (16회차 2): 기동 시 원문을 지금 파서로 다시 파싱한 모델과 저장 모델이 다르면 그 버전을
// stale-model 로 표시하고, 그 버전이 BASE·TARGET 인 diff 의 실행 문장을 모두 수동 확인으로 돌린다
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, migrate, one, openDb, run, type Db } from '../src/db/connection';
import { createUser } from '../src/repos/users';
import { loadVersion } from '../src/repos/versions';
import { AppCache } from '../src/services/cache';
import { computeDiff } from '../src/services/diff-service';
import { backfillEvidence } from '../src/services/evidence-backfill';
import { ingest } from '../src/services/ingest';

const fixture = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../packages/core/test/fixtures/${rel}`, import.meta.url)), 'utf8');
// 공백이 든 테이블명 `Order Items`: td-export 0.1.52 이전 앱(bb5a7fb 등)의 MD 파서는 앵커를 따라 `order items` 로 저장했다
const ESCAPES_MD = fixture('td-export-0152/escapes.md');
const SHOP_SQL = fixture('td-export-0152/shop.sql');

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tdm-stale-'));
  path = join(dir, 'tdm.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// 저장 모델을 옛 파서 결과 모양으로 바꾼다 (객체 이름·리비전 JSON). model_hash 는 그대로 둬 같은 원문 재업로드가 duplicate 로
// 잘못 합쳐지지 않는지도 본다
function toOldModel(db: Db): void {
  run(db, "UPDATE objects SET name = 'order items' WHERE name = 'Order Items'");
  run(db, `UPDATE object_revisions SET model_json = replace(model_json, '"name":"Order Items"', '"name":"order items"')`);
}

// 지금 앱으로 올린 뒤 저장 모델을 옛 모양으로 바꾸고 v6 DB(판정은 006 의 불완전 표시뿐)로 되돌린다
function v6Db(uploads: { schema: string; filename: string; text: string }[]): number[] {
  const db = openDb(path);
  const userId = createUser(db, { username: 'admin', passwordHash: 'h', role: 'admin' }).id;
  const ids = uploads.map((u) => ingest(db, { databaseName: 'db', schemaName: u.schema, filename: u.filename, text: u.text, userId }).versionId);
  toOldModel(db);
  db.exec('DROP TABLE schema_version_evidence; PRAGMA user_version = 5');
  db.close();
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON');
  migrate(raw, 6);
  raw.close();
  return ids;
}

const staleRows = (db: Db) => all<{ version_id: number; stale: number }>(db,
  'SELECT version_id, stale_reason IS NOT NULL AS stale FROM schema_version_evidence ORDER BY version_id').map((r) => [Number(r.version_id), Number(r.stale)]);
const runnable = (db: Db, base: number, target: number) => computeDiff(db, new AppCache(), base, target).statements.filter((s) => !s.comment).map((s) => s.sql);

describe('예전 파서로 저장된 모델 (stale-model)', () => {
  it('v6 → 최신 업그레이드: 원문을 다시 파싱한 모델과 다르면 stale 로 표시하고, 같은 원문 재업로드와의 diff 는 실행 문장 0', () => {
    const [old, shop] = v6Db([{ schema: 'tdm_md', filename: 'escapes.md', text: ESCAPES_MD }, { schema: 'shop', filename: 'shop.sql', text: SHOP_SQL }]);
    const db = openDb(path);
    expect(staleRows(db)).toEqual([[old, 1], [shop, 0]]);
    expect(loadVersion(db, old).staleReason).toContain('예전 파서');
    expect(loadVersion(db, shop).staleReason).toBeUndefined();
    // 같은 원문을 다시 올리면 지금 파서 모델로 새 버전이 된다 (stale 버전과 duplicate 로 합치지 않는다)
    const again = ingest(db, { databaseName: 'db', schemaName: 'tdm_md', filename: 'escapes.md', text: ESCAPES_MD, userId: 1 });
    expect(again.status).toBe('ok');
    expect(loadVersion(db, again.versionId).staleReason).toBeUndefined();
    // 판정을 고치기 전: 역방향(새 → stale) 비교에서 CREATE `order items`·DROP `Order Items` 가 실행 문장이었다
    for (const [base, target] of [[again.versionId, old], [old, again.versionId]]) {
      const res = computeDiff(db, new AppCache(), base, target);
      expect(res.statements.length, `${base}→${target}`).toBeGreaterThan(0);
      expect(runnable(db, base, target), `${base}→${target}`).toEqual([]);
      expect(res.statements.every((s) => s.staleHold)).toBe(true);
      expect(res.staleModels.map((m) => m.versionId)).toEqual([old]);
      expect(res.ddl).toContain('예전 파서');
    }
    db.close();
  });

  it('이미 v7 로 올린 DB(15회차 재판정이 stale 모델을 complete 로 올린 DB)도 다시 판정한다 — 다시 열면 할 일이 없다', () => {
    const db0 = openDb(path);
    const userId = createUser(db0, { username: 'admin', passwordHash: 'h', role: 'admin' }).id;
    const { versionId } = ingest(db0, { databaseName: 'db', schemaName: 'tdm_md', filename: 'escapes.md', text: ESCAPES_MD, userId });
    toOldModel(db0);
    db0.exec("UPDATE schema_version_evidence SET judged_by = 'backfill'; ALTER TABLE schema_version_evidence DROP COLUMN judge_rev; ALTER TABLE schema_version_evidence DROP COLUMN stale_reason; PRAGMA user_version = 7");
    db0.close();
    const db = openDb(path);
    expect(staleRows(db)).toEqual([[versionId, 1]]);
    expect(backfillEvidence(db)).toBe(0);
    db.close();
  });

  it('지금 앱으로 올린 버전은 stale 이 아니고 다시 판정하지 않는다', () => {
    const db0 = openDb(path);
    const userId = createUser(db0, { username: 'admin', passwordHash: 'h', role: 'admin' }).id;
    const a = ingest(db0, { databaseName: 'db', schemaName: 'shop', filename: 'shop.sql', text: SHOP_SQL, userId }).versionId;
    const b = ingest(db0, { databaseName: 'db', schemaName: 'shop', filename: 'shop.sql', text: SHOP_SQL.replace(/\/\* Table : big_paid \*\/\n[^\n]+\n/, ''), userId }).versionId;
    db0.close();
    const db = openDb(path);
    expect(backfillEvidence(db)).toBe(0);
    expect(staleRows(db)).toEqual([[a, 0], [b, 0]]);
    const res = computeDiff(db, new AppCache(), a, b);
    expect(res.staleModels).toEqual([]);
    expect(runnable(db, a, b)).toEqual(['DROP VIEW `big_paid`']);
    expect(one<{ n: number }>(db, 'SELECT count(*) AS n FROM schema_version_evidence WHERE judge_rev < 1')!.n).toBe(0);
    db.close();
  });
});
