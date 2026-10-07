import { describe, expect, it } from 'vitest';
import { diffSchemas, diffTable, lcs, type RenameMapping } from '../src/diff';
import { parseSqlDump } from '../src/parse-dump';
import { partitionStatements } from '../src/partition-ddl';
import { parseCreateTable } from '../src/parse-table';
import type { Table, View } from '../src/model';
import { sample, scenario } from './helpers';

const run = (name: string, withRenames = false) => {
  const s = scenario(name);
  return diffSchemas(s.base, s.target, withRenames ? s.renames : []);
};

describe('lcs', () => {
  it('공통 부분 수열', () => {
    expect([...lcs(['a', 'b', 'c'], ['a', 'c', 'b'])]).toEqual(['a', 'c']);
  });
});

describe('diffSchemas', () => {
  it('같은 실데이터끼리는 변경이 없다', () => {
    const m = parseSqlDump(sample('sql')).model;
    expect(diffSchemas(m, m)).toEqual({ tables: [], views: [], renameCandidates: [], ignoredRenames: [], partial: false });
  });

  it('columns: 컬럼·인덱스·옵션 변경, AUTO_INCREMENT는 무시', () => {
    const [t] = run('columns').tables;
    expect(t.op).toBe('modify');
    expect(t.columns.map((c) => [c.op, c.name, c.fields])).toEqual([
      ['modify', 'status', ['type', 'comment']],
      ['drop', 'memo', []],
      ['add', 'discount_amt', []],
    ]);
    expect(t.moved).toEqual([]);
    expect(t.indexes.map((i) => [i.op, i.name])).toEqual([['drop', 'ix_user'], ['add', 'ix_orders_user_created']]);
    expect(t.options).toEqual([{ key: 'COMMENT', from: "'주문'", to: "'주문 정보'" }]);
  });

  it('tables: 테이블 추가·삭제와 FK 추가', () => {
    const d = run('tables');
    expect(d.tables.map((t) => [t.op, t.name])).toEqual([['drop', 'legacy_log'], ['modify', 'posts'], ['add', 'coupon']]);
    const posts = d.tables[1];
    expect(posts.indexes.map((i) => [i.op, i.name])).toEqual([['add', 'fk_posts_user']]);
    expect(posts.foreignKeys.map((f) => [f.op, f.name])).toEqual([['add', 'fk_posts_user']]);
    expect(d.renameCandidates).toEqual([]);
  });

  it('rename-table: 후보를 제시하고, 매핑하면 rename 하나로 합친다', () => {
    const plain = run('rename-table');
    expect(plain.tables.map((t) => [t.op, t.name])).toEqual([['drop', 'members'], ['add', 'member']]);
    expect(plain.renameCandidates).toEqual([{ kind: 'table', from: 'members', to: 'member' }]);
    const mapped = run('rename-table', true);
    expect(mapped.tables.map((t) => [t.op, t.name, t.oldName])).toEqual([['rename', 'member', 'members']]);
  });

  it('rename-column: 컬럼·인덱스 후보와 매핑', () => {
    const plain = run('rename-column');
    expect(plain.renameCandidates).toEqual([
      { kind: 'column', table: 'member', from: 'nick', to: 'nickname' },
      { kind: 'index', table: 'member', from: 'ix_old', to: 'ix_email' },
    ]);
    const [t] = run('rename-column', true).tables;
    expect(t.columns.map((c) => [c.op, c.name, c.oldName, c.fields])).toEqual([['rename', 'nickname', 'nick', []]]);
    expect(t.indexes.map((i) => [i.op, i.name, i.oldName])).toEqual([['rename', 'ix_email', 'ix_old']]);
  });

  it('partitions: 파티션 구성 변경', () => {
    const [t] = run('partitions').tables;
    expect(t.partition?.from?.partitions.map((p) => p.name)).toEqual(['p202510', 'p202511', 'pmax']);
    expect(t.partition?.to?.partitions.map((p) => p.name)).toEqual(['p202511', 'p202512', 'pmax']);
  });

  it('order-view: 컬럼 위치 변경과 뷰 본문 변경', () => {
    const d = run('order-view');
    expect(d.tables[0].moved).toEqual(['b']);
    expect(d.tables[0].columns).toEqual([]);
    expect(d.views.map((v) => [v.op, v.name, v.fields])).toEqual([['modify', 'v_a', ['body']]]);
  });

  it('mysql8: 인덱스 가시성, CHECK, 옵션 추가', () => {
    const [t] = run('mysql8').tables;
    expect(t.indexes.map((i) => [i.op, i.name, i.fields])).toEqual([['modify', 'ix_b', ['invisible']]]);
    expect(t.checks.map((c) => [c.op, c.name, c.fields])).toEqual([['modify', 'chk_a', ['expr']]]);
    expect(t.options).toEqual([{ key: 'ROW_FORMAT', to: 'DYNAMIC' }]);
  });
});

