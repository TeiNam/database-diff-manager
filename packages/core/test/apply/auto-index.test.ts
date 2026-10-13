// FK 가 자동으로 만든 인덱스 — 덤프에서 이름으로 가리기, 이 실행(applyScript)이 아는 출처, 새 키가 자동 키를 버리는 계획 (MySQL 8.0.46·8.4.11 실측)
import { describe, expect, it } from 'vitest';
import { assertAutoKeysKnown, classifyFkIndexes, markProvenance, planAutoKeys, renameProvenance, syncProvenance } from '../../src/apply/auto-index';
import { initialState, type IndexProvenance, type State } from '../../src/apply/state';
import { DEFAULT_SQL_MODE, MYSQL_DEFAULTS, type FkItem, type IndexItem } from '../../src/apply/types';
import type { Column, ForeignKey, Index, IndexKind, Table } from '../../src/model';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

const plain = (name: string, ...cols: string[]): Index => ({ name, kind: 'INDEX', parts: cols.map((column) => ({ column, desc: false })), invisible: false });
const col = (name: string): Column => ({ name, type: 'int', nullable: true, invisible: false, autoIncrement: false, default: 'NULL' });
const fkOf = (name: string, columns: string[] = ['x0']): ForeignKey => ({ name, columns, refTable: 'par', refColumns: ['id'] });
const tableOf = (indexes: Index[], fks: ForeignKey[] = [fkOf('t_ibfk_1')], name = 't'): Table => ({
  kind: 'table', name, columns: [col('id'), col('x0'), col('x1')], indexes, foreignKeys: fks, checks: [], options: [], fidelity: 'full',
});
const none = { generated: [], ambiguous: [] };
const classes = (t: Table, known?: ReadonlyMap<string, IndexProvenance>) => {
  const c = classifyFkIndexes(t, known);
  return { generated: [...c.generated], ambiguous: [...c.ambiguous] };
};

