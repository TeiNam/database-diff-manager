import { describe, expect, it } from 'vitest';
import { addForeignKey, addIndex, addKeys, checkTable, dropKeys, ensureFkIndexes, exprUses, nextFkName, remapKeys, renameIndex, setIndexVisibility, sortIndexes, uniqueIndexName } from '../../src/apply/keys';
import { initialState, type State } from '../../src/apply/state';
import { DEFAULT_SQL_MODE, MYSQL_DEFAULTS, RE_EXPORT, type FkItem, type IndexItem } from '../../src/apply/types';
import type { IndexKind, Table } from '../../src/model';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

const DUMP = tdExport([
  'CREATE TABLE `parent` (\n  `id` int unsigned NOT NULL,\n  `code` varchar(10) NOT NULL,\n  `note` text,\n  PRIMARY KEY (`id`),\n  KEY `code` (`code`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  'CREATE TABLE `child` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `pid` int unsigned DEFAULT NULL,\n  `name` varchar(20) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `pid` (`pid`),\n  CONSTRAINT `child_ibfk_1` FOREIGN KEY (`pid`) REFERENCES `parent` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
].join('\n\n'));
const fresh = (): State => initialState(parseSqlDump(DUMP).model, 'shop', MYSQL_DEFAULTS, DEFAULT_SQL_MODE);
const table = (st: State, name: string): Table => st.model.tables.find((t) => t.name === name)!;
const idx = (name: string, kind: IndexKind, cols: string[], named = true, length?: number): IndexItem =>
  ({ kind: 'index', named, index: { name, kind, parts: cols.map((column) => ({ column, desc: false, ...(length ? { length } : {}) })), invisible: false } });
const fk = (named: boolean, columns: string[], refTable: string, refColumns: string[], name = ''): FkItem => ({ kind: 'fk', named, fk: { name, columns, refTable, refColumns } });

describe('이름 짓기', () => {
  it('자동 인덱스 이름은 첫 컬럼, 겹치면 _2 …; FK 는 <테이블>_ibfk_<최대+1>', () => {
    const st = fresh();
    expect(uniqueIndexName(table(st, 'parent'), 'code')).toBe('code_2');
    expect(uniqueIndexName(table(st, 'parent'), 'note')).toBe('note');
    expect(nextFkName(table(st, 'child'))).toBe('child_ibfk_2');
  });
});

describe('addIndex', () => {
  it('InnoDB 의 USING HASH 는 지우고 USING BTREE 는 남긴다', () => {
    const st = fresh();
    const hash = idx('h', 'INDEX', ['name']);
    expect(addIndex(table(st, 'child'), { ...hash, index: { ...hash.index, using: 'HASH' } }).indexes.at(-1)!.using).toBeUndefined();
    expect(addIndex(table(st, 'child'), { ...hash, index: { ...hash.index, using: 'BTREE' } }).indexes.at(-1)!.using).toBe('BTREE');
  });

  it('이름 없는 UNIQUE 는 첫 컬럼 이름, PRIMARY KEY 는 컬럼을 NOT NULL 로 만든다', () => {
    const st = fresh();
    expect(addIndex(table(st, 'child'), idx('', 'UNIQUE', ['name'], false)).indexes.at(-1)).toMatchObject({ name: 'name', kind: 'UNIQUE' });
    const p = addIndex(dropKeys(table(st, 'child'), [{ what: 'primary', name: 'PRIMARY' }]), idx('PRIMARY', 'PRIMARY', ['name']));
    const name = p.columns.find((c) => c.name === 'name')!;
    expect(name.nullable).toBe(false);
    expect(name.default).toBeUndefined();
  });

  it.each([
    ['child', idx('PRIMARY', 'PRIMARY', ['name']), /1068/],
    ['child', idx('x', 'INDEX', ['nope']), /1072/],
    ['child', idx('pid', 'INDEX', ['name']), /1061/],
    ['parent', idx('n', 'INDEX', ['note']), /1170/],
    ['parent', idx('n', 'INDEX', ['code'], true, 20), /1089/],
    ['parent', idx('f', 'FULLTEXT', ['id']), /1283/],
  ] as const)('%s %j 는 거부', (name, item, re) => {
    const st = fresh();
    expect(() => addIndex(table(st, name), item)).toThrow(re);
  });
});