const tbl = (body: string, tail = ''): Table =>
  parseCreateTable(`CREATE TABLE \`t\` (\n${body}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4${tail}`);
const model = (tables: Table[], views: View[] = []) => ({ name: 's', tables, views });
const diffOne = diffTable;

describe('rename 컬럼 참조 갱신', () => {
  const base = tbl(
    '  `id` int NOT NULL,\n  `p` int NOT NULL,\n  `nick` varchar(10) NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix` (`nick`),\n' +
      '  CONSTRAINT `fk` FOREIGN KEY (`nick`) REFERENCES `o` (`n`)',
  );
  const target = tbl(
    '  `id` int NOT NULL,\n  `p` int NOT NULL,\n  `nickname` varchar(10) NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix` (`nickname`),\n' +
      '  CONSTRAINT `fk` FOREIGN KEY (`nickname`) REFERENCES `o` (`n`)',
  );
  it('인덱스·FK 안의 컬럼명 변경은 변경으로 보지 않는다', () => {
    const t = diffOne(base, target, [{ kind: 'column', table: 't', from: 'nick', to: 'nickname' }]);
    expect(t.columns.map((c) => [c.op, c.name])).toEqual([['rename', 'nickname']]);
    expect(t.indexes).toEqual([]);
    expect(t.foreignKeys).toEqual([]);
  });
  it('매핑이 없으면 인덱스·FK도 변경으로 나온다', () => {
    const t = diffOne(base, target);
    expect(t.indexes.map((i) => [i.op, i.fields])).toEqual([['modify', ['parts']]]);
    expect(t.foreignKeys.map((f) => [f.op, f.fields])).toEqual([['modify', ['columns']]]);
  });
});

describe('ignoredRenames', () => {
  const a = tbl('  `a` int NOT NULL,\n  `b` int NOT NULL');
  const b = tbl('  `x` int NOT NULL,\n  `b` int NOT NULL');
  const col = (from: string, to: string, table = 't') => ({ kind: 'column' as const, table, from, to });
  const reasons = (renames: RenameMapping[]) =>
    diffSchemas(model([a]), model([b]), renames).ignoredRenames.map((r) => [r.mapping.from, r.mapping.to, r.reason]);

  it('적용된 매핑은 없고, 거부된 매핑은 이유와 함께 돌려준다', () => {
    expect(reasons([col('a', 'x')])).toEqual([]);
    expect(reasons([col('a', 'y')])).toEqual([['a', 'y', '대상 없음']]);
    expect(reasons([col('z', 'x')])).toEqual([['z', 'x', '원본 없음']]);
    expect(reasons([col('a', 'b')])).toEqual([['a', 'b', '이름 충돌']]);
    expect(reasons([col('a', 'x', 'nope')])).toEqual([['a', 'x', '테이블 없음']]);
  });

  it('같은 대상으로의 중복 매핑은 첫 매핑만 적용한다', () => {
    const two = tbl('  `a` int NOT NULL,\n  `c` int NOT NULL');
    const d = diffSchemas(model([two]), model([tbl('  `x` int NOT NULL')]), [col('a', 'x'), col('c', 'x')]);
    expect(d.tables[0].columns.map((c) => [c.op, c.name, c.oldName])).toEqual([['rename', 'x', 'a'], ['drop', 'c', undefined]]);
    expect(d.ignoredRenames.map((r) => [r.mapping.from, r.reason])).toEqual([['c', '중복 매핑']]);
  });

  it('테이블 매핑', () => {
    const t = (name: string) => ({ ...a, name });
    const d = diffSchemas(model([t('p'), t('q')]), model([t('r')]), [
      { kind: 'table', from: 'p', to: 'r' }, { kind: 'table', from: 'q', to: 'r' }, { kind: 'table', from: 'p', to: 's' },
    ]);
    expect(d.tables.map((x) => [x.op, x.name])).toEqual([['rename', 'r'], ['drop', 'q']]);
    expect(d.ignoredRenames.map((r) => [r.mapping.from, r.mapping.to, r.reason])).toEqual([['q', 'r', '중복 매핑'], ['p', 's', '대상 없음']]);
  });
});