// 덤프에서 이름으로 가린다 (자동 키 표시는 SHOW CREATE 에 안 나온다): 이름이 FK 이름과 같으면 자동(generated), FK 이름이 자동 꼴(<테이블>_ibfk_N)일 때 첫 컬럼 이름이나
// <컬럼>_N 이면 알 수 없음(ambiguous), 그 밖은 직접 만든 것. 받치는 인덱스는 FK 컬럼 그대로인 일반 KEY 하나뿐이어야 한다
describe('classifyFkIndexes — 덤프에서 이름으로 가리기', () => {
  it('이름이 FK 이름과 같으면 generated (대소문자 무시)', () => {
    expect(classes(tableOf([plain('f', 'x0')], [fkOf('f')]))).toEqual({ generated: ['f'], ambiguous: [] });
    expect(classes(tableOf([plain('F', 'x0')], [fkOf('f')]))).toEqual({ generated: ['f'], ambiguous: [] });
    expect(classes(tableOf([plain('t_ibfk_1', 'x0')], [fkOf('t_ibfk_1')]))).toEqual({ generated: ['t_ibfk_1'], ambiguous: [] }); // CONSTRAINT t_ibfk_1 로 직접 쓴 이름
  });

  it('FK 이름이 <테이블>_ibfk_N 꼴이면 첫 컬럼 이름·<컬럼>_N 인덱스는 ambiguous', () => {
    expect(classes(tableOf([plain('x0', 'x0')]))).toEqual({ generated: [], ambiguous: ['x0'] });
    expect(classes(tableOf([plain('X0_2', 'x0')]))).toEqual({ generated: [], ambiguous: ['x0_2'] });
    for (const name of ['idx_user', 'x0_x', 'x0_', 'x00', 'k0']) expect(classes(tableOf([plain(name, 'x0')])), name).toEqual(none);
  });

  it('FK 이름이 자동 꼴이 아니면 첫 컬럼 이름 인덱스는 직접 만든 것이다 (CONSTRAINT 이름이 있으면 자동 인덱스는 늘 그 이름이다)', () => {
    expect(classes(tableOf([plain('x0', 'x0')], [fkOf('fk_a')]))).toEqual(none);
    expect(classes(tableOf([plain('x0_2', 'x0')], [fkOf('f')]))).toEqual(none);
    expect(classes(tableOf([plain('x0', 'x0')], [fkOf('other_ibfk_1')]))).toEqual(none); // 다른 테이블 이름의 자동 꼴
    expect(classes(tableOf([plain('x0', 'x0')], [fkOf('u_ibfk_1')], 'u'))).toEqual({ generated: [], ambiguous: ['x0'] }); // 테이블 이름이 u 면 자동 꼴
    expect(classes(tableOf([plain('fk_a', 'x0')], [fkOf('fk_a')]))).toEqual({ generated: ['fk_a'], ambiguous: [] }); // 이름이 FK 이름이면 FK 이름 꼴과 상관없이 자동
  });

  it('FK 이름이 첫 컬럼 이름과도 같으면 generated 가 먼저다', () => {
    expect(classes(tableOf([plain('x0', 'x0')], [fkOf('x0')]))).toEqual({ generated: ['x0'], ambiguous: [] });
  });

  it('받치는 인덱스의 모양이 FK 컬럼 그대로인 일반 KEY 가 아니면 가리지 않는다 (UNIQUE·FULLTEXT·DESC·prefix 길이·컬럼이 더 많거나 적음)', () => {
    const odd = (patch: Partial<Index>): Index => ({ ...plain('f', 'x0'), ...patch });
    const fks = [fkOf('f')];
    expect(classes(tableOf([odd({ kind: 'UNIQUE' })], fks))).toEqual(none);
    expect(classes(tableOf([odd({ kind: 'FULLTEXT' })], fks))).toEqual(none);
    expect(classes(tableOf([odd({ parts: [{ column: 'x0', desc: true }] })], fks))).toEqual(none);
    expect(classes(tableOf([odd({ parts: [{ column: 'x0', length: 5, desc: false }] })], fks))).toEqual(none);
    expect(classes(tableOf([plain('f', 'x0', 'x1')], fks))).toEqual(none); // FK (x0) 보다 길다
    expect(classes(tableOf([plain('f', 'x0')], [fkOf('f', ['x0', 'x1'])]))).toEqual(none); // FK (x0, x1) 보다 짧다
  });

  it('그 앞쪽을 가진 다른 인덱스가 있거나 같은 모양이 둘이면 자동 키일 수 없다 (직접 만든 것)', () => {
    const fks = [fkOf('f')];
    expect(classes(tableOf([plain('f', 'x0'), plain('ix', 'x0', 'x1')], fks))).toEqual(none);
    expect(classes(tableOf([plain('f', 'x0'), plain('ix', 'x1', 'x0')], fks))).toEqual({ generated: ['f'], ambiguous: [] }); // 앞쪽이 아니다
    expect(classes(tableOf([plain('f', 'x0'), { ...plain('uq', 'x0', 'x1'), kind: 'UNIQUE' }], fks))).toEqual(none);
    expect(classes(tableOf([plain('f', 'x0'), plain('g', 'x0')], fks))).toEqual(none);
  });

  it('FK 가 둘이 같은 인덱스를 쓰면 이름이 맞는 FK 쪽으로 가린다', () => {
    expect(classes(tableOf([plain('f2', 'x0')], [fkOf('f1'), fkOf('f2')]))).toEqual({ generated: ['f2'], ambiguous: [] });
  });
});

// 이 실행이 아는 출처가 덤프 이름보다 먼저다. FK 가 없는 남은 인덱스도 안다 (FK 를 지워도 MySQL 의 자동 표시는 남는다)
describe('classifyFkIndexes — 이 실행이 아는 출처', () => {
  const known = (...entries: [string, IndexProvenance][]) => new Map(entries);

  it('아는 auto·ambiguous 는 FK 가 없어도 그대로 돌려준다 (FK 만 지운 뒤 남은 인덱스)', () => {
    const orphan = tableOf([plain('f', 'x0')], []);
    expect(classes(orphan)).toEqual(none); // 모르면 덤프로 짐작할 FK 도 없다
    expect(classes(orphan, known(['f', 'auto']))).toEqual({ generated: ['f'], ambiguous: [] });
    expect(classes(tableOf([plain('x0', 'x0')], []), known(['x0', 'ambiguous']))).toEqual({ generated: [], ambiguous: ['x0'] });
  });

  it('아는 user 는 이름이 FK 이름과 같아도·첫 컬럼 이름이어도 가리지 않는다', () => {
    expect(classes(tableOf([plain('f', 'x0')], [fkOf('f')]), known(['f', 'user']))).toEqual(none);
    expect(classes(tableOf([plain('x0', 'x0')]), known(['x0', 'user']))).toEqual(none);
  });

  it('아는 출처가 덤프 짐작을 이긴다 (FK 이름과 같은 인덱스를 ambiguous 로 알면 ambiguous)', () => {
    expect(classes(tableOf([plain('f', 'x0')], [fkOf('f')]), known(['f', 'ambiguous']))).toEqual({ generated: [], ambiguous: ['f'] });
  });

  it('테이블에 없는 인덱스의 출처는 무시하고, 출처를 모르는 인덱스는 덤프로 짐작한다', () => {
    const t = tableOf([plain('f', 'x0'), plain('ka', 'x1')], [fkOf('f')]);
    expect(classes(t, known(['gone', 'auto'], ['ka', 'user']))).toEqual({ generated: ['f'], ambiguous: [] });
  });

  it('대소문자를 가리지 않는다', () => {
    expect(classes(tableOf([plain('F', 'x0')], []), known(['f', 'auto']))).toEqual({ generated: ['f'], ambiguous: [] });
  });
});

