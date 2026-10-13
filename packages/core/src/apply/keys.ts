// 인덱스·FK: 추가·삭제·이름 변경·자동 이름, FK 자동 인덱스, 문장 끝 테이블 검사, MySQL 키 저장 순서
import { quotedIdentifiers } from '../lexer';
import type { Column, ForeignKey, Index, Table } from '../model';
import { baseType, BLOB_TYPES, effectiveCollation, tableCharset, type TableCharset } from './normalize-mysql';
import { findColumn, findTable, sameName, type State } from './state';
import { fail, RE_EXPORT, type ConstraintItem, type FkItem, type IndexItem } from './types';

export interface KeyDrop {
  what: 'index' | 'primary' | 'fk' | 'check' | 'constraint';
  name: string;
}

const LENGTH_TYPES: ReadonlySet<string> = new Set(['char', 'varchar', 'binary', 'varbinary']);
const FULLTEXT_TYPES: ReadonlySet<string> = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext']);

// 인덱스 i 의 앞쪽 키 파트가 columns 와 같은지 (길이 있는 파트·식 파트·FULLTEXT·SPATIAL 은 FK 를 받치지 못한다)
export function leadsWith(i: Index, columns: readonly string[]): boolean {
  if (i.kind === 'FULLTEXT' || i.kind === 'SPATIAL' || i.parts.length < columns.length) return false;
  return columns.every((c, k) => i.parts[k].column !== undefined && i.parts[k].length === undefined && sameName(i.parts[k].column!, c));
}

// MySQL 자동 인덱스 이름: 기준 이름이 이미 있으면 _2, _3 … (대소문자 무시)
export function uniqueIndexName(t: Pick<Table, 'indexes'>, base: string): string {
  const taken = (n: string) => t.indexes.some((i) => sameName(i.name, n));
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}_${n}`)) return `${base}_${n}`;
}

// '<테이블>_ibfk_<N>': N 은 이 테이블의 같은 꼴 FK 번호 중 가장 큰 값 + 1
export function nextFkName(t: Pick<Table, 'name' | 'foreignKeys'>): string {
  const prefix = `${t.name}_ibfk_`;
  const used = t.foreignKeys.filter((f) => f.name.startsWith(prefix)).map((f) => Number(f.name.slice(prefix.length))).filter((n) => Number.isInteger(n));
  return `${prefix}${Math.max(0, ...used) + 1}`;
}

// 식(생성 컬럼·CHECK·함수 인덱스)이 컬럼을 쓰는지. SHOW CREATE 의 식은 컬럼을 늘 백틱으로 쓴다
export const exprUses = (expr: string, column: string): boolean => (quotedIdentifiers(expr) ?? []).some((n) => sameName(n, column));

// PRIMARY KEY 에 들어간 컬럼은 NOT NULL 이 되고 DEFAULT NULL 은 없어진다
function notNull(c: Column): Column {
  if (!c.nullable) return c;
  const next: Column = { ...c, nullable: false };
  if (next.default === 'NULL') delete next.default;
  return next;
}

export function addIndex(t: Table, item: IndexItem): Table {
  const parts = item.index.parts.map((p) => ({ ...p, column: (findColumn(t, p.column!) ?? fail(`키 컬럼 \`${p.column}\` 이 없습니다 (MySQL 1072)`)).name }));
  const index: Index = withoutInnodbHash(t, { ...item.index, parts });
  checkKeyParts(t, index);
  if (index.kind === 'PRIMARY') {
    if (t.indexes.some((i) => i.kind === 'PRIMARY')) fail('PRIMARY KEY 가 이미 있습니다 (MySQL 1068)');
    if (index.invisible) fail('PRIMARY KEY 는 INVISIBLE 로 둘 수 없습니다 (MySQL 3522)');
    const pk = new Set(parts.map((p) => p.column.toLowerCase()));
    return { ...t, columns: t.columns.map((c) => (pk.has(c.name.toLowerCase()) ? notNull(c) : c)), indexes: [...t.indexes, { ...index, name: 'PRIMARY' }] };
  }
  const name = item.named ? index.name : uniqueIndexName(t, parts[0].column);
  if (sameName(name, 'PRIMARY')) fail('인덱스 이름으로 PRIMARY 는 쓸 수 없습니다 (MySQL 1280)');
  if (t.indexes.some((i) => sameName(i.name, name))) fail(`인덱스 이름 \`${name}\` 이 이미 있습니다 (MySQL 1061)`);
  return { ...t, indexes: [...t.indexes, { ...index, name }] };
}

// InnoDB 는 USING HASH 를 BTREE 로 만들고 SHOW CREATE 에서 지운다 (USING BTREE 는 남긴다 — MySQL 8.0 실측)
function withoutInnodbHash(t: Table, index: Index): Index {
  if (index.using !== 'HASH' || t.options.find((o) => o.key === 'ENGINE')?.value !== 'InnoDB') return index;
  const next: Index = { ...index };
  delete next.using;
  return next;
}

