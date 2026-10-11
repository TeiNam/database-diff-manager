// TARGET 완전성 증거 저장·재판정 (15회차 1): 007 이전에 올린 버전은 기동 시 원문으로 다시 판정한다
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffSchemas, generateDdl, type SchemaModel } from '@tdm/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { all, migrate, one, openDb, run, type Db } from '../src/db/connection';
import { createUser } from '../src/repos/users';
import { listVersions, loadVersion } from '../src/repos/versions';
import { backfillEvidence } from '../src/services/evidence-backfill';
import { ingest } from '../src/services/ingest';

const fixture = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../packages/core/test/fixtures/${rel}`, import.meta.url)), 'utf8');
const SAMPLE_0130 = fixture('td-export-0130/sample-app.sql');
const SAMPLE_0115 = fixture('td-export-0115/sample-app.sql');
const SHOP_0152 = fixture('td-export-0152/shop.sql');
const SHOP_NO_VIEW = SHOP_0152.replace(/\/\* Table : big_paid \*\/\n[^\n]+\n/, '');
const DESTRUCTIVE = /\bDROP\s+(TABLE|VIEW|FUNCTION|PROCEDURE|COLUMN|PARTITION)\b/i;
const runnableDrops = (base: SchemaModel, target: SchemaModel) =>
  generateDdl(diffSchemas(base, target)).filter((s) => !s.comment && DESTRUCTIVE.test(s.sql)).map((s) => s.sql);
const evidenceRows = (db: Db) => all<{ version_id: number; level: string; judged_by: string }>(db, 'SELECT version_id, level, judged_by FROM schema_version_evidence ORDER BY version_id');

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tdm-evidence-'));
  path = join(dir, 'tdm.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// 지금 앱으로 올린 뒤 증거 표를 지우고 user_version 을 5 로 내려, 006 이전 앱이 남긴 DB 처럼 만든다
function v5Db(uploads: { schema: string; text: string }[]): number[] {
  const db = openDb(path);
  const userId = createUser(db, { username: 'admin', passwordHash: 'h', role: 'admin' }).id;
  const ids = uploads.map(({ schema, text }) => {
    const r = ingest(db, { databaseName: 'db', schemaName: schema, filename: `${schema}.sql`, text, userId });
    return r.versionId;
  });
  db.exec('DROP TABLE schema_version_evidence; PRAGMA user_version = 5');
  db.close();
  return ids;
}

describe('기동 시 재판정 (006 이전 버전)', () => {
  it('v5 DB 의 잘린 0.1.30·0.1.15·완전 0.1.52 를 원문으로 판정하고, 판정대로 DROP 을 막거나 실행한다', () => {
    const cut = SAMPLE_0130.slice(0, SAMPLE_0130.indexOf('CREATE TABLE `chat_history`') + 80);
    const [full0130, cut0130, v0115, shop, shopNoView] = v5Db([
      { schema: 'sample-app', text: SAMPLE_0130 }, { schema: 'sample-app', text: cut }, { schema: 'sample-app', text: SAMPLE_0115 },
      { schema: 'shop', text: SHOP_0152 }, { schema: 'shop', text: SHOP_NO_VIEW },
    ]);
    const db = openDb(path);
    expect(one<{ user_version: number }>(db, 'PRAGMA user_version')!.user_version).toBe(8);
    expect(evidenceRows(db)).toEqual([
      { version_id: full0130, level: 'complete', judged_by: 'backfill' },
      { version_id: cut0130, level: 'incomplete', judged_by: 'backfill' },
      { version_id: v0115, level: 'unknown', judged_by: 'backfill' },
      { version_id: shop, level: 'complete', judged_by: 'backfill' },
      { version_id: shopNoView, level: 'complete', judged_by: 'backfill' },
    ]);
    const model = (id: number) => loadVersion(db, id).model;
    expect(model(cut0130).evidence).toMatchObject({ level: 'incomplete', objects: ['chat_history'] });
    expect(runnableDrops(model(full0130), model(cut0130))).toEqual([]);
    expect(runnableDrops(model(shop), model(shopNoView))).toEqual(['DROP VIEW `big_paid`']);
    // 0.1.15 TARGET: 0.1.30 에만 있는 객체가 없어도 DROP 은 실행 문장이 아니다
    const fewer = { ...model(v0115), tables: model(v0115).tables.slice(1) };
    expect(runnableDrops(model(full0130), fewer)).toEqual([]);
    db.close();
  });

  it('멱등: 다시 열면 다시 판정하지 않고, 판정이 있는 버전은 건드리지 않는다', () => {
    v5Db([{ schema: 'shop', text: SHOP_0152 }]);
    openDb(path).close();
    const db = openDb(path);
    expect(backfillEvidence(db)).toBe(0);
    expect(evidenceRows(db)).toHaveLength(1);
    db.close();
  });

  it('원문이 없는 버전은 unknown, 006 의 불완전 표시는 원문으로 다시 판정한다 (원문이 없으면 유지)', () => {
    const [a, b, c] = v5Db([{ schema: 'shop', text: SHOP_0152 }, { schema: 'shop', text: SHOP_NO_VIEW }, { schema: 'x', text: SHOP_0152 }]);
    // 006 까지만 올린 상태(옛 앱)에서 b·c 에 불완전 표시를 남기고, a·c 의 원문을 지운다
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, 6);
    run(db, 'INSERT INTO schema_version_incomplete (version_id, incomplete_json) VALUES (?, ?), (?, ?)', b, '{"reason":"옛 판정","objects":[]}', c, '{"reason":"옛 판정","objects":["orders"]}');
    run(db, 'DELETE FROM schema_version_sources WHERE version_id IN (?, ?)', a, c);
    db.close();
    const reopened = openDb(path);
    expect(evidenceRows(reopened)).toEqual([
      { version_id: a, level: 'unknown', judged_by: 'backfill' },
      { version_id: b, level: 'complete', judged_by: 'backfill' },
      { version_id: c, level: 'incomplete', judged_by: 'backfill' },
    ]);
    expect(loadVersion(reopened, c).model.evidence).toEqual({ level: 'incomplete', reason: '옛 판정', objects: ['orders'] });
    expect(listVersions(reopened, 1)).toHaveLength(2);
    reopened.close();
  });
});
