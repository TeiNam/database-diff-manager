import { describe, expect, it } from 'vitest';
import { replaceRenames } from '../src/repos/renames';
import { LruCache } from '../src/services/cache';
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

    const denied = await ctx.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: ctx.viewer, payload: { base: v1, target: v2, renames: [{ kind: 'table', from: 'members', to: 'member' }] } });
    expect(denied.statusCode).toBe(403); // viewer 는 읽기 전용

    const bad = await ctx.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: ctx.dba, payload: { base: v1, target: v2, renames: [{ kind: 'column', from: 'a', to: 'b' }] } });
    expect(bad.statusCode).toBe(400);

    const saved = await ctx.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: ctx.dba, payload: { base: v1, target: v2, renames: [{ kind: 'table', from: 'members', to: 'member' }] } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().diff.tables.map((t: { op: string }) => t.op)).toEqual(['rename']);
    expect(saved.json().ddl).toContain('RENAME TABLE `members` TO `member`');

    const reloaded = (await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${v1}&target=${v2}`, headers: ctx.viewer })).json();
    expect(reloaded.renames).toEqual([{ kind: 'table', from: 'members', to: 'member', source: 'manual' }]);

    const cleared = await ctx.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: ctx.dba, payload: { base: v1, target: v2, renames: [] } });
    expect(cleared.json().diff.tables.map((t: { op: string }) => t.op)).toEqual(['drop', 'add']);
  });
});

describe('Database 이름 변경과 diff 캐시', () => {
  it('PATCH 로 이름을 바꾸면 캐시된 diff 응답 메타도 새 이름이다', async () => {
    const ctx = await loggedInApp();
    const v1 = await upload(ctx, SAMPLE_SQL, SQL);
    const v2 = await upload(ctx, SAMPLE_SQL, SQL_V2);
    const url = `/api/diff?base=${v1}&target=${v2}`;
    const before = (await ctx.app.inject({ method: 'GET', url, headers: ctx.viewer })).json();
    expect(before.base.databaseName).toBe('db');
    const patched = await ctx.app.inject({ method: 'PATCH', url: `/api/databases/${before.base.databaseId}`, headers: ctx.admin, payload: { name: 'db-renamed' } });
    expect(patched.statusCode).toBe(200);
    const after = (await ctx.app.inject({ method: 'GET', url, headers: ctx.viewer })).json();
    expect([after.base.databaseName, after.target.databaseName]).toEqual(['db-renamed', 'db-renamed']);
  });
});

describe('수동 rename 의 역방향 적용', () => {
  const put = (ctx: App, base: number, target: number, renames: unknown[]) =>
    ctx.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: ctx.dba, payload: { base, target, renames } });
  const get = async (ctx: App, base: number, target: number) =>
    (await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${base}&target=${target}`, headers: ctx.viewer })).json();

  it('(v1,v2) 에 저장한 테이블·컬럼 rename 을 (v2,v1) 에서는 뒤집어 적용한다 (column 의 table 은 TARGET 쪽 이름)', async () => {
    const ctx = await loggedInApp();
    const v1 = await upload(ctx, 's.sql', 'CREATE TABLE `members` (\n  `id` int NOT NULL,\n  `nick` varchar(20) NOT NULL,\n  PRIMARY KEY (`id`)\n);');
    const v2 = await upload(ctx, 's.sql', 'CREATE TABLE `member` (\n  `id` int NOT NULL,\n  `nickname` varchar(20) NOT NULL,\n  PRIMARY KEY (`id`)\n);');
    await get(ctx, v2, v1); // 저장 전 역방향 결과가 캐시에 남아도 저장 뒤에는 다시 계산된다
    expect((await put(ctx, v1, v2, [{ kind: 'table', from: 'members', to: 'member' }, { kind: 'column', table: 'member', from: 'nick', to: 'nickname' }])).statusCode).toBe(200);

    const rev = await get(ctx, v2, v1);
    expect(rev.renames).toEqual([
      { kind: 'table', from: 'member', to: 'members', source: 'manual', reversed: true },
      { kind: 'column', table: 'members', from: 'nickname', to: 'nick', source: 'manual', reversed: true },
    ]);
    expect(rev.diff.ignoredRenames).toEqual([]);
    expect(rev.ddl).toContain('RENAME TABLE `member` TO `members`');
    expect(rev.ddl).toContain('RENAME COLUMN `nickname` TO `nick`');
    expect(rev.ddl).not.toContain('DROP');
  });

  it('정방향 쌍에 수동 매핑이 있으면 역쌍 매핑은 쓰지 않는다', async () => {
    const ctx = await loggedInApp();
    const v1 = await upload(ctx, 's.sql', 'CREATE TABLE `a` (\n  `id` int NOT NULL\n);\nCREATE TABLE `c` (\n  `id` int NOT NULL\n);');
    const v2 = await upload(ctx, 's.sql', 'CREATE TABLE `b` (\n  `id` int NOT NULL\n);\nCREATE TABLE `d` (\n  `id` int NOT NULL\n);');
    await put(ctx, v1, v2, [{ kind: 'table', from: 'a', to: 'b' }]);
    await put(ctx, v2, v1, [{ kind: 'table', from: 'd', to: 'c' }]);
    expect((await get(ctx, v2, v1)).renames).toEqual([{ kind: 'table', from: 'd', to: 'c', source: 'manual' }]);
  });
});