function checkKeyParts(t: Table, index: Index): void {
  for (const p of index.parts) {
    const col = findColumn(t, p.column!)!;
    const base = baseType(col.type);
    if (base === 'json') fail(`JSON 컬럼 \`${col.name}\` 에는 인덱스를 직접 만들 수 없습니다 (MySQL 3152)`);
    if (index.kind === 'FULLTEXT') {
      if (!FULLTEXT_TYPES.has(base)) fail(`FULLTEXT 인덱스에는 문자열 컬럼만 쓸 수 있습니다: \`${col.name}\` (MySQL 1283)`);
      continue;
    }
    if (BLOB_TYPES.has(base) && p.length === undefined) fail(`TEXT·BLOB 컬럼 \`${col.name}\` 의 인덱스에는 길이가 필요합니다 (MySQL 1170)`);
    if (p.length === undefined) continue;
    if (!BLOB_TYPES.has(base) && !LENGTH_TYPES.has(base)) fail(`\`${col.name}\` 에는 길이 있는 키 파트를 쓸 수 없습니다 (MySQL 1089)`);
    if (LENGTH_TYPES.has(base) && p.length > Number(/\((\d+)\)/.exec(col.type)?.[1])) fail(`키 파트 길이가 컬럼 \`${col.name}\` 의 길이보다 깁니다 (MySQL 1089)`);
  }
}

// FK 를 붙인다 (받치는 인덱스는 ensureFkIndexes 가 문장 끝에 만든다)
export function addForeignKey(st: State, t: Table, item: FkItem): Table {
  const { refSchema, ...rest } = item.fk;
  if (refSchema !== undefined && refSchema !== st.schemaName) fail(`다른 스키마 \`${refSchema}\` 를 참조하는 FK 는 1차 지원 범위가 아닙니다 — ${RE_EXPORT}`);
  const columns = rest.columns.map((n) => (findColumn(t, n) ?? fail(`FK 컬럼 \`${n}\` 이 없습니다 (MySQL 1072)`)).name);
  const parent = rest.refTable === t.name ? t : findTable(st, rest.refTable);
  if (!parent && st.fkChecks) fail(`참조하는 테이블 \`${rest.refTable}\` 이 없습니다 (MySQL 1824)`);
  const refColumns = parent ? parentKey(st, t, columns, rest.refColumns, parent) : rest.refColumns;
  const name = item.named ? rest.name : nextFkName(t);
  if (st.model.tables.some((x) => x.name !== t.name && x.foreignKeys.some((f) => sameName(f.name, name))) || t.foreignKeys.some((f) => sameName(f.name, name))) fail(`FK 이름 \`${name}\` 이 이미 있습니다 (MySQL 1826)`);
  const fk: ForeignKey = { ...rest, name, columns, refColumns };
  return { ...t, foreignKeys: [...t.foreignKeys, fk] };
}

// 부모 쪽 검사: 참조 컬럼이 있고, 타입·콜레이션이 맞고(3780), 참조 컬럼에 정확히 맞는 PRIMARY KEY·UNIQUE 가 있어야 한다 (8.4 6125).
// 돌려주는 값: 부모 컬럼 표기로 쓴 참조 컬럼 이름
function parentKey(st: State, child: Table, columns: readonly string[], refNames: readonly string[], parent: Table): string[] {
  const refs = refNames.map((n) => findColumn(parent, n) ?? fail(`참조 컬럼 \`${parent.name}\`.\`${n}\` 이 없습니다 (MySQL 3734)`));
  if (refs.length !== columns.length) fail('FK 컬럼 수와 참조 컬럼 수가 다릅니다 (MySQL 1239)');
  const childCs = tableCharset(child.options, st.defaults);
  const parentCs = tableCharset(parent.options, st.defaults);
  columns.forEach((n, k) => {
    const a = findColumn(child, n)!;
    if (!fkCompatible(a, childCs, refs[k], parentCs)) fail(`FK 컬럼 \`${a.name}\` 과 참조 컬럼 \`${refs[k].name}\` 의 타입·문자셋이 맞지 않습니다 (MySQL 3780)`);
  });
  const names = refs.map((r) => r.name);
  const standard = parent.indexes.some((i) => (i.kind === 'PRIMARY' || i.kind === 'UNIQUE') && i.parts.length === names.length && leadsWith(i, names));
  if (!standard) fail(`참조 컬럼 (${names.join(', ')}) 에 정확히 맞는 PRIMARY KEY·UNIQUE 인덱스가 없습니다 (MySQL 8.4 6125 — 8.0 은 일반 인덱스도 받지만 1차에서는 8.4 규칙을 따릅니다)`);
  return names;
}

