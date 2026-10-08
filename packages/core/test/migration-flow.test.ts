import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateDdl, renderDdl } from '../src/ddl';
import { diffSchemas } from '../src/diff';
import { type DmsMapping, parseDmsMapping } from '../src/dms-mapping';
import { buildMigrationFlow, toRenameMappings, toReverseRenameMappings } from '../src/migration-flow';
import { parseSqlDump } from '../src/parse-dump';
import { fixture } from './helpers';

const asIs = parseSqlDump(fixture('dms/as-is.sql')).model;
const toBe = parseSqlDump(fixture('dms/to-be.sql')).model;
const { mapping } = parseDmsMapping(fixture('dms/mapping.json'));
const flow = buildMigrationFlow(asIs, toBe, mapping);
const row = (name: string) => flow.tables.find((t) => (t.asIs ?? t.toBe) === name)!;
const cols = (name: string) => row(name).columns.map((c) => [c.asIs, c.toBe, c.status]);

describe('픽스처', () => {
  it('SQL 픽스처는 경고 없이 파싱된다', () => {
    expect(parseSqlDump(fixture('dms/as-is.sql')).warnings).toEqual([]);
    expect(parseSqlDump(fixture('dms/to-be.sql')).warnings).toEqual([]);
  });
});

describe('buildMigrationFlow', () => {
  it('테이블 상태: 대응·selection 밖·어느 As-Is 와도 이어지지 않은 To-Be', () => {
    expect(flow.tables.map((t) => [t.asIs, t.toBe, t.status, t.renamed])).toEqual([
      ['tb_cust', 'customer', 'ok', true],
      ['tb_prm', 'promotion', 'ok', true],
      ['tb_prm_cnd', 'promotion_condition', 'ok', true],
      ['tb_tmp_bak', undefined, 'excluded', false],
      [undefined, 'audit_log', 'unmapped-target', false],
    ]);
    expect(flow.fromSchema).toBe('legacy');
    expect(flow.toSchema).toBe('newapp');
  });

  it('컬럼 상태: 대문자 룰도 모델의 실제 이름으로 맞춘다', () => {
    expect(cols('tb_cust')).toEqual([
      ['cust_id', 'customer_id', 'renamed'],
      ['cust_nm', 'customer_name', 'renamed'],
      ['old_addr', undefined, 'removed'],
      ['tmp_flag', undefined, 'dropped'],
      ['CUST_GRD', 'customer_grade', 'missing'],
      [undefined, 'email', 'added'],
    ]);
    expect(cols('tb_prm_cnd')).toEqual([
      ['cnd_seq', 'condition_seq', 'renamed'],
      ['prm_id', 'promotion_id', 'renamed'],
      ['cnd_val', 'condition_value', 'renamed'],
      ['use_yn', 'use_yn', 'same'],
    ]);
    expect(row('tb_prm_cnd').columns[2]).toMatchObject({ asIsType: 'varchar(500)', toBeType: 'varchar(1000)' });
  });

  it('합계와 검증 통과 수 (ok 이면서 missing 컬럼이 없는 테이블)', () => {
    expect(flow.totals).toEqual({
      tables: { ok: 3, 'missing-target': 0, 'missing-source': 0, excluded: 1, 'unmapped-target': 1 },
      columns: { renamed: 8, same: 1, removed: 2, added: 1, dropped: 1, missing: 1 },
      inScope: 3,
      verified: 2,
    });
  });

  it('To-Be 에 없는 테이블은 missing-target, 모델에 없는 As-Is 테이블은 missing-source', () => {
    const extra = parseDmsMapping(JSON.stringify({ rules: [
      { 'rule-type': 'transformation', 'rule-id': '1', 'rule-target': 'table', 'object-locator': { 'schema-name': 'legacy', 'table-name': 'tb_prm' }, 'rule-action': 'rename', value: 'promo_v2' },
      { 'rule-type': 'transformation', 'rule-id': '2', 'rule-target': 'table', 'object-locator': { 'schema-name': 'legacy', 'table-name': 'tb_gone' }, 'rule-action': 'rename', value: 'audit_log' },
    ] })).mapping;
    const f = buildMigrationFlow(asIs, toBe, extra);
    expect(f.tables.find((t) => t.asIs === 'tb_prm')).toMatchObject({ toBe: 'promo_v2', status: 'missing-target', columns: [] });
    expect(f.tables.find((t) => t.asIs === 'tb_gone')).toMatchObject({ toBe: 'audit_log', status: 'missing-source' });
    expect(f.tables.some((t) => t.status === 'unmapped-target' && t.toBe === 'audit_log')).toBe(false);
  });

  it('테이블명은 정확히 같은 이름을 먼저 고른다', () => {
    const two = parseSqlDump('CREATE TABLE `T1` (\n  `a` int\n);\nCREATE TABLE `t1` (\n  `a` int\n);').model;
    const target = parseSqlDump('CREATE TABLE `x` (\n  `a` int\n);\nCREATE TABLE `T1` (\n  `a` int\n);').model;
    const m = parseDmsMapping(JSON.stringify({ rules: [
      { 'rule-type': 'transformation', 'rule-id': '1', 'rule-target': 'table', 'object-locator': { 'schema-name': 's', 'table-name': 't1' }, 'rule-action': 'rename', value: 'x' },
    ] })).mapping;
    expect(buildMigrationFlow(two, target, m).tables.slice(0, 2).map((t) => [t.asIs, t.toBe])).toEqual([['T1', 'T1'], ['t1', 'x']]);
  });
});