// 이 문장이 더하는 키가 자동 키를 버리는 계획: 버려지는 기존 인덱스 · 만들지 않는 FK 자동 키 · 자동인지 알 수 없는데 버려지는 인덱스
describe('planAutoKeys / assertAutoKeysKnown', () => {
  const child = tableOf([{ name: 'PRIMARY', kind: 'PRIMARY', parts: [{ column: 'id', desc: false }], invisible: false }, plain('pid', 'x0')]);
  const idx = (name: string, kind: IndexKind, cols: string[], length?: number): IndexItem =>
    ({ kind: 'index', named: true, index: { name, kind, parts: cols.map((column) => ({ column, desc: false, ...(length ? { length } : {}) })), invisible: false } });
  const fk = (columns: string[], name: string): FkItem => ({ kind: 'fk', named: true, fk: { name, columns, refTable: 'par', refColumns: ['id'] } });
  const auto = (generated: string[], ambiguous: string[] = []) => ({ generated: new Set(generated), ambiguous: new Set(ambiguous) });

  it('자동 인덱스는 같은 컬럼으로 시작하는 새 인덱스가 버린다 (종류·이름 상관없음), 새 키가 앞쪽을 갖지 못하면 남는다', () => {
    const names = (items: IndexItem[]) => planAutoKeys(child, items, auto(['pid'])).kept.map((i) => i.name);
    expect(names([idx('ix', 'INDEX', ['x0', 'x1'])])).toEqual(['PRIMARY']);
    expect(names([idx('uq', 'UNIQUE', ['x0'])])).toEqual(['PRIMARY']);
    expect(names([idx('ft', 'FULLTEXT', ['x0'])])).toEqual(['PRIMARY']); // 종류는 보지 않는다 (MySQL 도 FULLTEXT 가 버린다)
    expect(names([idx('ix', 'INDEX', ['x1', 'x0'])])).toEqual(['PRIMARY', 'pid']);
    expect(names([idx('ix', 'INDEX', ['x0'], 5)])).toEqual(['PRIMARY', 'pid']); // prefix 길이가 다르면 다른 키 파트다
    expect(planAutoKeys(child, [idx('ix', 'INDEX', ['x0'])], auto([])).kept.map((i) => i.name)).toEqual(['PRIMARY', 'pid']); // 자동 키가 아니면 버리지 않는다
  });

  it('새 FK 의 자동 키는 직접 만든 인덱스가 받치면 만들지 않고, 자동 인덱스 뿐이면 만들며 옛 자동 인덱스를 버린다', () => {
    const newFk = fk(['x0'], 'again');
    const user = planAutoKeys(child, [newFk], auto([]));
    expect(user.skipped.has(newFk)).toBe(true);
    expect(user.kept.map((i) => i.name)).toEqual(['PRIMARY', 'pid']);
    const replaced = planAutoKeys(child, [newFk], auto(['pid']));
    expect(replaced.skipped.has(newFk)).toBe(false);
    expect(replaced.kept.map((i) => i.name)).toEqual(['PRIMARY']);
  });

  it('자동인지 알 수 없는 인덱스가 버려지면 uncertain 에 이름이 들고, assertAutoKeysKnown 은 RE_EXPORT 로 끝나는 메시지로 거부한다', () => {
    const plan = planAutoKeys(child, [idx('ix', 'INDEX', ['x0', 'x1'])], auto([], ['pid']));
    expect(plan.uncertain).toEqual(['pid']);
    expect(() => assertAutoKeysKnown(plan)).toThrow(/`pid`.*자동으로 만든 것인지.*td-export 로 다시 뽑아 올려 주세요$/);
    expect(planAutoKeys(child, [idx('ix', 'INDEX', ['x1'])], auto([], ['pid'])).uncertain).toEqual([]);
    expect(() => assertAutoKeysKnown(planAutoKeys(child, []))).not.toThrow();
  });
});