// 정수·DECIMAL 은 크기·부호까지 같아야 하고, 문자열은 길이는 달라도 되지만 문자셋·콜레이션이 같아야 한다
function fkCompatible(a: Column, aCs: TableCharset, b: Column, bCs: TableCharset): boolean {
  const kind = (c: Column) => {
    const base = baseType(c.type);
    return base === 'char' || base === 'varchar' ? 'string' : base === 'binary' || base === 'varbinary' ? 'binary' : c.type;
  };
  return kind(a) === kind(b) && effectiveCollation(a, aCs) === effectiveCollation(b, bCs);
}

// 이 문장에서 붙인 FK 에 받치는 인덱스가 없으면 만든다. 이름: CONSTRAINT 이름 → FOREIGN KEY 뒤에 쓴 인덱스 이름 → 첫 컬럼 (겹치면 _2 …, MySQL 8.0 실측)
export function ensureFkIndexes(t: Table, added: readonly { name: string; indexName?: string; named: boolean }[]): Table {
  let next = t;
  for (const a of added) {
    const fk = next.foreignKeys.find((f) => f.name === a.name)!;
    if (next.indexes.some((i) => leadsWith(i, fk.columns))) continue;
    const name = uniqueIndexName(next, a.named ? fk.name : (a.indexName ?? fk.columns[0]));
    next = { ...next, indexes: [...next.indexes, { name, kind: 'INDEX', parts: fk.columns.map((column) => ({ column, desc: false })), invisible: false }] };
  }
  return next;
}

// 인덱스·FK 정의를 차례로 붙이고, 붙인 FK 에 받치는 인덱스가 없으면 만든다 (ALTER TABLE ADD·CREATE TABLE 공용)
export function addKeys(st: State, t: Table, items: readonly ConstraintItem[]): Table {
  let next = t;
  const added: { name: string; indexName?: string; named: boolean }[] = [];
  for (const item of items) {
    if (item.kind === 'index') next = addIndex(next, item);
    else {
      next = addForeignKey(st, next, item);
      added.push({ name: next.foreignKeys.at(-1)!.name, ...(item.indexName !== undefined ? { indexName: item.indexName } : {}), named: item.named });
    }
  }
  return ensureFkIndexes(next, added);
}

export function dropKeys(t: Table, drops: readonly KeyDrop[]): Table {
  let next = t;
  for (const d of drops) {
    const isPk = d.what === 'primary' || (d.what === 'index' && sameName(d.name, 'PRIMARY'));
    const index = isPk
      ? next.indexes.find((i) => i.kind === 'PRIMARY')
      : d.what === 'index' || d.what === 'constraint' ? next.indexes.find((i) => sameName(i.name, d.name) && (d.what === 'index' || i.kind === 'UNIQUE')) : undefined;
    const fk = d.what === 'fk' || d.what === 'constraint' ? next.foreignKeys.find((f) => sameName(f.name, d.name)) : undefined;
    const check = d.what === 'check' || d.what === 'constraint' ? next.checks.find((k) => sameName(k.name, d.name)) : undefined;
    if (index) next = { ...next, indexes: next.indexes.filter((i) => i !== index) };
    else if (fk) next = { ...next, foreignKeys: next.foreignKeys.filter((f) => f !== fk) };
    else if (check) next = { ...next, checks: next.checks.filter((k) => k !== check) };
    else fail(missingKey(d));
  }
  return next;
}

const missingKey = (d: KeyDrop): string =>
  d.what === 'check' ? `CHECK \`${d.name}\` 이 없습니다 (MySQL 3821)`
    : d.what === 'constraint' ? `제약 \`${d.name}\` 이 없습니다 (MySQL 3940)`
      : `${d.what === 'fk' ? 'FK' : '인덱스'} \`${d.name}\` 이 없습니다 (MySQL 1091)`;

// 컬럼 삭제·이름 변경을 남은 인덱스·자기 FK 에 반영한다 (dropped: 지운 컬럼 이름(소문자), renamed: 문장 전 이름(소문자) → 새 이름)
export function remapKeys(t: Table, dropped: ReadonlySet<string>, renamed: ReadonlyMap<string, string>): Table {
  const rename = (n: string) => renamed.get(n.toLowerCase()) ?? n;
  const indexes = t.indexes.flatMap((i) => {
    const parts = i.parts.filter((p) => p.column === undefined || !dropped.has(p.column.toLowerCase())).map((p) => (p.column === undefined ? p : { ...p, column: rename(p.column) }));
    return parts.length ? [{ ...i, parts }] : [];
  });
  const foreignKeys = t.foreignKeys.map((f) => ({ ...f, columns: f.columns.map(rename), ...(f.refTable === t.name && f.refSchema === undefined ? { refColumns: f.refColumns.map(rename) } : {}) }));
  return { ...t, indexes, foreignKeys };
}