describe('toRenameMappings', () => {
  const renames = toRenameMappings(mapping, asIs, toBe);

  it('테이블 rename 과, To-Be 테이블명을 쓴 컬럼 rename (양쪽 모델에 있는 것만)', () => {
    expect(renames).toEqual([
      { kind: 'table', from: 'tb_cust', to: 'customer' },
      { kind: 'column', table: 'customer', from: 'cust_id', to: 'customer_id' },
      { kind: 'column', table: 'customer', from: 'cust_nm', to: 'customer_name' },
      { kind: 'table', from: 'tb_prm', to: 'promotion' },
      { kind: 'column', table: 'promotion', from: 'prm_id', to: 'promotion_id' },
      { kind: 'column', table: 'promotion', from: 'prm_nm', to: 'promotion_name' },
      { kind: 'column', table: 'promotion', from: 'reg_dt', to: 'created_at' },
      { kind: 'table', from: 'tb_prm_cnd', to: 'promotion_condition' },
      { kind: 'column', table: 'promotion_condition', from: 'cnd_seq', to: 'condition_seq' },
      { kind: 'column', table: 'promotion_condition', from: 'prm_id', to: 'promotion_id' },
      { kind: 'column', table: 'promotion_condition', from: 'cnd_val', to: 'condition_value' },
    ]);
  });

  it('적용하면 diffSchemas 가 drop+add 대신 rename 을 낸다', () => {
    const ops = (d: ReturnType<typeof diffSchemas>) => d.tables.map((t) => `${t.op}:${t.oldName ?? ''}>${t.name}`).sort();
    expect(ops(diffSchemas(asIs, toBe))).toEqual([
      'add:>audit_log', 'add:>customer', 'add:>promotion', 'add:>promotion_condition',
      'drop:>tb_cust', 'drop:>tb_prm', 'drop:>tb_prm_cnd', 'drop:>tb_tmp_bak',
    ]);
    const d = diffSchemas(asIs, toBe, renames);
    expect(ops(d)).toEqual([
      'add:>audit_log', 'drop:>tb_tmp_bak',
      'rename:tb_cust>customer', 'rename:tb_prm>promotion', 'rename:tb_prm_cnd>promotion_condition',
    ]);
    expect(d.ignoredRenames).toEqual([]);
    const promotion = d.tables.find((t) => t.name === 'promotion')!;
    expect(promotion.columns.map((c) => [c.op, c.oldName, c.name])).toEqual([
      ['rename', 'prm_id', 'promotion_id'], ['rename', 'prm_nm', 'promotion_name'], ['drop', undefined, 'max_dc_cnt'], ['rename', 'reg_dt', 'created_at'],
    ]);
  });
});

