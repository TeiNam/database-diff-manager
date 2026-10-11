import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalJson, diffSchemas, parseSqlDump } from '@tdm/core';
import { describe, expect, it } from 'vitest';
import { all, migrate, one, openDb, run, type Db } from '../src/db/connection';
import { objectHistory } from '../src/repos/objects';
import { createUser } from '../src/repos/users';
import { listVersions, loadVersion } from '../src/repos/versions';
import { ingest, modelHash } from '../src/services/ingest';
import { loggedInApp, multipart, SAMPLE_SQL, sampleText } from './helpers';

// td-export 0.1.52 실제 출력 (함수 tax, 프로시저 mark_paid)
const shop = (ext: 'sql' | 'md') => readFileSync(fileURLToPath(new URL(`../../../packages/core/test/fixtures/td-export-0152/shop.${ext}`, import.meta.url)), 'utf8');
const SHOP = shop('sql');
const SHOP_MD = shop('md');
const SHOP_V2 = SHOP.replace('RETURN a * 0.1;', 'RETURN a * 0.08;');
const userVersion = (db: Db) => one<{ user_version: number }>(db, 'PRAGMA user_version')!.user_version;
const snapshot = (db: Db) => ({
  objects: all(db, 'SELECT * FROM objects ORDER BY id'),
  revisions: all(db, 'SELECT * FROM object_revisions ORDER BY id'),
  links: all(db, 'SELECT * FROM version_objects ORDER BY version_id, object_id'),
});

describe('마이그레이션 004 (objects.kind 에 function·procedure 추가)', () => {
  it('데이터가 있는 v3 DB 를 올려도 객체·리비전·스냅샷을 보존하고 FK·STRICT·UNIQUE 를 유지한다', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, 3);
    const userId = createUser(db, { username: 'admin', passwordHash: 'h', role: 'admin' }).id;
    ingest(db, { databaseName: 'db', schemaName: 'app', filename: 'a.sql', text: sampleText(SAMPLE_SQL), userId });
    const before = snapshot(db);
    expect(() => run(db, "INSERT INTO objects (schema_id, kind, name) VALUES (1, 'function', 'f')")).toThrow(/CHECK/);

    migrate(db);
    expect(userVersion(db)).toBe(4);
    expect(snapshot(db)).toEqual(before);
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys')!.foreign_keys).toBe(1);
    const sql = one<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE name = 'objects'")!.sql;
    expect(sql).toMatch(/\)\s*STRICT$/);
    run(db, "INSERT INTO objects (schema_id, kind, name) VALUES (1, 'function', 'f'), (1, 'procedure', 'f')");
    expect(() => run(db, "INSERT INTO objects (schema_id, kind, name) VALUES (1, 'trigger', 't')")).toThrow(/CHECK/);
    expect(() => run(db, "INSERT INTO objects (schema_id, kind, name) VALUES (1, 'function', 'f')")).toThrow(/UNIQUE/);
    expect(() => run(db, "INSERT INTO objects (schema_id, kind, name) VALUES (999, 'function', 'g')")).toThrow(/FOREIGN KEY/);
    // 다른 테이블의 objects 참조(FK)가 새 테이블을 가리킨다
    expect(() => run(db, "INSERT INTO object_revisions (object_id, revision_no, content_hash, fidelity, model_json) VALUES (9999, 1, 'h', 'full', '{}')")).toThrow(/FOREIGN KEY/);
  });
});

function freshDb() {
  const db = openDb(':memory:');
  const userId = createUser(db, { username: 'admin', passwordHash: 'h', role: 'admin' }).id;
  const up = (text: string, filename = 'shop.sql') => ingest(db, { databaseName: 'db', schemaName: 'shop', filename, text, userId });
  return { db, up };
}

