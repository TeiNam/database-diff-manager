import { describe, expect, it } from 'vitest';
import { addForeignKey, addIndex, addKeys, assertReaddedKeysFit, checkNowNotNull, checkSetNullFks, checkTable, columnKeyItems, dropKeys, ensureFkIndexes, enforcePrimaryKeyNotNull, exprUses, leadsWith, nextFkName, refitKeyParts, remapKeys, renameIndex, setIndexVisibility, sortForeignKeys, sortIndexes, uniqueIndexName } from '../../src/apply/keys';
import { planAutoKeys } from '../../src/apply/auto-index';
import { initialState, replaceTable, type State } from '../../src/apply/state';
import { DEFAULT_SQL_MODE, MYSQL_DEFAULTS, RE_EXPORT, type ColumnSpec, type FkItem, type IndexItem } from '../../src/apply/types';
import type { Column, ForeignKey, Index, IndexKind, Table } from '../../src/model';
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
const col = (name: string, type: string): Column => ({ name, type, nullable: true, invisible: false, autoIncrement: false, default: 'NULL' });
const withColumns = (t: Table, ...cols: Column[]): Table => ({ ...t, columns: [...t.columns, ...cols] });
const retype = (t: Table, name: string, type: string): Table => ({ ...t, columns: t.columns.map((c) => (c.name === name ? { ...c, type } : c)) });
const withActions = (item: FkItem, actions: Pick<ForeignKey, 'onDelete' | 'onUpdate'>): FkItem => ({ ...item, fk: { ...item.fk, ...actions } });
const keyOf = (...parts: [column: string, desc: boolean][]): Index => ({ name: 'k', kind: 'INDEX', parts: parts.map(([column, desc]) => ({ column, desc })), invisible: false });

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

  it('ENGINE 옵션이 없는 테이블도 InnoDB 로 보아 USING HASH 를 지운다 (options.ts 와 같은 판단)', () => {
    const st = fresh();
    const hash = idx('h', 'INDEX', ['name']);
    const noEngine = { ...table(st, 'child'), options: table(st, 'child').options.filter((o) => o.key !== 'ENGINE') };
    expect(addIndex(noEngine, { ...hash, index: { ...hash.index, using: 'HASH' } }).indexes.at(-1)!.using).toBeUndefined();
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

describe('키 파트 길이 — SHOW CREATE 에 찍히지 않는 길이는 남기지 않는다 (MySQL 8.0.46 실측)', () => {
  it('addIndex: 컬럼 길이와 같은 prefix 길이는 지우고, 짧은 길이와 TEXT 의 길이는 남긴다', () => {
    const p = withColumns(table(fresh(), 'parent'), col('c5', 'char(5)'), col('vb', 'varbinary(8)'), col('b4', 'binary(4)'));
    const partsOf = (kind: IndexKind, column: string, length: number) => addIndex(p, idx(`k_${column}_${length}`, kind, [column], true, length)).indexes.at(-1)!.parts;
    expect(partsOf('INDEX', 'code', 10)).toEqual([{ column: 'code', desc: false }]); // varchar(10)
    expect(partsOf('UNIQUE', 'c5', 5)).toEqual([{ column: 'c5', desc: false }]); // char(5)
    expect(partsOf('INDEX', 'vb', 8)).toEqual([{ column: 'vb', desc: false }]); // varbinary(8)
    expect(partsOf('INDEX', 'b4', 4)).toEqual([{ column: 'b4', desc: false }]); // binary(4)
    expect(partsOf('INDEX', 'code', 9)).toEqual([{ column: 'code', desc: false, length: 9 }]); // 컬럼보다 짧으면 진짜 prefix
    expect(partsOf('INDEX', 'note', 255)).toEqual([{ column: 'note', desc: false, length: 255 }]); // TEXT 의 길이는 늘 찍힌다
    const mixed: IndexItem = { kind: 'index', named: true, index: { name: 'k_mixed', kind: 'INDEX', parts: [{ column: 'code', desc: true, length: 10 }, { column: 'c5', desc: false, length: 3 }], invisible: false } };
    expect(addIndex(p, mixed).indexes.at(-1)!.parts).toEqual([{ column: 'code', desc: true }, { column: 'c5', desc: false, length: 3 }]); // 파트마다 따로 보고 DESC 는 그대로
  });

  it('addIndex: FULLTEXT 는 길이를 받아도 SHOW CREATE 에 찍지 않으므로 지운다 (컬럼보다 길어도 MySQL 은 받는다)', () => {
    const p = table(fresh(), 'parent');
    expect(addIndex(p, idx('ft_code', 'FULLTEXT', ['code'], true, 20)).indexes.at(-1)!.parts).toEqual([{ column: 'code', desc: false }]);
    expect(addIndex(p, idx('ft_note', 'FULLTEXT', ['note'], true, 5)).indexes.at(-1)!.parts).toEqual([{ column: 'note', desc: false }]);
  });

  it('길이를 지운 인덱스는 FK 를 받친다 (KEY (c(10)) 가 varchar(10) 전체 키라 자동 인덱스를 따로 만들지 않는다)', () => {
    const c = withColumns(table(fresh(), 'child'), col('c10', 'varchar(10)'));
    expect(leadsWith(addIndex(c, idx('kc', 'INDEX', ['c10'], true, 10)).indexes.at(-1)!, ['c10'])).toBe(true);
  });
});

describe('FK 를 받치는 인덱스의 정렬 방향 (MySQL 8.0.46 실측)', () => {
  it('leadsWith: 새 FK 를 받치려면 FK 컬럼에 해당하는 앞쪽 파트가 모두 ASC 여야 한다 (뒤쪽 파트의 DESC 는 상관없다)', () => {
    expect(leadsWith(keyOf(['a', false]), ['a'])).toBe(true);
    expect(leadsWith(keyOf(['a', true]), ['a'])).toBe(false);
    expect(leadsWith(keyOf(['a', false], ['b', true]), ['a'])).toBe(true);
    expect(leadsWith(keyOf(['a', true], ['b', false]), ['a'])).toBe(false);
    expect(leadsWith(keyOf(['a', false], ['b', true]), ['a', 'b'])).toBe(false);
  });

  it('ensureFkIndexes: FK 컬럼에 DESC 인덱스뿐이면 받치는 인덱스를 새로 만든다', () => {
    const st = fresh();
    const c = table(st, 'child');
    const descOnly: Table = { ...c, indexes: c.indexes.map((i) => (i.name === 'pid' ? { ...i, parts: [{ column: 'pid', desc: true }] } : i)) };
    const next = ensureFkIndexes(addForeignKey(st, descOnly, fk(true, ['pid'], 'parent', ['id'], 'fk_desc')), [{ name: 'fk_desc', named: true }]);
    expect(next.indexes.map((i) => i.name)).toEqual(['PRIMARY', 'pid', 'fk_desc']);
    expect(next.indexes.at(-1)!.parts).toEqual([{ column: 'pid', desc: false }]);
  });

  it('부모의 참조 키와 문장 끝 검사는 방향을 보지 않는다 (PRIMARY KEY (id DESC) 도 참조 키이고, 마지막 키를 지우면 1553, ASC 를 지우고 DESC 를 더해도 FK 는 남는다)', () => {
    const st = fresh();
    const p = table(st, 'parent');
    const descParent: Table = { ...p, indexes: p.indexes.map((i) => (i.kind === 'PRIMARY' ? { ...i, parts: [{ column: 'id', desc: true }] } : i)) };
    replaceTable(st, 'parent', descParent);
    expect(() => checkTable(st, descParent)).not.toThrow(); // child_ibfk_1 은 PRIMARY KEY (id DESC) 를 참조 키로 쓴다
    expect(() => addForeignKey(st, table(st, 'child'), fk(true, ['pid'], 'parent', ['id'], 'fk_again'))).not.toThrow();
    expect(() => checkTable(st, dropKeys(descParent, [{ what: 'primary', name: 'PRIMARY' }]))).toThrow(/1553/);
    const c = table(st, 'child');
    const descChild: Table = { ...c, indexes: c.indexes.map((i) => (i.name === 'pid' ? { ...i, parts: [{ column: 'pid', desc: true }] } : i)) };
    expect(() => checkTable(st, descChild)).not.toThrow(); // DROP INDEX pid, ADD INDEX (pid DESC) 한 문장도 MySQL 이 받는다
  });
});

describe('addForeignKey — 타입 비교·키 중복·SET NULL·부모 상태 (MySQL 8.0.46 실측)', () => {
  it('정수 표시 폭은 타입 비교에 쓰지 않는다 (tinyint(1) ↔ tinyint, 5.7 덤프의 int(11) ↔ int). 부호·크기가 다르면 여전히 3780', () => {
    const st = fresh();
    const p = table(st, 'parent');
    const c = table(st, 'child');
    const fkItem = fk(true, ['pid'], 'parent', ['id'], 'fk_w');
    replaceTable(st, 'parent', retype(p, 'id', 'tinyint'));
    expect(() => addForeignKey(st, retype(c, 'pid', 'tinyint(1)'), fkItem)).not.toThrow();
    replaceTable(st, 'parent', retype(p, 'id', 'int(11) unsigned'));
    expect(() => addForeignKey(st, c, fkItem)).not.toThrow(); // child.pid 는 int unsigned
    expect(() => addForeignKey(st, retype(c, 'pid', 'int(11)'), fkItem)).toThrow(/3780/); // 부호가 다르다
    replaceTable(st, 'parent', retype(p, 'id', 'smallint'));
    expect(() => addForeignKey(st, retype(c, 'pid', 'tinyint(1)'), fkItem)).toThrow(/3780/); // 크기가 다르다
  });

  it('한 키에 같은 컬럼을 두 번 쓰면 1060 (인덱스는 종류와 대소문자에 상관없이, FK 는 부모 검사보다 먼저)', () => {
    const st = fresh();
    const c = table(st, 'child');
    expect(() => addIndex(c, idx('d1', 'INDEX', ['name', 'name']))).toThrow(/1060/);
    expect(() => addIndex(c, idx('d2', 'UNIQUE', ['name', 'NAME']))).toThrow(/1060/);
    expect(() => addIndex(c, idx('d3', 'FULLTEXT', ['name', 'name']))).toThrow(/1060/);
    expect(() => addIndex(dropKeys(c, [{ what: 'primary', name: 'PRIMARY' }]), idx('PRIMARY', 'PRIMARY', ['id', 'ID']))).toThrow(/1060/);
    expect(() => addForeignKey(st, c, fk(false, ['pid', 'PID'], 'nope', ['id', 'id']))).toThrow(/1060/);
    expect(addIndex(c, idx('ok', 'INDEX', ['name', 'pid'])).indexes.at(-1)!.parts).toHaveLength(2);
  });

  it('ON DELETE·ON UPDATE SET NULL 은 NOT NULL 컬럼에 쓸 수 없다 (1830 — 타입 검사 3780·부모 없음 1824 보다 먼저)', () => {
    const st = fresh();
    const c = table(st, 'child');
    const notNull = fk(true, ['id'], 'parent', ['id'], 'fk_sn'); // child.id 는 NOT NULL (int ↔ int unsigned 라 3780 이기도 하지만 1830 이 먼저)
    expect(() => addForeignKey(st, c, withActions(notNull, { onDelete: 'SET NULL' }))).toThrow(/1830/);
    expect(() => addForeignKey(st, c, withActions(notNull, { onUpdate: 'SET NULL' }))).toThrow(/1830/);
    expect(() => addForeignKey(st, c, withActions(notNull, { onDelete: 'CASCADE', onUpdate: 'SET NULL' }))).toThrow(/1830/);
    expect(() => addForeignKey(st, c, withActions(fk(true, ['id'], 'nope', ['id'], 'fk_sn'), { onDelete: 'SET NULL' }))).toThrow(/1830/);
    expect(() => addForeignKey(st, c, withActions(fk(true, ['pid', 'id'], 'parent', ['id', 'code'], 'fk_sn'), { onDelete: 'SET NULL' }))).toThrow(/1830/); // 다중 컬럼 중 하나만 NOT NULL
    expect(() => addForeignKey(st, c, withActions(notNull, { onDelete: 'CASCADE' }))).toThrow(/3780/); // SET NULL 이 아니면 기존 검사 그대로
    const nullable = withActions(fk(true, ['pid'], 'parent', ['id'], 'fk_ok'), { onDelete: 'SET NULL', onUpdate: 'SET NULL' });
    expect(addForeignKey(st, c, nullable).foreignKeys.at(-1)).toMatchObject({ onDelete: 'SET NULL', onUpdate: 'SET NULL' }); // pid 는 NULL 허용
  });

  it('두 테이블의 문자셋은 문자열 컬럼 쌍을 비교할 때만 읽는다 (정수 FK 가 모르는 문자셋 때문에 거부되지 않는다)', () => {
    const st = fresh();
    const c = table(st, 'child');
    const odd: Table = { ...c, options: [{ key: 'ENGINE', value: 'InnoDB' }, { key: 'DEFAULT CHARSET', value: 'latin5' }] }; // 지원 문자셋 목록에 없다
    expect(() => addForeignKey(st, odd, fk(true, ['pid'], 'parent', ['id'], 'fk_odd'))).not.toThrow();
    replaceTable(st, 'parent', addIndex(table(st, 'parent'), idx('u_code', 'UNIQUE', ['code'])));
    expect(() => addForeignKey(st, odd, fk(true, ['name'], 'parent', ['code'], 'fk_odd2'))).toThrow(/1115/); // 문자열 쌍은 비교하려고 읽는다
  });

  it('부모가 파싱하지 못한 정의면 3734 대신 재추출 안내로 거부한다 (FOREIGN_KEY_CHECKS=0 이어도)', () => {
    const st = fresh();
    replaceTable(st, 'parent', { kind: 'table', name: 'parent', columns: [], indexes: [], foreignKeys: [], checks: [], options: [], fidelity: 'full', parseError: '해석 실패', rawDdl: 'CREATE TABLE parent (' });
    const c = table(st, 'child');
    expect(() => addForeignKey(st, c, fk(true, ['pid'], 'parent', ['id'], 'fk_pe'))).toThrow(RE_EXPORT);
    expect(() => addForeignKey(st, c, fk(true, ['pid'], 'parent', ['id'], 'fk_pe'))).not.toThrow(/3734/);
    st.fkChecks = false;
    expect(() => addForeignKey(st, c, fk(true, ['pid'], 'parent', ['id'], 'fk_pe'))).toThrow(RE_EXPORT);
  });
});

describe('컬럼을 바꾼 뒤 키 맞춤 (MySQL 8.0.46·8.4.11 실측: ALTER TABLE … MODIFY)', () => {
  // child.name 은 varchar(20): KEY kp (name(10)), 함수 인덱스 파트 하나가 섞인 KEY kf
  const prefixed = (): Table => {
    const c = addIndex(table(fresh(), 'child'), idx('kp', 'INDEX', ['name'], true, 10));
    return { ...c, indexes: [...c.indexes, { name: 'kf', kind: 'INDEX', parts: [{ expr: '`id` + 1', desc: false }, { column: 'name', length: 5, desc: true }], invisible: false }] };
  };
  const lengthsOf = (t: Table, index: string) => t.indexes.find((i) => i.name === index)!.parts.map((p) => p.length);

  it('refitKeyParts: 새 길이가 prefix 이하이거나 prefix 를 가질 수 없는 타입이면 길이를 지우고, 더 길면 남긴다 (바꾸지 않은 컬럼은 그대로)', () => {
    const changed = new Set(['name']);
    expect(lengthsOf(refitKeyParts(retype(prefixed(), 'name', 'varchar(10)'), changed), 'kp')).toEqual([undefined]);
    expect(lengthsOf(refitKeyParts(retype(prefixed(), 'name', 'varchar(3)'), changed), 'kp')).toEqual([undefined]);
    expect(lengthsOf(refitKeyParts(retype(prefixed(), 'name', 'int'), changed), 'kp')).toEqual([undefined]);
    expect(lengthsOf(refitKeyParts(retype(prefixed(), 'name', 'varchar(11)'), changed), 'kp')).toEqual([10]);
    expect(lengthsOf(refitKeyParts(retype(prefixed(), 'name', 'text'), changed), 'kp')).toEqual([10]);
    expect(lengthsOf(refitKeyParts(retype(prefixed(), 'name', 'varchar(3)'), new Set()), 'kp')).toEqual([10]); // 바꾼 컬럼이 없으면 손대지 않는다
    expect(lengthsOf(refitKeyParts(retype(prefixed(), 'name', 'varchar(3)'), new Set(['id'])), 'kp')).toEqual([10]);
  });

  it('refitKeyParts: 함수 인덱스의 식 파트(column 없음)는 건너뛰고, 입력 테이블은 바꾸지 않는다', () => {
    const t = retype(prefixed(), 'name', 'varchar(5)');
    const before = JSON.stringify(t);
    const next = refitKeyParts(t, new Set(['name']));
    expect(next.indexes.find((i) => i.name === 'kf')!.parts).toEqual([{ expr: '`id` + 1', desc: false }, { column: 'name', desc: true }]);
    expect(JSON.stringify(t)).toBe(before);
  });

  it('refitKeyParts: 새 타입이 키에 맞지 않으면 거부한다 (길이 없는 TEXT·BLOB 1170, JSON 3152, 문자열이 아닌 FULLTEXT 1283)', () => {
    const p = table(fresh(), 'parent'); // KEY code (code) — 길이 없는 키
    expect(() => refitKeyParts(retype(p, 'code', 'text'), new Set(['code']))).toThrow(/1170/);
    expect(() => refitKeyParts(retype(p, 'code', 'json'), new Set(['code']))).toThrow(/3152/);
    expect(() => refitKeyParts(retype(prefixed(), 'name', 'json'), new Set(['name']))).toThrow(/3152/); // prefix 는 먼저 없어진다
    expect(() => refitKeyParts(retype(p, 'code', 'int'), new Set(['code']))).not.toThrow();
    const ft = addIndex(p, idx('ft', 'FULLTEXT', ['note']));
    expect(() => refitKeyParts(retype(ft, 'note', 'int'), new Set(['note']))).toThrow(/1283/);
    expect(() => refitKeyParts(retype(ft, 'note', 'mediumtext'), new Set(['note']))).not.toThrow();
    expect(() => refitKeyParts(retype(p, 'code', 'text'), new Set())).not.toThrow(); // 바꾼 컬럼으로 신고하지 않은 컬럼은 검사하지 않는다
  });
});

describe('checkNowNotNull — NULL 허용이던 컬럼이 NOT NULL 이 된 SET NULL FK (MySQL 1830)', () => {
  // child.pid: int unsigned NULL. child_ibfk_1 은 ON DELETE SET NULL 로 바꿔 쓴다
  const setNull = (t: Table, onDelete = 'SET NULL'): Table => ({ ...t, foreignKeys: t.foreignKeys.map((f) => ({ ...f, onDelete })) });
  const notNull = (t: Table, name: string): Table => ({ ...t, columns: t.columns.map((c) => (c.name === name ? { ...c, nullable: false } : c)) });
  const renamedCol = (t: Table, from: string, to: string): Table => ({
    ...t, columns: t.columns.map((c) => (c.name === from ? { ...c, name: to } : c)), foreignKeys: t.foreignKeys.map((f) => ({ ...f, columns: f.columns.map((n) => (n === from ? to : n)) })),
  });

  it('이 문장에서 NOT NULL 이 된 컬럼이 SET NULL FK 에 있으면 거부하고, 이미 NOT NULL 이던 컬럼·SET NULL 이 아닌 FK 는 건드리지 않는다', () => {
    const before = setNull(table(fresh(), 'child'));
    expect(() => checkNowNotNull(before, notNull(before, 'pid'), new Map())).toThrow(/child_ibfk_1.*1830/);
    expect(() => checkNowNotNull(before, notNull(before, 'name'), new Map())).not.toThrow(); // FK 밖 컬럼
    expect(() => checkNowNotNull(before, before, new Map())).not.toThrow(); // 바뀐 것 없음
    const cascade = setNull(table(fresh(), 'child'), 'CASCADE');
    expect(() => checkNowNotNull(cascade, notNull(cascade, 'pid'), new Map())).not.toThrow();
    const alreadyBad = notNull(before, 'pid'); // 기준이 이미 NOT NULL (MySQL 이 만들 수 없는 상태) 이면 이 문장이 바꾼 것이 아니다
    expect(() => checkNowNotNull(alreadyBad, alreadyBad, new Map())).not.toThrow();
  });

  it('이 문장이 더한 컬럼(기준에 없는 컬럼)이 NOT NULL 이 되어 SET NULL FK 에 있으면 거부한다 (ADD COLUMN x, ADD FOREIGN KEY (x) … SET NULL, ADD PRIMARY KEY (x))', () => {
    const before = table(fresh(), 'child');
    const added = { ...before, columns: [...before.columns, { ...col('x', 'int unsigned'), nullable: false }], foreignKeys: [...before.foreignKeys, { name: 'child_ibfk_2', columns: ['x'], refTable: 'parent', refColumns: ['id'], onDelete: 'SET NULL' }] };
    expect(() => checkNowNotNull(before, added, new Map())).toThrow(/child_ibfk_2.*1830/);
    const nullable = { ...added, columns: added.columns.map((c) => (c.name === 'x' ? { ...c, nullable: true } : c)) };
    expect(() => checkNowNotNull(before, nullable, new Map())).not.toThrow();
  });

  it('이름이 바뀐 컬럼도 따라간다 (renamed: 소문자 옛 이름 → 새 이름)', () => {
    const before = setNull(table(fresh(), 'child'));
    const after = notNull(renamedCol(before, 'pid', 'owner'), 'owner');
    expect(() => checkNowNotNull(before, after, new Map([['pid', 'owner']]))).toThrow(/owner/);
    expect(() => checkNowNotNull(before, renamedCol(before, 'pid', 'owner'), new Map([['pid', 'owner']]))).not.toThrow();
  });
});

describe('checkSetNullFks — SET NULL FK 의 컬럼이 NOT NULL 이면 1830 (CREATE TABLE 은 문장 앞 상태가 없다)', () => {
  const base = (): Table => ({ ...table(fresh(), 'child'), foreignKeys: [{ name: 'child_ibfk_1', columns: ['pid'], refTable: 'parent', refColumns: ['id'], onUpdate: 'SET NULL' }] });
  const notNull = (t: Table): Table => ({ ...t, columns: t.columns.map((c) => (c.name === 'pid' ? { ...c, nullable: false } : c)) });

  it('NOT NULL 이면 거부하고, NULL 허용·SET NULL 이 아닌 FK 는 건드리지 않는다', () => {
    expect(() => checkSetNullFks(notNull(base()))).toThrow(/pid.*child_ibfk_1.*1830/);
    expect(() => checkSetNullFks(base())).not.toThrow();
    const cascade = notNull({ ...base(), foreignKeys: base().foreignKeys.map((f) => ({ ...f, onUpdate: 'CASCADE' })) });
    expect(() => checkSetNullFks(cascade)).not.toThrow();
  });

  it('notNullBefore 에 든 컬럼(문장 앞에 이미 NOT NULL)은 건너뛴다', () => {
    expect(() => checkSetNullFks(notNull(base()), new Set(['pid']))).not.toThrow();
    expect(() => checkSetNullFks(notNull(base()), new Set(['other']))).toThrow(/1830/);
  });
});

describe('columnKeyItems — 컬럼 정의 안의 PRIMARY KEY·UNIQUE', () => {
  const spec = (over: Partial<ColumnSpec>): ColumnSpec => ({ name: 'c', type: 'int', autoIncrement: false, invisible: false, primaryKey: false, unique: false, ...over });

  it('PRIMARY KEY 는 PRIMARY 이름의 인덱스, UNIQUE 는 이름 없는 UNIQUE 인덱스(이름은 addIndex 가 컬럼 이름으로 짓는다), 둘 다 있으면 PRIMARY KEY 가 먼저', () => {
    expect(columnKeyItems(spec({}))).toEqual([]);
    expect(columnKeyItems(spec({ primaryKey: true }))).toEqual([{ kind: 'index', named: true, index: { name: 'PRIMARY', kind: 'PRIMARY', parts: [{ column: 'c', desc: false }], invisible: false } }]);
    expect(columnKeyItems(spec({ unique: true }))).toEqual([{ kind: 'index', named: false, index: { name: '', kind: 'UNIQUE', parts: [{ column: 'c', desc: false }], invisible: false } }]);
    expect(columnKeyItems(spec({ primaryKey: true, unique: true })).map((i) => i.index.kind)).toEqual(['PRIMARY', 'UNIQUE']);
  });
});

describe('enforcePrimaryKeyNotNull — PRIMARY KEY 컬럼은 NOT NULL (MySQL 8.0.46·8.4.11 실측)', () => {
  const nullablePk = (): Table => {
    const t = table(fresh(), 'child');
    return { ...t, columns: t.columns.map((c) => (c.name === 'id' ? { ...c, nullable: true, autoIncrement: false, default: 'NULL' } : c)) };
  };

  it('PRIMARY KEY 의 컬럼만 NOT NULL 로 만든다: DEFAULT NULL 은 없애고 다른 기본값은 남기며, 입력은 그대로다', () => {
    const t = nullablePk();
    const before = JSON.stringify(t);
    const next = enforcePrimaryKeyNotNull(t);
    expect(next.columns.find((c) => c.name === 'id')).toEqual({ name: 'id', type: 'int', nullable: false, invisible: false, autoIncrement: false });
    expect(next.columns.find((c) => c.name === 'name')).toEqual(t.columns.find((c) => c.name === 'name')); // PK 밖 컬럼은 그대로
    expect(JSON.stringify(t)).toBe(before);
    const withDefault: Table = { ...t, columns: t.columns.map((c) => (c.name === 'id' ? { ...c, default: "'7'" } : c)) };
    expect(enforcePrimaryKeyNotNull(withDefault).columns.find((c) => c.name === 'id')).toMatchObject({ nullable: false, default: "'7'" });
  });

  it('PRIMARY KEY 가 없으면 아무것도 하지 않는다', () => {
    const noPk: Table = { ...table(fresh(), 'child'), indexes: [] };
    expect(enforcePrimaryKeyNotNull(noPk, new Set(['id']))).toBe(noPk);
  });

  it('NULL 을 명시한 컬럼(explicitNull, 소문자)이 PRIMARY KEY 에 있으면 1171, 다른 컬럼이면 상관없다', () => {
    expect(() => enforcePrimaryKeyNotNull(nullablePk(), new Set(['id']))).toThrow(/1171/);
    expect(() => enforcePrimaryKeyNotNull(nullablePk(), new Set(['name']))).not.toThrow();
  });
});

describe('FK 정렬·자동 번호 (MySQL 8.0.46·8.4.11 실측)', () => {
  const fkNamed = (name: string): ForeignKey => ({ name, columns: ['pid'], refTable: 'parent', refColumns: ['id'] });
  const sortedNames = (names: string[]) => sortForeignKeys(names.map(fkNamed)).map((f) => f.name);

  // SHOW CREATE 가 찍은 순서: 제약 이름을 소문자로 바꿔 코드 포인트 순 (선언 순서와 상관없다)
  it.each([
    [['fkc', 'fk_b', 'fka'], ['fk_b', 'fka', 'fkc']], // '_' < 글자
    [['fk1', 'fk_1', 'fk_a', 'fka', 'fk0'], ['fk0', 'fk1', 'fk_1', 'fk_a', 'fka']], // 숫자 < '_' < 글자
    [['t_ibfk_10', 't_ibfk_2', 't_ibfk_1', 't_ibfk_9', 't_ibfk_20', 't_ibfk_100'], ['t_ibfk_1', 't_ibfk_10', 't_ibfk_100', 't_ibfk_2', 't_ibfk_20', 't_ibfk_9']], // 숫자로 읽지 않는다
    [['Zeta', 'alpha', 'Beta', 'gamma', 'ALPHA2', 'beta_1', 'Beta0', 'aLPHA_'], ['alpha', 'ALPHA2', 'aLPHA_', 'Beta', 'Beta0', 'beta_1', 'gamma', 'Zeta']], // 대소문자 무시
    [['a_1', 'a1', 'a_a', 'aa', 'a0', 'a$', 'a-', 'a.', 'a[', 'a^', 'a~', 'a]', 'a@', 'a#'], ['a#', 'a$', 'a-', 'a.', 'a0', 'a1', 'a@', 'a[', 'a]', 'a^', 'a_1', 'a_a', 'aa', 'a~']], // ASCII 구두점은 코드 포인트 순
    [['a9', 'aa', 'a10', 'a1', 'ab', 'A2', 'b0'], ['a1', 'a10', 'A2', 'a9', 'aa', 'ab', 'b0']],
    [['fk_회원', 'fk_주문', 'fk_가', 'fk_힣', 'fk_a', 'fk_z'], ['fk_a', 'fk_z', 'fk_가', 'fk_주문', 'fk_회원', 'fk_힣']], // 한글은 코드 포인트 순
    [['한', '漢', 'あ', 'ア', '가'], ['あ', 'ア', '漢', '가', '한']],
  ])('sortForeignKeys %j', (names, expected) => {
    expect(sortedNames(names)).toEqual(expected);
    expect(sortedNames([...names].reverse())).toEqual(expected);
  });

  it('sortForeignKeys: 안정 정렬이고 (소문자가 같으면 원래 순서) 입력을 바꾸지 않는다', () => {
    const fks = [fkNamed('zz'), fkNamed('ä'), fkNamed('Ä'), fkNamed('aa')];
    const before = JSON.stringify(fks);
    expect(sortForeignKeys(fks).map((f) => f.name)).toEqual(['aa', 'zz', 'ä', 'Ä']);
    expect(JSON.stringify(fks)).toBe(before);
    expect(sortForeignKeys([])).toEqual([]);
  });

  // 이름 없는 FK 번호: 문장 앞의 FK 이름(지우는 것 포함) 중 가장 큰 번호 + 1 부터, 이 문장에서 이름 없이 더한 FK 마다 하나씩. 같은 문장에서 직접 쓴 이름은 세지 않는다
  const unnamed = (column: string) => fk(false, [column], 'parent', ['id']);
  const withCols = (t: Table, ...names: string[]): Table => withColumns(t, ...names.map((n) => ({ ...col(n, 'int unsigned') })));
  const numbersAfter = (before: string[], items: FkItem[], columns: string[]) => {
    const st = fresh();
    const base = withCols({ ...table(st, 'child'), foreignKeys: [] , indexes: table(st, 'child').indexes.filter((i) => i.name !== 'pid')}, ...columns);
    return addKeys(st, base, items, before).foreignKeys.map((f) => f.name);
  };

  it('addKeys: 문장 앞 FK 이름 중 가장 큰 번호 + 1 부터 이름 없는 FK 마다 하나씩 (빈 번호는 되쓰지 않는다)', () => {
    expect(numbersAfter([], [unnamed('a'), unnamed('b')], ['a', 'b'])).toEqual(['child_ibfk_1', 'child_ibfk_2']);
    expect(numbersAfter(['child_ibfk_1', 'child_ibfk_3'], [unnamed('a')], ['a'])).toEqual(['child_ibfk_4']); // 빈 번호(2)를 되쓰지 않는다
    expect(numbersAfter(['child_ibfk_1', 'child_ibfk_2'], [unnamed('a'), unnamed('b')], ['a', 'b'])).toEqual(['child_ibfk_3', 'child_ibfk_4']); // 지우는 FK 도 센다
  });

  it('addKeys: 같은 문장에서 직접 쓴 이름은 번호에 영향을 주지 않는다 (이름이 겹치면 1826), 접두어는 대소문자를 구분하고 숫자가 아닌 꼬리는 세지 않는다', () => {
    const explicit = (column: string, name: string) => fk(true, [column], 'parent', ['id'], name);
    expect(numbersAfter([], [explicit('a', 'child_ibfk_7'), unnamed('b')], ['a', 'b'])).toEqual(['child_ibfk_7', 'child_ibfk_1']);
    expect(() => numbersAfter([], [unnamed('a'), explicit('b', 'child_ibfk_1')], ['a', 'b'])).toThrow(/1826/);
    expect(() => numbersAfter([], [explicit('a', 'child_ibfk_1'), unnamed('b')], ['a', 'b'])).toThrow(/1826/);
    expect(numbersAfter(['CHILD_IBFK_9', 'child_ibfk_x', 'child_ibfk_'], [unnamed('a')], ['a'])).toEqual(['child_ibfk_1']);
  });

  it('addKeys: 문장 앞 이름을 주지 않으면 그 테이블에 있는 FK 이름을 쓴다 (child_ibfk_1 다음은 _2)', () => {
    const st = fresh();
    const c = withCols(table(st, 'child'), 'extra');
    expect(addKeys(st, c, [unnamed('extra')]).foreignKeys.map((f) => f.name)).toEqual(['child_ibfk_1', 'child_ibfk_2']);
  });
});

describe('assertReaddedKeysFit — 지우고 같은 이름으로 다시 더한 컬럼 (MySQL 8.0.46·8.4.11 실측)', () => {
  const keyed = (): Table => table(fresh(), 'child'); // pid int unsigned 는 KEY pid 와 FK 에 든다
  const retypeTo = (t: Table, name: string, type: string): Table => ({ ...t, columns: t.columns.map((c) => (c.name === name ? { ...c, type } : c)) });
  const fitting = (t: Table, next: Table) => () => assertReaddedKeysFit(t, next, new Set(['pid']));

  it('키 모양이 같은 타입은 받는다: 같은 타입 원문, 정수 부호만 다른 경우', () => {
    const t = keyed();
    expect(fitting(t, t)).not.toThrow();
    expect(fitting(t, retypeTo(t, 'pid', 'int'))).not.toThrow(); // int unsigned → int
  });

  it('타입이 다르면 재추출 안내로 거부한다 (정수 크기·문자열 변경 포함)', () => {
    const t = keyed();
    expect(fitting(t, retypeTo(t, 'pid', 'bigint unsigned'))).toThrow(RE_EXPORT);
    expect(fitting(t, retypeTo(t, 'pid', 'varchar(5)'))).toThrow(RE_EXPORT);
  });

  it('키에 들지 않은 컬럼·FULLTEXT 키의 컬럼·옛 컬럼이 없는 이름은 상관없다', () => {
    const t = keyed();
    const noKey: Table = { ...t, indexes: t.indexes.filter((i) => i.name !== 'pid') };
    expect(() => assertReaddedKeysFit(t, retypeTo(noKey, 'pid', 'varchar(5)'), new Set(['pid']))).not.toThrow();
    const p = table(fresh(), 'parent'); // note text 에 FULLTEXT
    const ft = addIndex(p, idx('ft_note', 'FULLTEXT', ['note']));
    expect(() => assertReaddedKeysFit(ft, retypeTo(ft, 'note', 'varchar(30)'), new Set(['note']))).not.toThrow();
    expect(() => assertReaddedKeysFit(t, t, new Set(['nope']))).not.toThrow();
    expect(() => assertReaddedKeysFit(t, retypeTo(t, 'pid', 'varchar(5)'), new Set())).not.toThrow(); // 다시 더하지 않은 컬럼은 보지 않는다
  });
});

describe('ensureFkIndexes·addKeys — FK 자동 인덱스 이름 충돌과 지운 FK 이름 (MySQL 8.0.46·8.4.11 실측)', () => {
  const unnamedFk = (column: string) => fk(false, [column], 'parent', ['id']);
  const FKS = [{ name: 'fk_x', columns: ['pid'], refTable: 'parent', refColumns: ['id'] }];
  // pid 를 받치는 인덱스가 없는 child: KEY pid (name) 만 있다 (이름만 pid)
  const unsupported = (): Table => {
    const c = table(fresh(), 'child');
    return { ...c, foreignKeys: FKS, indexes: [c.indexes[0], { name: 'pid', kind: 'INDEX', parts: [{ column: 'name', desc: false }], invisible: false }, { name: 'fk_x', kind: 'INDEX', parts: [{ column: 'name', desc: false }], invisible: false }] };
  };

  it('CONSTRAINT 이름·FOREIGN KEY 뒤 인덱스 이름이 겹치면 1061, 안 정했으면 _2 를 붙인다', () => {
    expect(() => ensureFkIndexes(unsupported(), [{ name: 'fk_x', named: true }])).toThrow(/\(MySQL 1061\)/);
    expect(() => ensureFkIndexes(unsupported(), [{ name: 'fk_x', named: false, indexName: 'FK_X' }])).toThrow(/\(MySQL 1061\)/); // 대소문자 무시
    expect(ensureFkIndexes(unsupported(), [{ name: 'fk_x', named: false }]).indexes.at(-1)).toEqual({ name: 'pid_2', kind: 'INDEX', parts: [{ column: 'pid', desc: false }], invisible: false });
    expect(() => ensureFkIndexes(unsupported(), [{ name: 'fk_x', named: false, indexName: 'PRIMARY' }])).toThrow(/\(MySQL 1280\)/);
  });

  it('받치는 인덱스가 있으면 새 인덱스를 만들지 않으므로 이름이 겹쳐도 된다', () => {
    const t = unsupported();
    const supported: Table = { ...t, indexes: [...t.indexes, { name: 'fk_x_ok', kind: 'INDEX', parts: [{ column: 'pid', desc: false }], invisible: false }] };
    expect(ensureFkIndexes(supported, [{ name: 'fk_x', named: true }]).indexes).toHaveLength(supported.indexes.length);
  });

  it('addKeys: 문장 앞에 있던(지우는) FK 와 같은 이름(대소문자 무시)으로 직접 이름을 붙이면 1826 — 이름 없는 FK 는 상관없다', () => {
    const st = fresh();
    const c = withColumns(table(st, 'child'), col('extra', 'int unsigned'));
    const gone: Table = { ...c, foreignKeys: [], indexes: c.indexes.filter((i) => i.name !== 'pid') }; // child_ibfk_1 을 지운 뒤의 테이블
    expect(() => addKeys(st, gone, [fk(true, ['pid'], 'parent', ['id'], 'child_ibfk_1')], ['child_ibfk_1'])).toThrow(/\(MySQL 1826\)/);
    expect(() => addKeys(st, gone, [fk(true, ['pid'], 'parent', ['id'], 'CHILD_IBFK_1')], ['child_ibfk_1'])).toThrow(/\(MySQL 1826\)/);
    expect(addKeys(st, gone, [fk(true, ['pid'], 'parent', ['id'], 'child_ibfk_9')], ['child_ibfk_1']).foreignKeys.map((f) => f.name)).toEqual(['child_ibfk_9']);
    expect(addKeys(st, gone, [unnamedFk('extra')], ['child_ibfk_1']).foreignKeys.map((f) => f.name)).toEqual(['child_ibfk_2']);
  });

  it('addKeys: 인덱스 이름 충돌(1061)이 FK 이름 중복(1826)보다 먼저 걸린다', () => {
    const st = fresh();
    const c = withColumns(table(st, 'child'), col('extra', 'int unsigned'));
    const gone: Table = { ...c, foreignKeys: [], indexes: [...c.indexes.filter((i) => i.name !== 'pid'), { name: 'child_ibfk_1', kind: 'INDEX', parts: [{ column: 'pid', desc: false }], invisible: false }] };
    expect(() => addKeys(st, gone, [fk(true, ['extra'], 'parent', ['id'], 'child_ibfk_1')], ['child_ibfk_1'])).toThrow(/\(MySQL 1061\)/);
  });
});

// MySQL 8.0.46·8.4.11 실측: VIRTUAL 생성 컬럼이나 함수 식이 든 키(HA_VIRTUAL_GEN_KEY)는 같은 무리 안에서 뒤로 간다. 비교 순서는
// UNIQUE(PRIMARY 포함): NULL 허용 컬럼이 없는 것 → PRIMARY → 길이(prefix) 없는 것 → VIRTUAL 이 없는 것 → 선언 순서 / 일반 인덱스: FULLTEXT 가 마지막 → VIRTUAL 이 없는 것 → 선언 순서.
// STORED 생성 컬럼은 일반 컬럼과 같다. 함수 인덱스 식의 NULL 허용은 식이 쓰는 컬럼이 하나라도 NULL 허용이면 NULL 허용
describe('sortIndexes — VIRTUAL 생성 컬럼·함수 인덱스', () => {
  // 키를 선언한 순서(키 줄 순서)대로 모델을 읽고 sortIndexes 가 MySQL 이 찍은 순서를 내는지 본다
  const modelOf = (keys: string[]): Table => {
    const cols = [
      '`id` int NOT NULL', '`a` int DEFAULT NULL', '`a_nn` int NOT NULL', '`b` varchar(20) DEFAULT NULL', '`b_nn` varchar(20) NOT NULL',
      '`v` int GENERATED ALWAYS AS ((`a` + 1)) VIRTUAL', '`vn` int GENERATED ALWAYS AS ((`a_nn` + 1)) VIRTUAL NOT NULL', '`v2` int GENERATED ALWAYS AS ((`a` + 3)) VIRTUAL',
      '`s` int GENERATED ALWAYS AS ((`a` + 2)) STORED', '`sn` int GENERATED ALWAYS AS ((`a_nn` + 2)) STORED NOT NULL',
    ];
    const ddl = `CREATE TABLE \`t\` (\n  ${[...cols, 'PRIMARY KEY (`id`)', ...keys].join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`;
    return parseSqlDump(tdExport(ddl)).model.tables[0];
  };
  const orderOf = (keys: string[]): string => sortIndexes(modelOf(keys)).map((i) => i.name).join(' ');

  it.each([
    // 선언 순서 → MySQL 이 찍은 순서
    [['KEY `kv` (`v`)', 'KEY `ka` (`a`)', 'UNIQUE KEY `uv` (`v`)', 'UNIQUE KEY `ua` (`a`)', 'UNIQUE KEY `uvn` (`vn`)', 'UNIQUE KEY `uan` (`a_nn`)', 'KEY `kva` (`v`,`a`)', 'KEY `kav` (`a`,`v`)',
      'FULLTEXT KEY `ft` (`b`)', 'KEY `ks` (`s`)', 'KEY `kz` (`a_nn`)'], 'PRIMARY uan uvn ua uv ka ks kz kv kva kav ft'],
    [['KEY `kv` (`v`)', 'KEY `ka` (`a`)', 'KEY `kva` (`v`,`a`)', 'KEY `kav` (`a`,`v`)', 'KEY `ks` (`s`)', 'KEY `kz` (`a_nn`)'], 'PRIMARY ka ks kz kv kva kav'], // VIRTUAL 이 든 키(혼합 포함)는 뒤로
    [['KEY `kv2` (`v2`)', 'KEY `kv` (`v`)', 'KEY `ka` (`a`)'], 'PRIMARY ka kv2 kv'], // VIRTUAL 끼리는 선언 순서
    [['KEY `kv` (`v`)', 'KEY `ks` (`s`)', 'KEY `ka` (`a`)'], 'PRIMARY ks ka kv'], // STORED 는 일반 컬럼
    [['KEY `kv` (`v`)', 'FULLTEXT KEY `ft` (`b`)'], 'PRIMARY kv ft'], // FULLTEXT 가 VIRTUAL 보다 뒤
    [['FULLTEXT KEY `ft` (`b`)', 'KEY `kv` (`v`)', 'KEY `ka` (`a`)'], 'PRIMARY ka kv ft'],
    [['KEY `ka` (`a`)', 'UNIQUE KEY `uv` (`v`)'], 'PRIMARY uv ka'], // UNIQUE 는 VIRTUAL 이어도 일반 인덱스보다 앞
    [['KEY `kv` (`v`)', 'UNIQUE KEY `ua` (`a`)'], 'PRIMARY ua kv'],
    [['UNIQUE KEY `uv` (`v`)', 'UNIQUE KEY `ua` (`a`)'], 'PRIMARY ua uv'], // NULL 허용 UNIQUE 안에서 VIRTUAL 이 뒤
    [['UNIQUE KEY `uvn` (`vn`)', 'UNIQUE KEY `ua` (`a`)'], 'PRIMARY uvn ua'], // NOT NULL 이 VIRTUAL 보다 먼저 비교된다
    [['UNIQUE KEY `uvn` (`vn`)', 'UNIQUE KEY `usn` (`sn`)', 'UNIQUE KEY `uan` (`a_nn`)'], 'PRIMARY usn uan uvn'],
    [['UNIQUE KEY `uva` (`v`,`a`)', 'UNIQUE KEY `ua` (`a`)'], 'PRIMARY ua uva'], // 혼합 키 (VIRTUAL 파트가 앞이든 뒤든)
    [['UNIQUE KEY `uav` (`a`,`v`)', 'UNIQUE KEY `ua` (`a`)'], 'PRIMARY ua uav'],
    // prefix(길이) 가 VIRTUAL 보다 먼저 비교된다: 길이 있는 키는 VIRTUAL 키보다도 뒤
    [['UNIQUE KEY `upb` (`b_nn`(5))', 'UNIQUE KEY `uvn` (`vn`)', 'UNIQUE KEY `uan` (`a_nn`)'], 'PRIMARY uan uvn upb'],
    [['UNIQUE KEY `uvn` (`vn`)', 'UNIQUE KEY `upb` (`b_nn`(5))', 'UNIQUE KEY `uan` (`a_nn`)'], 'PRIMARY uan uvn upb'],
    [['UNIQUE KEY `upb2` (`b`(5))', 'UNIQUE KEY `uv` (`v`)', 'UNIQUE KEY `ua` (`a`)'], 'PRIMARY ua uv upb2'],
    // 함수 인덱스는 VIRTUAL 키와 같다
    [['KEY `kf` (((`a` + 1)))', 'KEY `ka` (`a`)', 'KEY `kv` (`v`)'], 'PRIMARY ka kf kv'],
    [['KEY `ka` (`a`)', 'KEY `kv` (`v`)', 'KEY `kf` (((`a` + 1)))'], 'PRIMARY ka kv kf'],
    [['KEY `kfa` (((`a` + 1)),`a`)', 'KEY `kaf` (`a`,((`a` + 1)))', 'KEY `ka` (`a`)'], 'PRIMARY ka kfa kaf'],
    [['FULLTEXT KEY `ft` (`b`)', 'KEY `kf` (((`a` + 1)))', 'KEY `ka` (`a`)'], 'PRIMARY ka kf ft'],
    [['UNIQUE KEY `uf` (((`a` + 1)))', 'UNIQUE KEY `ua` (`a`)', 'UNIQUE KEY `uan` (`a_nn`)'], 'PRIMARY uan ua uf'], // 식이 NULL 허용 컬럼을 쓰면 NULL 허용
    [['UNIQUE KEY `ufn` (((`a_nn` + 1)))', 'UNIQUE KEY `uvn` (`vn`)', 'UNIQUE KEY `uan` (`a_nn`)'], 'PRIMARY uan ufn uvn'], // NOT NULL 컬럼만 쓰는 식은 NOT NULL
    [['UNIQUE KEY `ufn` (((`a_nn` + 1)))', 'UNIQUE KEY `uv` (`v`)', 'UNIQUE KEY `ua` (`a`)'], 'PRIMARY ufn ua uv'],
    [['UNIQUE KEY `uvn` (`vn`)', 'UNIQUE KEY `ufn` (((`a_nn` + 1)))'], 'PRIMARY uvn ufn'], // VIRTUAL·함수 UNIQUE 끼리는 선언 순서
    [['UNIQUE KEY `ufn` (((`a_nn` + 1)))', 'UNIQUE KEY `uvn` (`vn`)'], 'PRIMARY ufn uvn'],
  ])('선언 %j → %s', (keys, expected) => {
    expect(orderOf(keys)).toBe(expected);
  });

  it('이미 MySQL 순서인 목록은 그대로 두고, 입력 테이블은 바꾸지 않는다', () => {
    const keys = ['UNIQUE KEY `uan` (`a_nn`)', 'UNIQUE KEY `uvn` (`vn`)', 'KEY `ka` (`a`)', 'KEY `kv` (`v`)', 'FULLTEXT KEY `ft` (`b`)'];
    expect(orderOf(keys)).toBe('PRIMARY uan uvn ka kv ft');
    expect(orderOf([...keys].reverse())).toBe('PRIMARY uan uvn ka kv ft');
    const t = modelOf([...keys].reverse());
    const before = t.indexes.map((i) => i.name);
    sortIndexes(t);
    expect(t.indexes.map((i) => i.name)).toEqual(before);
  });
});

// addKeys 가 이 실행이 아는 출처를 적는다: 직접 더한 인덱스는 user, FK 가 새로 만든 자동 인덱스는 auto (CREATE TABLE 도 addKeys 로 키를 만들면 따로 부를 것이 없다)
describe('addKeys — 인덱스 출처 기록', () => {
  const provenance = (st: State, name: string) => [...(st.origins.provenance.get(name) ?? [])];

  it('직접 더한 인덱스는 user, 자동 이름을 받은 것도 실제 이름으로 적는다', () => {
    const st = fresh();
    addKeys(st, table(st, 'child'), [idx('ix_name', 'INDEX', ['name']), idx('', 'UNIQUE', ['name'], false)]);
    expect(provenance(st, 'child')).toEqual([['ix_name', 'user'], ['name', 'user']]);
  });

  it('FK 가 새로 만든 인덱스는 auto, 받치는 인덱스가 있어 만들지 않았으면 적지 않는다', () => {
    const st = fresh();
    const c = withColumns(table(st, 'child'), col('pid2', 'int unsigned'));
    addKeys(st, c, [fk(true, ['pid2'], 'parent', ['id'], 'fk_p2'), fk(true, ['pid'], 'parent', ['id'], 'fk_again')]);
    expect(provenance(st, 'child')).toEqual([['fk_p2', 'auto']]); // pid 는 KEY pid 가 받친다
  });

  it('새 FK 가 대신한 옛 자동 인덱스는 표에서 이름이 바뀐다 (옛 이름은 plan 이 버리고 새 이름이 auto)', () => {
    const st = fresh();
    const c = table(st, 'child');
    const plan = planAutoKeys(c, [fk(true, ['pid'], 'parent', ['id'], 'again')], { generated: new Set(['pid']) });
    addKeys(st, c, [fk(true, ['pid'], 'parent', ['id'], 'again')], ['child_ibfk_1'], plan);
    expect(provenance(st, 'child')).toEqual([['again', 'auto']]);
  });
});