describe('addForeignKey / ensureFkIndexes', () => {
  it('이름 없는 FK 는 다음 ibfk 번호, 받치는 인덱스가 없으면 자동 인덱스 (CONSTRAINT 이름 또는 첫 컬럼)', () => {
    const st = fresh();
    const c = table(st, 'child');
    const withCol: Table = { ...c, columns: [...c.columns, { name: 'pid2', type: 'int unsigned', nullable: true, invisible: false, autoIncrement: false, default: 'NULL' }] };
    const unnamed = addForeignKey(st, withCol, fk(false, ['pid2'], 'parent', ['id']));
    expect(unnamed.foreignKeys.at(-1)!.name).toBe('child_ibfk_2');
    expect(ensureFkIndexes(unnamed, [{ name: 'child_ibfk_2', named: false }]).indexes.at(-1)).toMatchObject({ name: 'pid2', parts: [{ column: 'pid2' }] });
    const named = addForeignKey(st, withCol, fk(true, ['pid2'], 'parent', ['id'], 'fk_p2'));
    expect(ensureFkIndexes(named, [{ name: 'fk_p2', named: true }]).indexes.at(-1)!.name).toBe('fk_p2');
    expect(ensureFkIndexes(named, [{ name: 'fk_p2', indexName: 'ix_p2', named: true }]).indexes.at(-1)!.name).toBe('fk_p2'); // CONSTRAINT 이름이 먼저
    expect(ensureFkIndexes(unnamed, [{ name: 'child_ibfk_2', indexName: 'ix_p2', named: false }]).indexes.at(-1)!.name).toBe('ix_p2');
    const reuse = addForeignKey(st, c, fk(true, ['pid'], 'parent', ['id'], 'fk_again'));
    expect(ensureFkIndexes(reuse, [{ name: 'fk_again', named: true }]).indexes).toHaveLength(c.indexes.length); // KEY pid 가 받친다
  });

  it('부모 없음(FOREIGN_KEY_CHECKS=1)·타입 다름·표준 키 아님·이름 겹침은 거부, FOREIGN_KEY_CHECKS=0 이면 부모가 없어도 된다', () => {
    const st = fresh();
    const c = table(st, 'child');
    expect(() => addForeignKey(st, c, fk(false, ['pid'], 'nope', ['id']))).toThrow(/1824/);
    expect(() => addForeignKey(st, c, fk(false, ['id'], 'parent', ['id']))).toThrow(/3780/); // int ↔ int unsigned
    expect(() => addForeignKey(st, c, fk(false, ['name'], 'parent', ['code']))).toThrow(/6125/); // KEY code 는 UNIQUE 가 아니다
    expect(() => addForeignKey(st, c, fk(true, ['pid'], 'parent', ['id'], 'child_ibfk_1'))).toThrow(/1826/);
    st.fkChecks = false;
    expect(addForeignKey(st, c, fk(false, ['pid'], 'nope', ['id'])).foreignKeys).toHaveLength(2);
  });

  it('addKeys: 정의를 차례로 붙이고 붙인 FK 에 받치는 인덱스를 만든다', () => {
    const st = fresh();
    const c = table(st, 'child');
    const t = addKeys(st, c, [idx('ix_name', 'INDEX', ['name'])]);
    expect(t.indexes.map((i) => i.name)).toEqual(['PRIMARY', 'pid', 'ix_name']);
    const withFk = addKeys(st, { ...c, columns: [...c.columns, { name: 'pid2', type: 'int unsigned', nullable: true, invisible: false, autoIncrement: false, default: 'NULL' }] }, [fk(false, ['pid2'], 'parent', ['id'])]);
    expect(withFk.foreignKeys.at(-1)!.name).toBe('child_ibfk_2');
    expect(withFk.indexes.at(-1)!.name).toBe('pid2');
  });
});