describe('toReverseRenameMappings (역방향: To-Be → As-Is)', () => {
  const reverse = toReverseRenameMappings(mapping, asIs, toBe);

  it('정방향 rename 을 뒤집고, 컬럼 매핑의 table 은 역방향 TARGET(As-Is) 테이블명이다', () => {
    expect(reverse).toEqual(toRenameMappings(mapping, asIs, toBe).map((r) => {
      const asIsTable = r.kind === 'column' ? { tb_cust: 'customer', tb_prm: 'promotion', tb_prm_cnd: 'promotion_condition' } : {};
      const table = Object.entries(asIsTable).find(([, toBeName]) => toBeName === r.table)?.[0];
      return r.kind === 'column' ? { kind: 'column', table, from: r.to, to: r.from } : { kind: 'table', from: r.to, to: r.from };
    }));
  });

  it('적용하면 되돌리기 diff 가 DROP 없이 rename 을 낸다 (매핑 대상)', () => {
    const d = diffSchemas(toBe, asIs, reverse);
    expect(d.tables.map((t) => `${t.op}:${t.oldName ?? ''}>${t.name}`).sort()).toEqual([
      'add:>tb_tmp_bak', 'drop:>audit_log',
      'rename:customer>tb_cust', 'rename:promotion>tb_prm', 'rename:promotion_condition>tb_prm_cnd',
    ]);
    expect(d.ignoredRenames).toEqual([]);
    const prm = d.tables.find((t) => t.name === 'tb_prm')!;
    expect(prm.columns.map((c) => [c.op, c.oldName, c.name])).toEqual([
      ['rename', 'promotion_id', 'prm_id'], ['rename', 'promotion_name', 'prm_nm'], ['rename', 'created_at', 'reg_dt'], ['add', undefined, 'max_dc_cnt'],
    ]);
  });
});