describe('ingest: 루틴', () => {
  it('루틴도 객체·리비전으로 저장하고 버전을 불러오면 model.routines 로 돌아온다', () => {
    const { db, up } = freshDb();
    const r = up(SHOP);
    expect(r).toMatchObject({ status: 'ok', warnings: [] });
    const detail = loadVersion(db, r.versionId);
    expect(detail.model.routines.map((x) => [x.kind, x.name])).toEqual([['function', 'tax'], ['procedure', 'mark_paid']]);
    expect(detail.model.routinesUnknown).toBeUndefined();
    expect(detail.objects.filter((o) => o.kind === 'function' || o.kind === 'procedure').map((o) => [o.kind, o.name])).toEqual([['function', 'tax'], ['procedure', 'mark_paid']]);
  });

  it('같은 내용은 duplicate, 루틴만 바뀌면 그 루틴만 새 리비전이고 변경 객체 수·이력에 포함된다', () => {
    const { db, up } = freshDb();
    up(SHOP);
    expect(up(SHOP).status).toBe('duplicate');
    const v2 = up(SHOP_V2);
    expect(v2.status).toBe('ok');
    expect(listVersions(db, 1).map((v) => v.changedObjects)).toEqual([1, 6]);
    const tax = loadVersion(db, v2.versionId).objects.find((o) => o.kind === 'function')!;
    expect(objectHistory(db, tax.objectId).revisions.map((x) => x.revisionNo)).toEqual([1, 2]);
  });

  it('이름이 대소문자만 다른 루틴은 같은 객체로 본다', () => {
    const { db, up } = freshDb();
    up(SHOP);
    up(SHOP_V2.replace('FUNCTION `tax`', 'FUNCTION `TAX`'));
    expect(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM objects WHERE kind = 'function'")!.n).toBe(1);
  });

  it('MD 버전이 끼면 그 쌍의 변경 객체 수에서 루틴을 뺀다 (MD 에는 루틴이 없다)', () => {
    const { db, up } = freshDb();
    up(SHOP);
    up(SHOP_MD, 'shop.md');
    up(SHOP);
    // SQL→MD: 테이블 2개가 partial 로 바뀜(뷰는 원문이 같고, 루틴 2개는 세지 않음), MD→SQL: 다시 2개
    expect(listVersions(db, 1).map((v) => v.changedObjects)).toEqual([2, 2, 6]);
  });

  it('비ASCII 이름도 core 와 같은 규칙(대소문자 무시)으로 같은 객체로 본다', () => {
    const { db, up } = freshDb();
    up(SHOP.replace('FUNCTION `tax`', 'FUNCTION `Ä`'));
    up(SHOP_V2.replace('FUNCTION `tax`', 'FUNCTION `ä`'));
    expect(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM objects WHERE kind = 'function'")!.n).toBe(1);
    expect(listVersions(db, 1)[0].changedObjects).toBe(1);
  });

  it('같은 내용이라도 루틴을 아는 SQL 버전과 모르는 MD 버전은 duplicate 로 합치지 않는다', () => {
    const { db, up } = freshDb();
    // 뷰만 있는 정의: MD 와 SQL 의 모델 해시가 같다
    const viewSql = '/* Database : shop */\n' + SHOP.slice(SHOP.indexOf('/* Table : big_paid */'), SHOP.indexOf('SET FOREIGN_KEY_CHECKS = @OLD'));
    const viewMd = SHOP_MD.slice(0, SHOP_MD.indexOf('## order_audit'));
    const sqlFirst = up(viewSql);
    const md = up(viewMd, 'shop.md');
    expect(md.status).toBe('ok');
    expect(loadVersion(db, md.versionId).model.routinesUnknown).toBe(true);
    const withFn = up(SHOP);
    expect(diffSchemas(loadVersion(db, withFn.versionId).model, loadVersion(db, md.versionId).model)).toMatchObject({ routines: [], routinesUnknown: true });
    // MD 를 같은 MD 로 다시 올리면 duplicate 그대로
    expect(up(viewMd, 'shop.md').status).toBe('ok');
    expect(up(viewMd, 'shop.md').status).toBe('duplicate');
    expect(sqlFirst.status).toBe('ok');
  });

  it('루틴이 없는 모델의 해시는 루틴 지원 전과 같다 (기존 버전과 duplicate 판정 유지)', () => {
    const model = parseSqlDump(sampleText(SAMPLE_SQL)).model;
    const sort = <T extends { name: string }>(xs: T[]) => [...xs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const legacy = createHash('sha256').update(canonicalJson({ tables: sort(model.tables), views: sort(model.views) })).digest('hex');
    expect(modelHash(model)).toBe(legacy);
  });
});

type App = Awaited<ReturnType<typeof loggedInApp>>;

async function upload(ctx: App, filename: string, content: string, schemaName = 'shop'): Promise<{ versionId: number; warnings: unknown[] }> {
  const body = multipart({ meta: JSON.stringify([{ filename, databaseName: '127.0.0.1', schemaName }]) }, [{ filename, content }]);
  const res = await ctx.app.inject({ method: 'POST', url: '/api/uploads', headers: { ...ctx.admin, ...body.headers }, payload: body.payload });
  expect(res.statusCode).toBe(200);
  return res.json().results[0];
}

describe('업로드·diff API: 루틴', () => {
  it('td-export 0.1.52 샘플을 업로드하면 경고 없이 저장되고, diff·DDL 응답에 루틴이 들어간다', async () => {
    const ctx = await loggedInApp();
    const v1 = await upload(ctx, 'shop(127.0.0.1_33099).sql', SHOP);
    expect(v1.warnings).toEqual([]);
    const v2 = await upload(ctx, 'shop(127.0.0.1_33099).sql', SHOP_V2);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${v1.versionId}&target=${v2.versionId}`, headers: ctx.viewer });
    const body = res.json();
    expect(body.targetModel.routines).toHaveLength(2);
    expect(body.diff.routinesUnknown).toBe(false);
    expect(body.diff.routines.map((r: { op: string; kind: string; name: string; fields: string[] }) => [r.op, r.kind, r.name, r.fields])).toEqual([['modify', 'function', 'tax', ['body']]]);
    expect(body.statements.map((s: { kind: string; object: string }) => `${s.kind}:${s.object}`)).toEqual(['function:tax', 'function:tax']);
    expect(body.ddl).toContain('DELIMITER ;;\nCREATE FUNCTION `tax`(a decimal(10,2)) RETURNS decimal(10,2)');
    expect(body.ddl).not.toContain('DELIMITER ;;;');
  });

  it('MD 버전과 비교하면 루틴은 routinesUnknown 으로 비교하지 않는다', async () => {
    const ctx = await loggedInApp();
    const sql = await upload(ctx, 'shop.sql', SHOP);
    const md = await upload(ctx, 'shop.md', SHOP_MD);
    const body = (await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${sql.versionId}&target=${md.versionId}`, headers: ctx.viewer })).json();
    expect(body.diff.routinesUnknown).toBe(true);
    expect(body.diff.routines).toEqual([]);
    expect(body.targetModel.routinesUnknown).toBe(true);
    expect(body.statements.some((s: { kind: string }) => s.kind === 'function' || s.kind === 'procedure')).toBe(false);
  });
});