describe('삭제·이름 반영·검사·순서', () => {
  it('dropKeys: DROP INDEX `PRIMARY` 도 PK 를 지우고, 없는 키는 1091·3821', () => {
    const st = fresh();
    expect(dropKeys(table(st, 'child'), [{ what: 'index', name: 'primary' }]).indexes.some((i) => i.kind === 'PRIMARY')).toBe(false);
    expect(() => dropKeys(table(st, 'child'), [{ what: 'index', name: 'nope' }])).toThrow(/1091/);
    expect(() => dropKeys(table(st, 'child'), [{ what: 'check', name: 'nope' }])).toThrow(/3821/);
  });

  it('remapKeys: 지운 컬럼은 키 파트에서 빠지고(다 빠지면 인덱스도 없어진다) 바뀐 이름은 따라간다', () => {
    const st = fresh();
    const c = table(st, 'child');
    const t: Table = { ...c, indexes: [...c.indexes, { name: 'pn', kind: 'INDEX', parts: [{ column: 'pid', desc: false }, { column: 'name', desc: false }], invisible: false }, { name: 'only_name', kind: 'INDEX', parts: [{ column: 'name', desc: false }], invisible: false }] };
    const r = remapKeys(t, new Set(['name']), new Map([['pid', 'parent_id']]));
    expect(r.indexes.find((i) => i.name === 'pn')!.parts).toEqual([{ column: 'parent_id', desc: false }]);
    expect(r.indexes.some((i) => i.name === 'only_name')).toBe(false);
    expect(r.foreignKeys[0].columns).toEqual(['parent_id']);
  });

  it('checkTable: FK 를 받치는 인덱스·부모 키를 지우면 1553, 키 없는 AUTO_INCREMENT 는 1075', () => {
    const st = fresh();
    expect(() => checkTable(st, dropKeys(table(st, 'child'), [{ what: 'index', name: 'pid' }]))).toThrow(/1553/);
    expect(() => checkTable(st, dropKeys(table(st, 'parent'), [{ what: 'primary', name: 'PRIMARY' }]))).toThrow(/1553/);
    expect(() => checkTable(st, dropKeys(table(st, 'child'), [{ what: 'primary', name: 'PRIMARY' }]))).toThrow(/1075/);
  });

  it('sortIndexes: UNIQUE(NULL 없음) → UNIQUE(NULL 있음) → 일반 → FULLTEXT, 같은 무리는 원래 순서', () => {
    const st = fresh();
    let t = addIndex(table(st, 'child'), idx('ft', 'FULLTEXT', ['name']));
    t = addIndex(t, idx('u_name', 'UNIQUE', ['name']));
    t = addIndex(t, idx('u_id', 'UNIQUE', ['id']));
    expect(sortIndexes(t).map((i) => i.name)).toEqual(['PRIMARY', 'u_id', 'u_name', 'pid', 'ft']);
  });
});

describe('스키마 한정자·인덱스 이름 변경·보이기·식 검사', () => {
  it('addForeignKey: 현재 스키마 한정자는 지우고, 다른 스키마는 재추출 안내와 함께 거부', () => {
    const st = fresh();
    const c = table(st, 'child');
    const qualified = (refSchema: string): FkItem => ({ kind: 'fk', named: true, fk: { name: 'fk_q', columns: ['pid'], refSchema, refTable: 'parent', refColumns: ['id'] } });
    expect(addForeignKey(st, c, qualified('shop')).foreignKeys.at(-1)).not.toHaveProperty('refSchema');
    expect(() => addForeignKey(st, c, qualified('other'))).toThrow(RE_EXPORT);
  });

  it('renameIndex·setIndexVisibility: 대상만 바꾸고 입력은 그대로 두며, PRIMARY·없는 인덱스·겹치는 이름은 거부', () => {
    const st = fresh();
    const c = table(st, 'child');
    expect(renameIndex(c, 'PID', 'pid_x').indexes.map((i) => i.name)).toEqual(['PRIMARY', 'pid_x']);
    expect(c.indexes.map((i) => i.name)).toEqual(['PRIMARY', 'pid']);
    expect(() => renameIndex(c, 'nope', 'x')).toThrow(/1176/);
    expect(() => renameIndex(c, 'pid', 'PRIMARY')).toThrow(/1280/);
    expect(() => renameIndex(c, 'PRIMARY', 'x')).toThrow(/1280/);
    const two = addIndex(c, idx('ix_name', 'INDEX', ['name']));
    expect(() => renameIndex(two, 'pid', 'IX_NAME')).toThrow(/1061/);
    expect(renameIndex(two, 'pid', 'PID').indexes[1].name).toBe('PID'); // 대소문자만 바꾸는 이름 변경은 허용
    expect(setIndexVisibility(c, 'pid', true).indexes.find((i) => i.name === 'pid')!.invisible).toBe(true);
    expect(c.indexes.every((i) => !i.invisible)).toBe(true);
    expect(() => setIndexVisibility(c, 'primary', true)).toThrow(/3522/);
    expect(() => setIndexVisibility(c, 'nope', true)).toThrow(/1176/);
  });

  it('exprUses: 백틱 식별자만 컬럼으로 본다 (문자열·부분 일치 제외)', () => {
    expect(exprUses('(`a` + `B`)', 'b')).toBe(true);
    expect(exprUses("concat('a',`ab`)", 'a')).toBe(false);
    expect(exprUses('(`a` + 1)', 'ab')).toBe(false);
  });

  it('checkTable: 이 문장에서 바뀐 컬럼 이름(renamed)으로 다른 테이블 FK 의 옛 참조 이름을 따라가고, 보이는 컬럼이 없으면 4028', () => {
    const st = fresh();
    const p = table(st, 'parent');
    const renamedParent = remapKeys(p, new Set(), new Map([['id', 'pk']]));
    expect(() => checkTable(st, renamedParent)).toThrow(/1553/);
    expect(() => checkTable(st, renamedParent, new Map([['id', 'pk']]))).not.toThrow();
    expect(() => checkTable(st, { ...p, columns: p.columns.map((c) => ({ ...c, invisible: true })) })).toThrow(/4028/);
  });
});
