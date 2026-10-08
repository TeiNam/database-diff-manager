import { describe, expect, it } from 'vitest';
import { one } from '../src/db/connection';
import { getVersionMeta } from '../src/repos/versions';
import { ingest } from '../src/services/ingest';
import { dmsFixture, loggedInApp } from './helpers';

type App = Awaited<ReturnType<typeof loggedInApp>>;

// As-Is(legacy)·To-Be(newapp) 버전을 하나씩 올리고 버전·Schema id 를 돌려준다
async function setup() {
  const ctx = await loggedInApp();
  const put = (schemaName: string, file: 'as-is.sql' | 'to-be.sql') => {
    const r = ingest(ctx.db, { databaseName: 'db', schemaName, filename: file, text: dmsFixture(file), userId: 1 });
    return { versionId: r.versionId, schemaId: getVersionMeta(ctx.db, r.versionId).schemaId };
  };
  return { ...ctx, asIs: put('legacy', 'as-is.sql'), toBe: put('newapp', 'to-be.sql') };
}

const post = (ctx: App, headers: Record<string, string>, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/api/migrations', headers, payload });
const body = (s: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}) =>
  ({ fromSchemaId: s.asIs.schemaId, toSchemaId: s.toBe.schemaId, filename: 'mapping.json', source: dmsFixture('mapping.json'), ...extra });

describe('POST /api/migrations', () => {
  it('admin 만 올리고, 같은 쌍에 다시 올리면 리비전이 늘며, 경고를 돌려준다', async () => {
    const s = await setup();
    expect((await post(s, s.viewer, body(s))).statusCode).toBe(403);
    const first = await post(s, s.admin, body(s, { note: '1차' }));
    expect(first.statusCode).toBe(201);
    expect(first.json().migration).toMatchObject({ revision: 1, ruleCount: 19, filename: 'mapping.json', note: '1차', uploadedBy: 'admin' });
    expect(first.json().warnings).toEqual([{ ruleId: '50', code: 'unsupported', message: 'column / convert-lowercase 룰은 반영하지 않습니다' }]);
    expect((await post(s, s.admin, body(s))).json().migration.revision).toBe(2);

    const list = await s.app.inject({ method: 'GET', url: `/api/migrations?from=${s.asIs.schemaId}&to=${s.toBe.schemaId}`, headers: s.viewer });
    expect(list.json().map((m: { revision: number }) => m.revision)).toEqual([2, 1]);
    expect(list.json()[0]).not.toHaveProperty('source');
  });

  it('파싱 불가·rules 없음은 400, 같은 Schema 는 400, 없는 Schema 는 404', async () => {
    const s = await setup();
    const bad = await post(s, s.admin, body(s, { source: '{ not json' }));
    expect([bad.statusCode, bad.json().error]).toEqual([400, 'JSON 형식이 아닙니다']);
    expect((await post(s, s.admin, body(s, { source: '{"x":1}' }))).json().error).toBe('rules 배열이 없습니다');
    expect((await post(s, s.admin, body(s, { toSchemaId: s.asIs.schemaId }))).statusCode).toBe(400);
    expect((await post(s, s.admin, body(s, { toSchemaId: 9999 }))).statusCode).toBe(404);
    expect((await post(s, s.admin, body(s, { filename: '../x.json' }))).statusCode).toBe(400);
  });

  it('파일의 schema 이름이 Schema 이름과 달라도 올리고 경고한다', async () => {
    const s = await setup();
    const res = await post(s, s.admin, body(s, { source: dmsFixture('mapping.json').replaceAll('"legacy"', '"astore"') }));
    expect(res.statusCode).toBe(201);
    expect(res.json().warnings[0]).toEqual({ ruleId: '', code: 'invalid', message: "파일의 As-Is schema-name 'astore' 이 BASE Schema 'legacy' 과 다릅니다" });
  });
});

describe('원문·삭제·연쇄 삭제', () => {
  it('원문을 그대로 내려받고, 삭제하면 그 리비전만 빠진다', async () => {
    const s = await setup();
    const r1 = (await post(s, s.admin, body(s))).json().migration.id;
    const r2 = (await post(s, s.admin, body(s, { filename: 'v2.json' }))).json().migration.id;
    const src = await s.app.inject({ method: 'GET', url: `/api/migrations/${r2}/source`, headers: s.viewer });
    expect(src.body).toBe(dmsFixture('mapping.json'));
    expect(src.headers['content-disposition']).toContain('filename="v2.json"');
    expect((await s.app.inject({ method: 'DELETE', url: `/api/migrations/${r2}`, headers: s.viewer })).statusCode).toBe(403);
    expect((await s.app.inject({ method: 'DELETE', url: `/api/migrations/${r2}`, headers: s.admin })).statusCode).toBe(200);
    expect((await s.app.inject({ method: 'DELETE', url: `/api/migrations/${r2}`, headers: s.admin })).statusCode).toBe(404);
    const list = await s.app.inject({ method: 'GET', url: `/api/migrations?from=${s.asIs.schemaId}&to=${s.toBe.schemaId}`, headers: s.viewer });
    expect(list.json().map((m: { id: number; revision: number }) => [m.id, m.revision])).toEqual([[r1, 1]]);
  });

  it('Schema 를 지우면 매핑도 연쇄 삭제된다', async () => {
    const s = await setup();
    await post(s, s.admin, body(s));
    const count = () => one<{ n: number }>(s.db, 'SELECT COUNT(*) AS n FROM migration_mappings')!.n;
    expect(count()).toBe(1);
    const del = await s.app.inject({ method: 'DELETE', url: `/api/schemas/${s.toBe.schemaId}`, headers: s.admin, payload: { confirmName: 'newapp' } });
    expect(del.statusCode).toBe(200);
    expect(count()).toBe(0);
  });
});