// 출처 표 (st.origins.provenance: 테이블 → 인덱스 이름(소문자) → auto·user·ambiguous)
describe('출처 표 — markProvenance·renameProvenance·syncProvenance', () => {
  const DUMP = tdExport('CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;');
  const fresh = (): State => initialState(parseSqlDump(DUMP).model, 'shop', MYSQL_DEFAULTS, DEFAULT_SQL_MODE);
  const entries = (st: State, table = 't') => [...(st.origins.provenance.get(table) ?? [])];

  it('기준 버전의 테이블은 아는 출처가 없다', () => {
    expect(entries(fresh())).toEqual([]);
  });

  it('markProvenance: 이름을 소문자로 적고 기존 값을 덮어쓴다 — 표를 새로 만들어 넣는다 (이전 표는 그대로)', () => {
    const st = fresh();
    markProvenance(st, 't', ['Ix', 'f'], 'user');
    const before = st.origins.provenance.get('t')!;
    markProvenance(st, 't', ['f'], 'auto');
    expect(entries(st)).toEqual([['ix', 'user'], ['f', 'auto']]);
    expect([...before]).toEqual([['ix', 'user'], ['f', 'user']]);
  });

  it('renameProvenance: 옛 이름을 지우고 새 이름은 user — RENAME INDEX 는 자동 표시를 지운다 (8.0.46·8.4.11 실측)', () => {
    const st = fresh();
    markProvenance(st, 't', ['f'], 'auto');
    renameProvenance(st, 't', 'F', 'g');
    expect(entries(st)).toEqual([['g', 'user']]);
    renameProvenance(st, 't', 'g', 'f'); // 원래 이름으로 되돌려도 user
    expect(entries(st)).toEqual([['f', 'user']]);
    renameProvenance(st, 't', 'unknown', 'h'); // 출처를 모르던 인덱스도 바꾸면 user 로 안다
    expect(entries(st)).toEqual([['f', 'user'], ['h', 'user']]);
  });

  it('syncProvenance: 남은 인덱스만 두고, 문장 시작에 덤프로 가린 auto·ambiguous 는 굳히며, 이 실행이 정한 값이 먼저다', () => {
    const st = fresh();
    markProvenance(st, 't', ['kept', 'gone', 'f'], 'user');
    const t = tableOf([plain('kept', 'x0'), plain('f', 'x0'), plain('a', 'x1'), plain('b', 'x1'), plain('c', 'x1')], []);
    syncProvenance(st, 't', t, { generated: new Set(['a', 'f']), ambiguous: new Set(['b']) });
    expect(entries(st)).toEqual([['kept', 'user'], ['f', 'user'], ['a', 'auto'], ['b', 'ambiguous']]); // gone 은 사라지고 c 는 모른다, f 는 이미 user 로 안다
  });

  it('syncProvenance: 출처를 모르는 채 FK 를 받치는 인덱스는 user 로 적는다 — 이미 있던 인덱스가 새 FK 를 받쳐도 FK 가 만든 것으로 오해하지 않는다', () => {
    const st = fresh();
    const t = tableOf([plain('x0', 'x0'), plain('ka', 'x1')], [fkOf('t_ibfk_1')]); // 이름이 첫 컬럼이고 FK 이름이 자동 꼴: 덤프만 보면 알 수 없는 꼴
    syncProvenance(st, 't', t, { generated: new Set(), ambiguous: new Set() });
    expect(entries(st)).toEqual([['x0', 'user']]); // FK 를 받치지 않는 ka 는 모른다
    markProvenance(st, 't', ['x0'], 'auto');
    syncProvenance(st, 't', t, { generated: new Set(), ambiguous: new Set() });
    expect(entries(st)).toEqual([['x0', 'auto']]); // 아는 출처가 먼저
    const covered = tableOf([plain('a', 'x0'), plain('b', 'x0')], [fkOf('t_ibfk_1')]); // 같은 모양이 둘이면 FK 의 자동 인덱스 후보가 아니다
    syncProvenance(st, 't', covered, { generated: new Set(), ambiguous: new Set() });
    expect(entries(st)).toEqual([]);
  });
});
