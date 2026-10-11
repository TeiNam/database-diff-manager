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
    const saved = await s.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: s.dba, payload: { base: s.asIs.versionId, target: s.toBe.versionId, renames: [manual] } });
    const renames = saved.json().renames as { from: string; source: string }[];
    expect(renames).toHaveLength(11);
    expect(renames.filter((r) => r.from === 'reg_dt')).toEqual([{ ...manual, source: 'manual' }]);
    expect(renames.filter((r) => r.source === 'dms')).toHaveLength(10);
  });

  it('역방향(To-Be → As-Is) 비교에는 매핑을 뒤집어 rename 으로 반영하고, 정방향은 그대로다', async () => {
    const s = await setup();
    const reverseBefore = await s.getDiff(s.toBe.versionId, s.asIs.versionId);
    expect(reverseBefore.ddl).toContain('DROP TABLE `promotion`');
    await s.upload();
    const forward = await s.getDiff();
    const reverse = await s.getDiff(s.toBe.versionId, s.asIs.versionId);

    expect(tableOps(reverse)).toEqual(['add:tb_tmp_bak', 'drop:audit_log', 'rename:tb_cust', 'rename:tb_prm', 'rename:tb_prm_cnd']);
    expect(reverse.renames).toHaveLength(11);
    expect(reverse.renames.every((r: { source: string }) => r.source === 'dms')).toBe(true);
    expect(reverse.renames[0]).toEqual({ kind: 'table', from: 'customer', to: 'tb_cust', source: 'dms' });
    expect(reverse.diff.ignoredRenames).toEqual([]);
    expect(reverse.ddl).toContain('RENAME TABLE `promotion` TO `tb_prm`');
    for (const t of ['customer', 'promotion', 'promotion_condition']) expect(reverse.ddl).not.toContain(`DROP TABLE \`${t}\``);
    for (const c of ['promotion_id', 'promotion_name', 'created_at', 'customer_id', 'customer_name', 'condition_seq', 'condition_value']) {
      expect(reverse.ddl).not.toContain(`DROP COLUMN \`${c}\``);
    }
    // remove-column 은 역방향에서 ADD COLUMN 이 된다 (diff 에 맡긴다)
    expect(reverse.ddl).toMatch(/ADD COLUMN `max_dc_cnt`/);

    expect(forward.ddl).toContain('RENAME TABLE `tb_prm` TO `promotion`');
    expect(tableOps(forward)).toEqual(['add:audit_log', 'drop:tb_tmp_bak', 'rename:customer', 'rename:promotion', 'rename:promotion_condition']);
    expect(forward.renames[0]).toEqual({ kind: 'table', from: 'tb_cust', to: 'customer', source: 'dms' });
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
    s.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: s.dba, payload: { base: s.asIs.versionId, target: s.toBe.versionId, renames } });
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