// 룰 없는 매핑 (selection 이 비어 있으면 모든 테이블이 대상)
const noRules = (): DmsMapping => ({ fromSchema: 'legacy', selection: { include: [], exclude: [] }, tables: [], columns: [], removedColumns: [], ruleCount: 0 });
const table = (name: string, cols: string[]) => `CREATE TABLE \`${name}\` (\n${cols.map((c) => `  \`${c}\` int NOT NULL`).join(',\n')}\n) ENGINE=InnoDB;\n`;

describe('대소문자만 다른 이름', () => {
  const base = parseSqlDump(table('Orders', ['id', 'REG_DT'])).model;
  const target = parseSqlDump(table('orders', ['id', 'reg_dt'])).model;

  it('전환 표는 ok/same 이지만 rename 매핑은 실제 표기 차이를 낸다', () => {
    const f = buildMigrationFlow(base, target, noRules());
    expect(f.tables.map((t) => [t.asIs, t.toBe, t.status])).toEqual([['Orders', 'orders', 'ok']]);
    expect(f.tables[0].columns.map((c) => [c.asIs, c.toBe, c.status])).toEqual([['id', 'id', 'same'], ['REG_DT', 'reg_dt', 'same']]);
    expect(toRenameMappings(noRules(), base, target)).toEqual([
      { kind: 'table', from: 'Orders', to: 'orders' },
      { kind: 'column', table: 'orders', from: 'REG_DT', to: 'reg_dt' },
    ]);
  });

  it('diffSchemas 가 drop/add 대신 rename 을 낸다 (데이터 삭제 DDL 방지)', () => {
    const d = diffSchemas(base, target, toRenameMappings(noRules(), base, target));
    expect(d.tables.map((t) => [t.op, t.oldName, t.name])).toEqual([['rename', 'Orders', 'orders']]);
    expect(d.tables[0].columns.map((c) => [c.op, c.oldName, c.name])).toEqual([['rename', 'REG_DT', 'reg_dt']]);
  });
});

describe('성능', () => {
  const TABLES = 600;
  const COLS = 32;
  const RULES_PER_TABLE = 31; // 테이블 rename 1 + 컬럼 rename 30 → 18,600 룰
  const names = Array.from({ length: TABLES }, (_, i) => `tb_${i}`);
  const colNames = Array.from({ length: COLS }, (_, j) => `c_${j}`);
  const base = parseSqlDump(names.map((n) => table(n, colNames)).join('')).model;
  const target = parseSqlDump(names.map((n) => table(`new_${n}`, colNames.map((c, j) => (j < RULES_PER_TABLE - 1 ? `n${c}` : c)))).join('')).model;
  const m: DmsMapping = {
    ...noRules(),
    tables: names.map((n, i) => ({ ruleId: `t${i}`, from: n.toUpperCase(), to: `new_${n}` })),
    columns: names.flatMap((n, i) => colNames.slice(0, RULES_PER_TABLE - 1).map((c, j) => ({ ruleId: `c${i}_${j}`, table: n, from: c, to: `n${c}` }))),
    ruleCount: TABLES * RULES_PER_TABLE,
  };

  it('600 테이블 · 18,600 룰을 2초 안에 계산한다', () => {
    const started = performance.now();
    const f = buildMigrationFlow(base, target, m);
    const elapsed = performance.now() - started;
    expect(f.totals.tables.ok).toBe(TABLES);
    expect(f.totals.columns.renamed).toBe(TABLES * (RULES_PER_TABLE - 1));
    expect(elapsed).toBeLessThan(2000);
  });
});

// 실제 DMS 샘플은 저장소에 넣지 않는다. 로컬에 있을 때만 확인한다
const SAMPLE_DIR = fileURLToPath(new URL('../../../samples/dms/', import.meta.url));
const samples = existsSync(SAMPLE_DIR) ? readdirSync(SAMPLE_DIR).filter((f) => f.endsWith('.json')) : [];

describe.skipIf(samples.length === 0)('로컬 DMS 샘플', () => {
  it.each(samples)('%s: 룰을 모두 읽고 경고 0', (file) => {
    const text = readFileSync(`${SAMPLE_DIR}${file}`, 'utf8');
    const { mapping: m, warnings } = parseDmsMapping(text);
    expect(m.ruleCount).toBe((JSON.parse(text) as { rules: unknown[] }).rules.length);
    expect(m.selection.include.length + m.tables.length + m.columns.length + m.removedColumns.length + (m.toSchema ? 1 : 0)).toBe(m.ruleCount);
    expect(warnings).toEqual([]);
  });
});

// t(a,b) 에서 a 를 지우고 b 를 a 로 rename (지워질 컬럼과 rename 대상 이름이 같다)
describe('컬럼 삭제와 rename 이 같은 이름에서 겹칠 때', () => {
  const asIsT = parseSqlDump(table('t', ['id', 'a', 'b'])).model;
  const toBeT = parseSqlDump(table('t', ['id', 'a'])).model;
  const overlap = (): DmsMapping => ({
    ...noRules(), columns: [{ ruleId: '1', table: 't', from: 'b', to: 'a' }], removedColumns: [{ ruleId: '2', table: 't', column: 'a' }], ruleCount: 2,
  });
  const ddlOf = (d: ReturnType<typeof diffSchemas>) => renderDdl(generateDdl(d));

  it('정방향: DROP a 다음 RENAME b TO a (b 의 값이 a 로 남는다)', () => {
    const d = diffSchemas(asIsT, toBeT, toRenameMappings(overlap(), asIsT, toBeT));
    expect(d.ignoredRenames).toEqual([]);
    expect(ddlOf(d)).toBe('-- [~] TABLE t\nALTER TABLE `t`\n  DROP COLUMN `a`,\n  RENAME COLUMN `b` TO `a`;\n');
  });

  it('역방향: RENAME a TO b 와 ADD a (To-Be a 의 값이 b 로 돌아간다)', () => {
    const d = diffSchemas(toBeT, asIsT, toReverseRenameMappings(overlap(), asIsT, toBeT));
    expect(d.ignoredRenames).toEqual([]);
    expect(ddlOf(d)).toBe('-- [~] TABLE t\nALTER TABLE `t`\n  ADD COLUMN `a` int NOT NULL AFTER `id`,\n  RENAME COLUMN `a` TO `b`;\n');
  });

  it('To-Be 에 같은 이름의 새 컬럼이 생겨도 rename 을 먼저 맞춘다 (b→c, 새 b)', () => {
    const toBeC = parseSqlDump(table('t', ['id', 'c', 'b'])).model;
    const asIsB = parseSqlDump(table('t', ['id', 'b'])).model;
    const m: DmsMapping = { ...noRules(), columns: [{ ruleId: '1', table: 't', from: 'b', to: 'c' }], ruleCount: 1 };
    const fwd = diffSchemas(asIsB, toBeC, toRenameMappings(m, asIsB, toBeC));
    expect(fwd.tables[0].columns.map((c) => [c.op, c.oldName, c.name])).toEqual([['rename', 'b', 'c'], ['add', undefined, 'b']]);
    const rev = diffSchemas(toBeC, asIsB, toReverseRenameMappings(m, asIsB, toBeC));
    expect(rev.tables[0].columns.map((c) => [c.op, c.oldName, c.name])).toEqual([['rename', 'c', 'b'], ['drop', undefined, 'b']]);
  });

  it('순서로 풀 수 없는 충돌(맞바꾸기)은 실행 SQL 대신 수동 확인 문장으로 낸다', () => {
    const swapTo = parseSqlDump(table('t', ['id', 'a', 'b', 'x'])).model;
    const swapFrom = parseSqlDump(table('t', ['id', 'a', 'b'])).model;
    const m: DmsMapping = { ...noRules(), columns: [{ ruleId: '1', table: 't', from: 'a', to: 'b' }, { ruleId: '2', table: 't', from: 'b', to: 'a' }], ruleCount: 2 };
    const d = diffSchemas(swapFrom, swapTo, toRenameMappings(m, swapFrom, swapTo));
    expect(d.ignoredRenames.map((r) => r.reason)).toEqual(['이름 충돌', '이름 충돌']);
    const stmts = generateDdl(d);
    expect(stmts.map((s) => s.comment)).toEqual([true]);
    expect(stmts[0].notes?.join('\n')).toContain('a→b');
    expect(stmts[0].sql).toContain('-- [수동 확인 필요]');
  });

  it('이름 충돌 테이블은 FK 삭제·추가·테이블 rename 까지 실행 문장을 남기지 않고, 다른 테이블은 그대로 실행 SQL 이다', () => {
    const parent = 'CREATE TABLE `p` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB;\n';
    const child = (name: string, cols: string[], fkCol: string) => `CREATE TABLE \`${name}\` (\n  \`id\` int NOT NULL,\n${cols.map((c) => `  \`${c}\` int NOT NULL,`).join('\n')}\n` +
      `  PRIMARY KEY (\`id\`),\n  KEY \`fk\` (\`${fkCol}\`),\n  CONSTRAINT \`fk\` FOREIGN KEY (\`${fkCol}\`) REFERENCES \`p\` (\`id\`)\n) ENGINE=InnoDB;\n`;
    const before = parseSqlDump(parent + child('t', ['a', 'b'], 'a') + table('u', ['id', 'x'])).model;
    const after = parseSqlDump(parent + child('t2', ['b', 'c'], 'c') + table('u', ['id', 'y'])).model;
    // 연쇄 rename a→b, b→c 는 순서로 풀 수 없어 이름 충돌이 된다
    const d = diffSchemas(before, after, [
      { kind: 'table', from: 't', to: 't2' },
      { kind: 'column', table: 't2', from: 'a', to: 'b' }, { kind: 'column', table: 't2', from: 'b', to: 'c' },
    ]);
    expect(d.ignoredRenames.map((r) => r.reason)).toEqual(['이름 충돌', '이름 충돌']);
    const stmts = generateDdl(d);
    const forT = stmts.filter((x) => x.object === 't2');
    expect(forT.length).toBeGreaterThan(2); // FK 삭제·rename·ALTER·FK 추가
    expect(forT.filter((x) => !x.comment)).toEqual([]);
    expect(forT.every((x) => x.sql.startsWith('-- [수동 확인 필요]') && x.notes?.some((n) => n.includes('a→b')))).toBe(true);
    expect(stmts.filter((x) => x.object === 'u').map((x) => x.comment)).toEqual([false]);
  });
});
