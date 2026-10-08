import { describe, expect, it } from 'vitest';
import { getVersionMeta } from '../src/repos/versions';
import { ingest } from '../src/services/ingest';
import { dmsFixture, loggedInApp } from './helpers';

async function setup() {
  const ctx = await loggedInApp();
  const put = (schemaName: string, file: 'as-is.sql' | 'to-be.sql') => {
    const r = ingest(ctx.db, { databaseName: 'db', schemaName, filename: file, text: dmsFixture(file), userId: 1 });
    return { versionId: r.versionId, schemaId: getVersionMeta(ctx.db, r.versionId).schemaId };
  };
  const asIs = put('legacy', 'as-is.sql');
  const toBe = put('newapp', 'to-be.sql');
  const getDiff = async (base = asIs.versionId, target = toBe.versionId) =>
    (await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${base}&target=${target}`, headers: ctx.viewer })).json();
  const upload = async () => (await ctx.app.inject({ method: 'POST', url: '/api/migrations', headers: ctx.admin, payload: {
    fromSchemaId: asIs.schemaId, toSchemaId: toBe.schemaId, filename: 'mapping.json', source: dmsFixture('mapping.json'),
  } })).json().migration.id as number;
  return { ...ctx, asIs, toBe, getDiff, upload };
}

const tableOps = (body: { diff: { tables: { op: string; name: string }[] } }) => body.diff.tables.map((t) => `${t.op}:${t.name}`).sort();

describe('diff 에 DMS 매핑 반영', () => {
  it('매핑을 올리면 drop+add 가 rename 이 되고, 지우면 되돌아간다 (캐시 무효화)', async () => {
    const s = await setup();
    const before = await s.getDiff();
    expect(tableOps(before)).toContain('drop:tb_prm');
    expect(before.renames).toEqual([]);

    const id = await s.upload();
    const after = await s.getDiff();
    expect(tableOps(after)).toEqual(['add:audit_log', 'drop:tb_tmp_bak', 'rename:customer', 'rename:promotion', 'rename:promotion_condition']);
    expect(after.renames).toHaveLength(11);
    expect(after.renames[0]).toEqual({ kind: 'table', from: 'tb_cust', to: 'customer', source: 'dms' });
    expect(after.ddl).toContain('RENAME TABLE `tb_prm` TO `promotion`');

    await s.app.inject({ method: 'DELETE', url: `/api/migrations/${id}`, headers: s.admin });
    expect((await s.getDiff()).renames).toEqual([]);
  });

  it('같은 대상이면 수동 매핑이 이기고, 출처를 붙인다', async () => {
    const s = await setup();
    await s.upload();
    const manual = { kind: 'column', table: 'promotion', from: 'reg_dt', to: 'registered_at' };
    const saved = await s.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: s.viewer, payload: { base: s.asIs.versionId, target: s.toBe.versionId, renames: [manual] } });
    const renames = saved.json().renames as { from: string; source: string }[];
    expect(renames).toHaveLength(11);
    expect(renames.filter((r) => r.from === 'reg_dt')).toEqual([{ ...manual, source: 'manual' }]);
    expect(renames.filter((r) => r.source === 'dms')).toHaveLength(10);
  });

  it('역방향 비교에는 적용하지 않는다', async () => {
    const s = await setup();
    await s.upload();
    const reverse = await s.getDiff(s.toBe.versionId, s.asIs.versionId);
    expect(reverse.renames).toEqual([]);
    expect(tableOps(reverse)).toContain('drop:promotion');
  });
});

describe('GET /api/migration-flow', () => {
  it('매핑이 없으면 mapping: null, 있으면 메타·전환 표·경고', async () => {
    const s = await setup();
    const url = `/api/migration-flow?base=${s.asIs.versionId}&target=${s.toBe.versionId}`;
    expect((await s.app.inject({ method: 'GET', url, headers: s.viewer })).json()).toEqual({ mapping: null });
    await s.upload();
    const res = (await s.app.inject({ method: 'GET', url, headers: s.viewer })).json();
    expect(res.mapping).toMatchObject({ revision: 1, ruleCount: 19 });
    expect(res.mapping).not.toHaveProperty('source');
    expect(res.flow.totals).toMatchObject({ inScope: 3, verified: 2 });
    expect(res.warnings.map((w: { ruleId: string }) => w.ruleId)).toEqual(['50']);
  });

  it('역방향(To-Be → As-Is) 비교에는 적용하지 않는다', async () => {
    const s = await setup();
    await s.upload();
    const res = await s.app.inject({ method: 'GET', url: `/api/migration-flow?base=${s.toBe.versionId}&target=${s.asIs.versionId}`, headers: s.viewer });
    expect(res.json()).toEqual({ mapping: null });
  });
});

describe('PUT /api/diff/renames 와 DMS rename', () => {
  const put = (s: Awaited<ReturnType<typeof setup>>, renames: unknown[]) =>
    s.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: s.viewer, payload: { base: s.asIs.versionId, target: s.toBe.versionId, renames } });
  const strip = (rs: { source: string }[]) => rs.map(({ source: _s, ...r }) => r);

  it('DMS rename 을 되돌려 보내도 수동으로 저장하지 않는다', async () => {
    const s = await setup();
    const id = await s.upload();
    const dms = strip((await s.getDiff()).renames);
    const manual = { kind: 'column', table: 'promotion', from: 'reg_dt', to: 'registered_at' };
    const res = await put(s, [...dms, manual]);
    expect(res.statusCode).toBe(200);
    const renames = res.json().renames as { from: string; source: string }[];
    expect(renames.filter((r) => r.source === 'manual')).toEqual([{ ...manual, source: 'manual' }]);
    expect(renames).toHaveLength(11);

    await s.app.inject({ method: 'DELETE', url: `/api/migrations/${id}`, headers: s.admin });
    expect((await s.getDiff()).renames).toEqual([{ ...manual, source: 'manual' }]);
  });

  it('DMS 와 같은 대상이라도 to 가 다르면 수동 override 로 저장한다', async () => {
    const s = await setup();
    await s.upload();
    const override = { kind: 'table', from: 'tb_cust', to: 'customer_x' };
    const res = await put(s, [override]);
    expect(res.json().renames.filter((r: { from: string }) => r.from === 'tb_cust')).toEqual([{ ...override, source: 'manual' }]);
  });

  it('DMS 와 같은 항목을 빼면 수동 500개 초과가 아니고, 진짜 수동 500개 초과는 400', async () => {
    const s = await setup();
    await s.upload();
    const dms = strip((await s.getDiff()).renames);
    const filler = Array.from({ length: 495 }, (_, i) => ({ kind: 'table', from: `x${i}`, to: `y${i}` }));
    expect((await put(s, [...dms, ...filler])).statusCode).toBe(200);
    const many = Array.from({ length: 501 }, (_, i) => ({ kind: 'table', from: `x${i}`, to: `y${i}` }));
    expect((await put(s, [...dms, ...many])).statusCode).toBe(400);
  });
});