describe('수동 rename 역방향 적용 — DMS 테이블 rename·중복 대상·해제', () => {
  const put = (ctx: App, base: number, target: number, renames: unknown[]) =>
    ctx.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: ctx.dba, payload: { base, target, renames } });
  const get = async (ctx: App, base: number, target: number) =>
    (await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${base}&target=${target}`, headers: ctx.viewer })).json();

  it('DMS 테이블 rename(members→member) + 수동 컬럼 rename 의 역방향은 DMS 대응 테이블 이름으로 뒤집는다', async () => {
    const ctx = await loggedInApp();
    const v1 = await upload(ctx, 'a.sql', 'CREATE TABLE `members` (\n  `id` int NOT NULL,\n  `nick` varchar(20) NOT NULL,\n  PRIMARY KEY (`id`)\n);', 'legacy');
    const v2 = await upload(ctx, 'b.sql', 'CREATE TABLE `member` (\n  `id` int NOT NULL,\n  `nickname` varchar(20) NOT NULL,\n  PRIMARY KEY (`id`)\n);', 'newapp');
    const [from, to] = await Promise.all([get(ctx, v1, v2), get(ctx, v2, v1)]).then(([d]) => [d.base.schemaId, d.target.schemaId]);
    const rules = [
      { 'rule-type': 'selection', 'rule-id': '1', 'rule-name': '1', 'object-locator': { 'schema-name': 'legacy', 'table-name': 'members' }, 'rule-action': 'include' },
      { 'rule-type': 'transformation', 'rule-id': '2', 'rule-name': '2', 'rule-target': 'table', 'object-locator': { 'schema-name': 'legacy', 'table-name': 'members' }, 'rule-action': 'rename', value: 'member' },
    ];
    const uploaded = await ctx.app.inject({ method: 'POST', url: '/api/migrations', headers: ctx.admin, payload: { fromSchemaId: from, toSchemaId: to, filename: 'm.json', source: JSON.stringify({ rules }) } });
    expect(uploaded.statusCode).toBe(201);
    expect((await put(ctx, v1, v2, [{ kind: 'column', table: 'member', from: 'nick', to: 'nickname' }])).statusCode).toBe(200);

    const rev = await get(ctx, v2, v1);
    expect(rev.renames).toContainEqual({ kind: 'column', table: 'members', from: 'nickname', to: 'nick', source: 'manual', reversed: true });
    expect(rev.ddl).toContain('RENAME COLUMN `nickname` TO `nick`');
    expect(rev.ddl).not.toContain('DROP');
  });

  it('같은 대상으로 가는 매핑(c→b, a→b)은 저장 단계에서 거부한다', async () => {
    const ctx = await loggedInApp();
    const v1 = await upload(ctx, 's.sql', 'CREATE TABLE `a` (\n  `id` int NOT NULL\n);\nCREATE TABLE `c` (\n  `id` int NOT NULL\n);');
    const v2 = await upload(ctx, 's.sql', 'CREATE TABLE `b` (\n  `id` int NOT NULL\n);');
    const res = await put(ctx, v1, v2, [{ kind: 'table', from: 'c', to: 'b' }, { kind: 'table', from: 'a', to: 'b' }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('같은 이름(b)');
  });

  it('역쌍 매핑 사본을 이 쌍에 저장했다가 모두 해제하면 역쌍 매핑이 되살아나지 않는다', async () => {
    const ctx = await loggedInApp();
    const v1 = await upload(ctx, 's.sql', 'CREATE TABLE `members` (\n  `id` int NOT NULL\n);');
    const v2 = await upload(ctx, 's.sql', 'CREATE TABLE `member` (\n  `id` int NOT NULL\n);');
    await put(ctx, v1, v2, [{ kind: 'table', from: 'members', to: 'member' }]);
    expect((await get(ctx, v2, v1)).renames).toEqual([{ kind: 'table', from: 'member', to: 'members', source: 'manual', reversed: true }]);
    await put(ctx, v2, v1, [{ kind: 'table', from: 'member', to: 'members' }]); // 후보 처리 때 이 쌍에 사본 저장
    expect((await put(ctx, v2, v1, [])).statusCode).toBe(200);
    const rev = await get(ctx, v2, v1);
    expect(rev.renames).toEqual([]);
    expect(rev.diff.tables.map((t: { op: string }) => t.op)).toEqual(['drop', 'add']);
  });
});

describe('rename 3회차 — 역방향은 적용된 매핑만, 수동 테이블 rename 과 DMS 컬럼 대응', () => {
  const put = (ctx: App, base: number, target: number, renames: unknown[]) =>
    ctx.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: ctx.dba, payload: { base, target, renames } });
  const get = async (ctx: App, base: number, target: number) =>
    (await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${base}&target=${target}`, headers: ctx.viewer })).json();

  it('이미 저장된 c→b, a→b 의 역방향은 정방향에서 실제로 적용된 a→b 만 뒤집는다', async () => {
    const ctx = await loggedInApp();
    const v1 = await upload(ctx, 's.sql', 'CREATE TABLE `a` (\n  `id` int NOT NULL\n);\nCREATE TABLE `c` (\n  `id` int NOT NULL\n);');
    const v2 = await upload(ctx, 's.sql', 'CREATE TABLE `b` (\n  `id` int NOT NULL\n);');
    // 2회차 저장 검증 이전에 남은 데이터 (라우트를 거치지 않고 저장)
    replaceRenames(ctx.db, v1, v2, [{ kind: 'table', from: 'c', to: 'b' }, { kind: 'table', from: 'a', to: 'b' }], 1);
    const fwd = await get(ctx, v1, v2);
    const applied = fwd.diff.tables.filter((t: { op: string }) => t.op === 'rename').map((t: { oldName: string; name: string }) => `${t.oldName}→${t.name}`);
    expect(applied).toEqual(['a→b']);
    const rev = await get(ctx, v2, v1);
    expect(rev.renames).toEqual([{ kind: 'table', from: 'b', to: 'a', source: 'manual', reversed: true }]);
    expect(rev.ddl).toContain('RENAME TABLE `b` TO `a`');
  });

  it('DMS members→member·nick→nickname 의 테이블만 수동 members→customer 로 덮으면 DMS 컬럼 rename 은 customer 에 붙는다', async () => {
    const ctx = await loggedInApp();
    const v1 = await upload(ctx, 'a.sql', 'CREATE TABLE `members` (\n  `id` int NOT NULL,\n  `nick` varchar(20) NOT NULL,\n  PRIMARY KEY (`id`)\n);', 'legacy');
    const v2 = await upload(ctx, 'b.sql', [
      'CREATE TABLE `member` (\n  `id` int NOT NULL,\n  `nickname` varchar(20) NOT NULL,\n  PRIMARY KEY (`id`)\n);',
      'CREATE TABLE `customer` (\n  `id` int NOT NULL,\n  `nickname` varchar(20) NOT NULL,\n  PRIMARY KEY (`id`)\n);',
    ].join('\n'), 'newapp');
    const d0 = await get(ctx, v1, v2);
    const locator = { 'schema-name': 'legacy', 'table-name': 'members' };
    const rules = [
      { 'rule-type': 'selection', 'rule-id': '1', 'rule-name': '1', 'object-locator': locator, 'rule-action': 'include' },
      { 'rule-type': 'transformation', 'rule-id': '2', 'rule-name': '2', 'rule-target': 'table', 'object-locator': locator, 'rule-action': 'rename', value: 'member' },
      { 'rule-type': 'transformation', 'rule-id': '3', 'rule-name': '3', 'rule-target': 'column', 'object-locator': { ...locator, 'column-name': 'nick' }, 'rule-action': 'rename', value: 'nickname' },
    ];
    const uploaded = await ctx.app.inject({ method: 'POST', url: '/api/migrations', headers: ctx.admin, payload: { fromSchemaId: d0.base.schemaId, toSchemaId: d0.target.schemaId, filename: 'm.json', source: JSON.stringify({ rules }) } });
    expect(uploaded.statusCode).toBe(201);
    expect((await put(ctx, v1, v2, [{ kind: 'table', from: 'members', to: 'customer' }])).statusCode).toBe(200);

    const fwd = await get(ctx, v1, v2);
    expect(fwd.renames).toContainEqual({ kind: 'column', table: 'customer', from: 'nick', to: 'nickname', source: 'dms' });
    expect(fwd.diff.ignoredRenames).toEqual([]);
    expect(fwd.ddl).toContain('RENAME TABLE `members` TO `customer`');
    expect(fwd.ddl).toContain('RENAME COLUMN `nick` TO `nickname`');
    expect(fwd.ddl).not.toContain('DROP COLUMN');
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

describe('LruCache', () => {
  it('가장 오래 쓰지 않은 항목부터 버린다', () => {
    const cache = new LruCache<never>(2);
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