export function renameIndex(t: Table, from: string, to: string): Table {
  const index = t.indexes.find((i) => sameName(i.name, from)) ?? fail(`인덱스 \`${from}\` 이 없습니다 (MySQL 1176)`);
  if (index.kind === 'PRIMARY' || sameName(to, 'PRIMARY')) fail('PRIMARY KEY 의 이름은 바꿀 수 없습니다 (MySQL 1280)');
  if (!sameName(from, to) && t.indexes.some((i) => sameName(i.name, to))) fail(`인덱스 이름 \`${to}\` 이 이미 있습니다 (MySQL 1061)`);
  return { ...t, indexes: t.indexes.map((i) => (i === index ? { ...i, name: to } : i)) };
}

export function setIndexVisibility(t: Table, name: string, invisible: boolean): Table {
  const index = t.indexes.find((i) => sameName(i.name, name)) ?? fail(`인덱스 \`${name}\` 이 없습니다 (MySQL 1176)`);
  if (index.kind === 'PRIMARY' && invisible) fail('PRIMARY KEY 는 INVISIBLE 로 둘 수 없습니다 (MySQL 3522)');
  return { ...t, indexes: t.indexes.map((i) => (i === index ? { ...i, invisible } : i)) };
}

// 문장 끝 검사 (MySQL 이 거부하는 상태): AUTO_INCREMENT 는 하나이고 인덱스 첫 컬럼(1075), 보이는 컬럼 하나 이상(4028),
// 모든 FK 에 받치는 인덱스 — 자기 쪽과 부모 쪽 (1553). renamed: 이 문장에서 바뀐 t 의 컬럼 이름 (다른 테이블 FK 의 참조 이름은 아직 옛 이름)
export function checkTable(st: State, t: Table, renamed: ReadonlyMap<string, string> = new Map()): void {
  const autos = t.columns.filter((c) => c.autoIncrement);
  if (autos.length > 1) fail('AUTO_INCREMENT 컬럼은 하나만 둘 수 있습니다 (MySQL 1075)');
  if (autos.length && !t.indexes.some((i) => i.parts[0]?.column !== undefined && sameName(i.parts[0].column, autos[0].name))) fail(`AUTO_INCREMENT 컬럼 \`${autos[0].name}\` 은 인덱스의 첫 컬럼이어야 합니다 (MySQL 1075)`);
  if (t.columns.every((c) => c.invisible)) fail('보이는 컬럼이 하나 이상 있어야 합니다 (MySQL 4028)');
  for (const fk of t.foreignKeys) if (!t.indexes.some((i) => leadsWith(i, fk.columns))) fail(`FK \`${fk.name}\` 에 필요한 인덱스를 지울 수 없습니다 (MySQL 1553)`);
  for (const child of [...st.model.tables.filter((x) => x.name !== t.name), t]) {
    for (const fk of child.foreignKeys) {
      if (fk.refTable !== t.name || fk.refSchema !== undefined) continue;
      const refs = child === t ? fk.refColumns : fk.refColumns.map((n) => renamed.get(n.toLowerCase()) ?? n);
      if (!t.indexes.some((i) => leadsWith(i, refs))) fail(`\`${child.name}\` 의 FK \`${fk.name}\` 가 쓰는 인덱스를 지울 수 없습니다 (MySQL 1553)`);
    }
  }
}

// MySQL 이 키를 저장하는 순서 (sql_table.cc sort_keys): UNIQUE(PRIMARY 포함) 먼저 — 그 안에서 NULL 허용 컬럼이 없는 것, PRIMARY,
// 길이 있는 파트가 없는 것 순 — 그다음 일반 인덱스, FULLTEXT 는 마지막. 같은 무리 안은 원래 순서
export function sortIndexes(t: Table): Index[] {
  const nullable = (i: Index) => i.parts.some((p) => p.column !== undefined && findColumn(t, p.column)?.nullable === true);
  const rank = (i: Index): number[] =>
    i.kind === 'PRIMARY' || i.kind === 'UNIQUE'
      ? [0, nullable(i) ? 1 : 0, i.kind === 'PRIMARY' ? 0 : 1, i.parts.some((p) => p.length !== undefined) ? 1 : 0]
      : [1, i.kind === 'FULLTEXT' ? 1 : 0, 0, 0];
  const cmp = (a: number[], b: number[]) => a.reduce((r, x, k) => r || x - b[k], 0);
  return t.indexes.map((i, n) => ({ i, n, r: rank(i) })).sort((a, b) => cmp(a.r, b.r) || a.n - b.n).map((x) => x.i);
}