// 17회차 2: 서로 다른 원본이 같은 목적지로 가는 DMS 매핑(a→c, b→c). DMS 에서도 두 원본의 데이터가 한 대상에 합쳐지는 충돌이다
describe('DMS 목적지 다대일', () => {
  const HEADER = "SET NAMES utf8mb4;\nSET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;\nSET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\n";
  const TRAILER = 'SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;\nSET SQL_MODE = @OLD_SQL_MODE;\n';
  const table = (name: string, cols: string[]) => `/* Table : ${name} */\nCREATE TABLE \`${name}\` (\n${cols.map((c) => `  \`${c}\` int NOT NULL`).join(',\n')}\n) ENGINE=InnoDB;\n`;
  // td-export 헤더·트레일러가 있는 완전한 덤프 (부재 기반 DROP 이 증거 보류가 아니라 매핑 충돌로 막히는지 본다)
  const dump = (db: string, ...tables: string[]) => `/* Database : ${db} */\n${HEADER}${tables.join('\n')}${TRAILER}`;
  const rule = (id: string, from: string, to: string) =>
    ({ 'rule-id': id, 'rule-type': 'transformation', 'rule-target': 'table', 'object-locator': { 'schema-name': 'legacy', 'table-name': from }, 'rule-action': 'rename', value: to });

  async function manyToOne() {
    const ctx = await loggedInApp();
    const put = (schemaName: string, text: string) => {
      const r = ingest(ctx.db, { databaseName: 'db', schemaName, filename: `${schemaName}.sql`, text, userId: 1 });
      return { versionId: r.versionId, schemaId: getVersionMeta(ctx.db, r.versionId).schemaId };
    };
    const asIs = put('legacy', dump('legacy', table('a', ['id']), table('b', ['id']), table('u', ['id', 'x'])));
    const toBe = put('newapp', dump('newapp', table('c', ['id']), table('u', ['id', 'y'])));
    const res = await ctx.app.inject({ method: 'POST', url: '/api/migrations', headers: ctx.admin, payload: {
      fromSchemaId: asIs.schemaId, toSchemaId: toBe.schemaId, filename: 'm.json', source: JSON.stringify({ rules: [rule('1', 'a', 'c'), rule('2', 'b', 'c')] }),
    } });
    const getDiff = async (base: number, target: number) =>
      (await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${base}&target=${target}`, headers: ctx.viewer })).json();
    return { ...ctx, asIs, toBe, upload: res.json(), getDiff };
  }
  type Stmt = { object: string; comment: boolean };
  const runnable = (body: { statements: Stmt[] }, names: string[]) => body.statements.filter((s) => names.includes(s.object) && !s.comment);

  it('업로드 경고(conflict)·전환 표 충돌·정방향/역방향 DDL 의 a·b·c 문장은 수동 확인', async () => {
    const s = await manyToOne();
    expect(s.upload.warnings.map((w: { ruleId: string; code: string }) => [w.ruleId, w.code])).toEqual([['1', 'conflict'], ['2', 'conflict']]);
    const flow = (await s.app.inject({ method: 'GET', url: `/api/migration-flow?base=${s.asIs.versionId}&target=${s.toBe.versionId}`, headers: s.viewer })).json();
    expect(flow.flow.tables.filter((t: { status: string }) => t.status === 'conflict').map((t: { asIs: string }) => t.asIs)).toEqual(['a', 'b']);
    const forward = await s.getDiff(s.asIs.versionId, s.toBe.versionId);
    const reverse = await s.getDiff(s.toBe.versionId, s.asIs.versionId);
    for (const body of [forward, reverse]) {
      expect(body.statements.filter((st: Stmt) => ['a', 'b', 'c'].includes(st.object)).length).toBeGreaterThan(0);
      expect(runnable(body, ['a', 'b', 'c'])).toEqual([]);
    }
  });

  it('역쌍 수동 매핑을 뒤집어 쓰는 역방향 비교도 충돌한 DMS 매핑을 빼지 않고 막는다', async () => {
    const s = await manyToOne();
    const saved = await s.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: s.dba, payload: {
      base: s.asIs.versionId, target: s.toBe.versionId, renames: [{ kind: 'column', table: 'u', from: 'x', to: 'y' }],
    } });
    expect(saved.statusCode).toBe(200);
    const reverse = await s.getDiff(s.toBe.versionId, s.asIs.versionId);
    expect(reverse.renames.some((r: { kind: string; from: string; to: string }) => r.kind === 'column' && r.from === 'y' && r.to === 'x')).toBe(true);
    expect(runnable(reverse, ['a', 'b', 'c'])).toEqual([]);
    expect(reverse.diff.ignoredRenames.map((r: { reason: string }) => r.reason)).toEqual(['매핑 충돌', '매핑 충돌']);
  });

  it('수동 매핑의 같은 목적지 거부는 대소문자를 무시한다', async () => {
    const s = await manyToOne();
    const res = await s.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: s.dba, payload: {
      base: s.asIs.versionId, target: s.toBe.versionId, renames: [{ kind: 'column', table: 'u', from: 'x', to: 'y' }, { kind: 'column', table: 'u', from: 'id', to: 'Y' }],
    } });
    expect(res.statusCode).toBe(400);
  });
});