describe('diffSchemas 건너뛰기와 동등성', () => {
  it('unknown 컬럼 속성은 비교하지 않고 skipped에 기록한다', () => {
    const a = tbl('  `a` varchar(10) CHARACTER SET latin1 NOT NULL');
    const b = tbl('  `a` varchar(10) CHARACTER SET utf8mb4 NOT NULL');
    expect(diffOne(a, b).columns).toHaveLength(1);
    const p = { ...a, columns: [{ ...a.columns[0], unknown: ['charset' as const] }], fidelity: 'partial' as const };
    const r = diffSchemas(model([p]), model([b]));
    expect(r.partial).toBe(true);
    expect(r.tables).toEqual([]);
    const d = diffTableOf(p, { ...b, columns: [{ ...b.columns[0], default: "'x'" }] });
    expect(d.columns.map((c) => c.fields)).toEqual([['default']]);
    expect(d.skipped).toContain('column.charset');
  });

  it('unknown checks/partition과 comparableOptions', () => {
    const a = tbl('  `a` int NOT NULL,\n  CONSTRAINT `c` CHECK ((`a` > 0))', " COMMENT='x'");
    const b = tbl('  `a` int NOT NULL', " COMMENT='y'");
    const p = { ...a, unknown: ['checks' as const, 'partition' as const], comparableOptions: ['ENGINE'] };
    const d = diffTableOf(p, b);
    expect(d.checks).toEqual([]);
    expect(d.partition).toBeUndefined();
    expect(d.options).toEqual([]);
    expect(d.skipped).toEqual(expect.arrayContaining(['checks', 'partition', 'options']));
    expect(diffTableOf(a, b).checks).toHaveLength(1);
    expect(diffTableOf(a, b).options).toHaveLength(1);
  });

  it('partOrder unknown이면 PK 컬럼 순서를 무시한다', () => {
    const a = tbl('  `a` int NOT NULL,\n  `b` int NOT NULL,\n  PRIMARY KEY (`a`,`b`)');
    const b = tbl('  `a` int NOT NULL,\n  `b` int NOT NULL,\n  PRIMARY KEY (`b`,`a`)');
    expect(diffTableOf(a, b).indexes.map((i) => i.fields)).toEqual([['parts']]);
    const p = { ...a, indexes: a.indexes.map((i) => ({ ...i, unknown: ['partOrder' as const] })) };
    const d = diffTableOf(p, b);
    expect(d.indexes).toEqual([]);
    expect(d.skipped).toContain('index.partOrder');
  });

  it('FK 동작: 미지정, RESTRICT, NO ACTION은 같고 CASCADE는 다르다', () => {
    const fk = (act: string) =>
      tbl(`  \`a\` int NOT NULL,\n  CONSTRAINT \`f\` FOREIGN KEY (\`a\`) REFERENCES \`o\` (\`a\`)${act}`);
    const none = fk('');
    expect(diffTableOf(none, fk(' ON DELETE RESTRICT')).foreignKeys).toEqual([]);
    expect(diffTableOf(fk(' ON DELETE NO ACTION'), fk(' ON DELETE RESTRICT')).foreignKeys).toEqual([]);
    expect(diffTableOf(none, fk(' ON DELETE CASCADE')).foreignKeys.map((f) => f.fields)).toEqual([['onDelete']]);
  });

  it('파싱 실패 테이블: rawDdl이 다르면 unparsed', () => {
    const bad = (raw: string): Table => ({ ...tbl('  `a` int'), parseError: 'x', rawDdl: raw });
    const d = diffSchemas(model([bad('A')]), model([bad('B')])).tables[0];
    expect([d.op, d.unparsed]).toEqual(['modify', true]);
    expect(diffSchemas(model([bad('A')]), model([bad('A')])).tables).toEqual([]);
  });

  it('파싱 실패 테이블은 테이블 rename 후보에서 뺀다', () => {
    const bad = (name: string): Table => ({ ...tbl('  `a` int'), name, columns: [], parseError: 'x', rawDdl: name });
    expect(diffSchemas(model([bad('a1')]), model([bad('a2')])).renameCandidates).toEqual([]);
  });

  it('SUBPARTITION 절 변경을 감지하고 PARTITION BY로 재정의한다', () => {
    const sub = (n: number) =>
      tbl('  `d` date NOT NULL', `\n/*!50100 PARTITION BY RANGE (year(\`d\`))\nSUBPARTITION BY HASH (to_days(\`d\`))\nSUBPARTITIONS ${n}\n(PARTITION p0 VALUES LESS THAN (2000) ENGINE = InnoDB) */`);
    const d = diffTableOf(sub(2), sub(4));
    expect(d.partition).toBeDefined();
    expect(partitionStatements(d)).toEqual([`ALTER TABLE \`t\` ${sub(4).partition!.clause}`]);
    expect(diffTableOf(sub(2), sub(2)).partition).toBeUndefined();
  });

  it('뷰 추가와 삭제', () => {
    const v = (name: string): View => ({ kind: 'view', name, body: 'select 1', fidelity: 'full' });
    const d = diffSchemas(model([], [v('old')]), model([], [v('new')]));
    expect(d.views.map((x) => [x.op, x.name])).toEqual([['drop', 'old'], ['add', 'new']]);
  });
});

function diffTableOf(a: Table, b: Table) {
  return diffTable(a, b);
}
