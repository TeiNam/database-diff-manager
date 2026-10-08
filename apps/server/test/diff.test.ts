import { describe, expect, it } from 'vitest';
import { DiffCache } from '../src/services/diff-service';
import { loggedInApp, multipart, SAMPLE_SQL, sampleText } from './helpers';

type App = Awaited<ReturnType<typeof loggedInApp>>;

async function upload(ctx: App, filename: string, content: string, schemaName = 'sample-app'): Promise<number> {
  const body = multipart({ meta: JSON.stringify([{ filename, databaseName: 'db', schemaName }]) }, [{ filename, content }]);
  const res = await ctx.app.inject({ method: 'POST', url: '/api/uploads', headers: { ...ctx.admin, ...body.headers }, payload: body.payload });
  return res.json().results[0].versionId;
}

const SQL = sampleText(SAMPLE_SQL);
const SQL_V2 = SQL.replace('`feature` varchar(50) NOT NULL', '`feature` varchar(80) NOT NULL');

describe('GET /api/diff', () => {
  it('두 버전의 diff·문장·DDL·양쪽 모델', async () => {
    const ctx = await loggedInApp();
    const v1 = await upload(ctx, SAMPLE_SQL, SQL);
    const v2 = await upload(ctx, SAMPLE_SQL, SQL_V2);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${v1}&target=${v2}`, headers: ctx.viewer });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.base.versionNo).toBe(1);
    expect(body.target.versionNo).toBe(2);
    expect(body.diff.tables.map((t: { name: string }) => t.name)).toEqual(['ai_usage_log']);
    expect(body.ddl).toContain('MODIFY COLUMN `feature` varchar(80) NOT NULL');
    expect(body.statements[0]).toMatchObject({ object: 'ai_usage_log', kind: 'table', op: 'modify', comment: false });
    expect(body.baseModel.tables).toHaveLength(33);
    expect(body.renames).toEqual([]);
  });

  it('다른 Schema의 버전과도 비교하고, 없는 버전은 404, 잘못된 쿼리는 400', async () => {
    const ctx = await loggedInApp();
    const a = await upload(ctx, 'a.sql', 'CREATE TABLE `t` (\n  `x` int\n);', 'stg');
    const b = await upload(ctx, 'b.sql', 'CREATE TABLE `t` (\n  `x` bigint\n);', 'prod');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${a}&target=${b}`, headers: ctx.viewer })).json().ddl).toContain('MODIFY COLUMN `x` bigint');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${a}&target=999`, headers: ctx.viewer })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/diff?base=x', headers: ctx.viewer })).statusCode).toBe(400);
  });
});

describe('PUT /api/diff/renames', () => {
  it('rename 매핑을 저장하면 diff가 다시 계산되고, 잘못된 매핑은 400', async () => {
    const ctx = await loggedInApp();
    const v1 = await upload(ctx, 's.sql', 'CREATE TABLE `members` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n);');
    const v2 = await upload(ctx, 's.sql', 'CREATE TABLE `member` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n);');
    const before = (await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${v1}&target=${v2}`, headers: ctx.viewer })).json();
    expect(before.diff.renameCandidates).toEqual([{ kind: 'table', from: 'members', to: 'member' }]);

    const bad = await ctx.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: ctx.viewer, payload: { base: v1, target: v2, renames: [{ kind: 'column', from: 'a', to: 'b' }] } });
    expect(bad.statusCode).toBe(400);

    const saved = await ctx.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: ctx.viewer, payload: { base: v1, target: v2, renames: [{ kind: 'table', from: 'members', to: 'member' }] } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().diff.tables.map((t: { op: string }) => t.op)).toEqual(['rename']);
    expect(saved.json().ddl).toContain('RENAME TABLE `members` TO `member`');

    const reloaded = (await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${v1}&target=${v2}`, headers: ctx.viewer })).json();
    expect(reloaded.renames).toEqual([{ kind: 'table', from: 'members', to: 'member', source: 'manual' }]);

    const cleared = await ctx.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: ctx.viewer, payload: { base: v1, target: v2, renames: [] } });
    expect(cleared.json().diff.tables.map((t: { op: string }) => t.op)).toEqual(['drop', 'add']);
  });
});

describe('GET /api/objects/:id/history', () => {
  it('리비전과 처음 나온 버전', async () => {
    const ctx = await loggedInApp();
    const v1 = await upload(ctx, SAMPLE_SQL, SQL);
    await upload(ctx, SAMPLE_SQL, SQL_V2);
    const detail = (await ctx.app.inject({ method: 'GET', url: `/api/versions/${v1}`, headers: ctx.viewer })).json();
    const objectId = detail.objects.find((o: { name: string }) => o.name === 'ai_usage_log').objectId;
    const history = (await ctx.app.inject({ method: 'GET', url: `/api/objects/${objectId}/history`, headers: ctx.viewer })).json();
    expect(history.object).toMatchObject({ kind: 'table', name: 'ai_usage_log' });
    expect(history.revisions.map((r: { revisionNo: number; firstVersion: { versionNo: number } }) => [r.revisionNo, r.firstVersion.versionNo])).toEqual([[1, 1], [2, 2]]);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/objects/9999/history', headers: ctx.viewer })).statusCode).toBe(404);
  });
});

describe('삭제 후 diff 캐시', () => {
  async function cachedPair(ctx: App) {
    const v1 = await upload(ctx, SAMPLE_SQL, SQL);
    const v2 = await upload(ctx, SAMPLE_SQL, SQL_V2);
    const url = `/api/diff?base=${v1}&target=${v2}`;
    expect((await ctx.app.inject({ method: 'GET', url, headers: ctx.viewer })).statusCode).toBe(200);
    return { v1, url };
  }

  it('버전을 삭제하면 캐시된 diff도 404', async () => {
    const ctx = await loggedInApp();
    const { v1, url } = await cachedPair(ctx);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/versions/${v1}`, headers: ctx.admin })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url, headers: ctx.viewer })).statusCode).toBe(404);
  });

  it('Database를 삭제하면 캐시된 diff도 404', async () => {
    const ctx = await loggedInApp();
    const { url } = await cachedPair(ctx);
    const tree = (await ctx.app.inject({ method: 'GET', url: '/api/tree', headers: ctx.viewer })).json();
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/databases/${tree[0].id}`, headers: ctx.admin, payload: { confirmName: tree[0].name } });
    expect(del.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url, headers: ctx.viewer })).statusCode).toBe(404);
  });
});

describe('DiffCache', () => {
  it('가장 오래 쓰지 않은 항목부터 버린다', () => {
    const cache = new DiffCache(2);
    const v = (n: number) => ({ ddl: String(n) }) as never;
    cache.set('a', v(1));
    cache.set('b', v(2));
    cache.get('a');
    cache.set('c', v(3));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
  });
});
