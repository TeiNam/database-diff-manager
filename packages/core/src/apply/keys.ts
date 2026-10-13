// 인덱스·FK: 추가·삭제·이름 변경·자동 이름, FK 자동 인덱스, 문장 끝 테이블 검사, MySQL 키 저장 순서
import { quotedIdentifiers } from '../lexer';
import type { Column, ForeignKey, Index, IndexKind, IndexPart, Table } from '../model';
import { markProvenance, planAutoKeys, type AutoKeyPlan } from './auto-index';
import { baseType, BLOB_TYPES, CHARSET_TYPES, effectiveCollation, INT_TYPES, tableCharset } from './normalize-mysql';
import { findColumn, findTable, sameName, type State } from './state';
import { fail, RE_EXPORT, type ColumnSpec, type ConstraintItem, type FkItem, type IndexItem } from './types';

export interface KeyDrop {
  what: 'index' | 'primary' | 'fk' | 'check' | 'constraint';
  name: string;
}

const LENGTH_TYPES: ReadonlySet<string> = new Set(['char', 'varchar', 'binary', 'varbinary']);
const FULLTEXT_TYPES: ReadonlySet<string> = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext']);

// 인덱스 i 의 앞쪽 키 파트가 columns 와 이름·순서까지 같은지. 정렬 방향은 보지 않는다
// (길이 있는 파트·식 파트·FULLTEXT·SPATIAL 은 FK 의 키가 될 수 없다)
function isFkKey(i: Index, columns: readonly string[]): boolean {
  if (i.kind === 'FULLTEXT' || i.kind === 'SPATIAL' || i.parts.length < columns.length) return false;
  return columns.every((c, k) => i.parts[k].column !== undefined && i.parts[k].length === undefined && sameName(i.parts[k].column!, c));
}

// 새로 붙이는 FK 를 받치는 인덱스인지: isFkKey 이고 FK 컬럼에 해당하는 앞쪽 파트가 모두 ASC 여야 한다. MySQL 8.0.46 은 DESC 가 낀 인덱스를 받침으로 치지 않고
// KEY (<컬럼>) 를 따로 만든다 ((a, b DESC) 는 FK (a) 를 받치고 (a DESC, b) 는 받치지 못한다). 이미 있는 FK 의 키를 확인하는 checkTable 과 부모의 참조 키(parentKey)는
// 방향을 보지 않는다 — ASC 를 지우고 DESC 를 더해도, 부모가 PRIMARY KEY (id DESC) 뿐이어도 MySQL 은 받는다 (실측)
export function leadsWith(i: Index, columns: readonly string[]): boolean {
  return isFkKey(i, columns) && i.parts.slice(0, columns.length).every((p) => !p.desc);
}

// MySQL 자동 인덱스 이름: 기준 이름이 이미 있으면 _2, _3 … (대소문자 무시)
export function uniqueIndexName(t: Pick<Table, 'indexes'>, base: string): string {
  const taken = (n: string) => t.indexes.some((i) => sameName(i.name, n));
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}_${n}`)) return `${base}_${n}`;
}

// 자동 FK 이름 '<테이블>_ibfk_<N>' 의 N 중 가장 큰 값 (없으면 0). 접두어는 대소문자를 구분하고 (`T_IBFK_9` 는 세지 않는다), 숫자로만 된 꼬리만 센다 (`_x`·`_` 는 세지 않는다)
function highestFkNumber(table: string, names: readonly string[]): number {
  const prefix = `${table}_ibfk_`;
  const numbers = names.filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length))).map((n) => Number(n.slice(prefix.length)));
  return Math.max(0, ...numbers);
}

// '<테이블>_ibfk_<N>': N 은 이 테이블의 같은 꼴 FK 번호 중 가장 큰 값 + 1
export function nextFkName(t: Pick<Table, 'name' | 'foreignKeys'>): string {
  return `${t.name}_ibfk_${highestFkNumber(t.name, t.foreignKeys.map((f) => f.name)) + 1}`;
}

// SHOW CREATE 가 FK 를 찍는 순서 (MySQL 8.0.46·8.4.11 실측): 제약 이름을 소문자로 바꿔 코드 포인트 순으로 비교한다. 선언한 순서와 상관없다.
//   fk0 < fk1 < fk_1 < fk_a < fka (숫자 < '_' < 글자), t_ibfk_1 < t_ibfk_10 < t_ibfk_2 (숫자로 읽지 않는다), Beta < beta_1 < gamma (대소문자 무시),
//   fk_가 < fk_주문 < fk_힣 (한글·CJK 는 코드 포인트 순). 한계: 라틴 확장 문자(ä·é·ß)·그리스·키릴 문자는 MySQL 이 코드 포인트 순이 아니다
//   (실측 `ä, é, ñ, ß, Ä, É`, 그리스 대문자·소문자는 뒤섞인다) — 그 이름끼리의 순서는 맞추지 못한다. 그래서 FK 를 더하거나 테이블 이름을 바꿔 FK 이름이 달라질 때만 부른다.
//   입력은 바꾸지 않고, 소문자가 같은 이름은 원래 순서를 지킨다 (안정 정렬)
export function sortForeignKeys(fks: readonly ForeignKey[]): ForeignKey[] {
  const key = (f: ForeignKey) => f.name.toLowerCase();
  return [...fks].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
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

// char(10)·varbinary(8) 의 괄호 안 길이 (괄호가 없으면 NaN)
const declaredLength = (col: Pick<Column, 'type'>): number => Number(/\((\d+)\)/.exec(col.type)?.[1]);

// 한 키(인덱스·FK)에 같은 컬럼을 두 번 쓸 수 없다. 컬럼 이름은 대소문자를 구분하지 않는다 (MySQL 8.0.46 실측: 인덱스 종류·길이와 상관없이 1060)
function assertDistinct(columns: readonly string[]): void {
  const dup = columns.find((n, k) => columns.findIndex((m) => sameName(m, n)) !== k);
  if (dup !== undefined) fail(`키에 컬럼 \`${dup}\` 이 두 번 있습니다 (MySQL 1060)`);
}

// 컬럼 정의 안의 PRIMARY KEY(KEY)·UNIQUE [KEY] 는 MySQL 이 그 컬럼 하나짜리 인덱스로 바꾼다 (이름 없는 UNIQUE 는 addIndex 가 컬럼 이름으로 짓는다).
// ALTER TABLE 의 ADD·MODIFY·CHANGE 가 쓴다 (CREATE TABLE 도 같은 규칙). PRIMARY KEY 가 먼저
export function columnKeyItems(spec: ColumnSpec): IndexItem[] {
  const item = (kind: 'PRIMARY' | 'UNIQUE'): IndexItem => ({
    kind: 'index',
    named: kind === 'PRIMARY',
    index: { name: kind === 'PRIMARY' ? 'PRIMARY' : '', kind, parts: [{ column: spec.name, desc: false }], invisible: false },
  });
  return [...(spec.primaryKey ? [item('PRIMARY')] : []), ...(spec.unique ? [item('UNIQUE')] : [])];
}

// 이름을 직접 정한 인덱스(CONSTRAINT 이름·FOREIGN KEY 뒤 인덱스 이름으로 FK 가 만드는 인덱스 포함)의 이름 검사: PRIMARY 는 1280, 이미 있으면 1061 (대소문자 무시).
// 이름을 안 정했을 때처럼 `_2` 를 붙여 피하지 않는다 (MySQL 8.0.46·8.4.11 실측)
function assertIndexNameFree(t: Pick<Table, 'indexes'>, name: string): void {
  if (sameName(name, 'PRIMARY')) fail('인덱스 이름으로 PRIMARY 는 쓸 수 없습니다 (MySQL 1280)');
  if (t.indexes.some((i) => sameName(i.name, name))) fail(`인덱스 이름 \`${name}\` 이 이미 있습니다 (MySQL 1061)`);
}

export function addIndex(t: Table, item: IndexItem): Table {
  const parts = item.index.parts.map((p) => ({ ...p, column: (findColumn(t, p.column!) ?? fail(`키 컬럼 \`${p.column}\` 이 없습니다 (MySQL 1072)`)).name }));
  assertDistinct(parts.map((p) => p.column));
  const written: Index = withoutInnodbHash(t, { ...item.index, parts });
  checkKeyParts(t, written);
  const index: Index = { ...written, parts: written.parts.map((p) => withoutHiddenLength(t, written.kind, p)) };
  if (index.kind === 'PRIMARY') {
    if (t.indexes.some((i) => i.kind === 'PRIMARY')) fail('PRIMARY KEY 가 이미 있습니다 (MySQL 1068)');
    if (index.invisible) fail('PRIMARY KEY 는 INVISIBLE 로 둘 수 없습니다 (MySQL 3522)');
    const pk = new Set(parts.map((p) => p.column.toLowerCase()));
    return { ...t, columns: t.columns.map((c) => (pk.has(c.name.toLowerCase()) ? notNull(c) : c)), indexes: [...t.indexes, { ...index, name: 'PRIMARY' }] };
  }
  const name = item.named ? index.name : uniqueIndexName(t, parts[0].column);
  assertIndexNameFree(t, name);
  return { ...t, indexes: [...t.indexes, { ...index, name }] };
}

// InnoDB 는 USING HASH 를 BTREE 로 만들고 SHOW CREATE 에서 지운다 (USING BTREE 는 남긴다 — MySQL 8.0 실측)
function withoutInnodbHash(t: Table, index: Index): Index {
  if (index.using !== 'HASH' || t.options.find((o) => o.key === 'ENGINE')?.value !== 'InnoDB') return index;
  const next: Index = { ...index };
  delete next.using;
  return next;
}

// MySQL 이 SHOW CREATE 에 찍지 않는 키 파트 길이는 모델에도 남기지 않는다 (8.0.46 실측): FULLTEXT 는 어떤 길이를 받아도 찍지 않고,
// char·varchar·binary·varbinary 는 컬럼 길이와 같은 prefix 길이를 전체 컬럼으로 본다 (varchar(10) 의 KEY (c(10)) → KEY (c)). TEXT·BLOB 의 길이는 늘 찍힌다
function withoutHiddenLength(t: Pick<Table, 'columns'>, kind: IndexKind, part: IndexPart): IndexPart {
  if (part.length === undefined) return part;
  const col = findColumn(t, part.column!)!;
  const isWholeColumn = LENGTH_TYPES.has(baseType(col.type)) && part.length === declaredLength(col);
  if (kind !== 'FULLTEXT' && !isWholeColumn) return part;
  const next: IndexPart = { ...part };
  delete next.length;
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
    if (LENGTH_TYPES.has(base) && p.length > declaredLength(col)) fail(`키 파트 길이가 컬럼 \`${col.name}\` 의 길이보다 깁니다 (MySQL 1089)`);
  }
}

// 컬럼 정의가 NULL 이나 DEFAULT NULL 을 직접 썼는가 (PRIMARY KEY 에 들어가면 1171 — enforcePrimaryKeyNotNull)
export const isExplicitNull = (s: ColumnSpec): boolean => s.nullable === true || s.default?.kind === 'null';

// 문장 끝 검사: PRIMARY KEY 에 든 컬럼은 NOT NULL 이다 — `DEFAULT NULL` 은 없어지고 다른 기본값은 남는다 (MySQL 8.0.46·8.4.11 실측). 기존 PK 컬럼을 NOT NULL 없이 MODIFY·CHANGE 한 경우,
// ADD PRIMARY KEY 로 새 키를 더한 경우, CREATE TABLE 의 PRIMARY KEY 가 모두 이 함수 하나로 처리된다 (키가 다 정해진 뒤에 부른다).
// explicitNull: 이 문장의 컬럼 정의가 NULL 이나 DEFAULT NULL 을 명시한 컬럼의 (최종) 이름, 소문자. 그런 컬럼이 PRIMARY KEY 에 있으면 MySQL 은 1171 로 거부한다
// (절 순서·키를 더한 절과 상관없이; 같은 문장에서 PRIMARY KEY 를 지웠으면 키가 없으니 걸리지 않는다). AUTO_INCREMENT 컬럼의 NOT NULL 은 finalizeColumn 이 만든다
export function enforcePrimaryKeyNotNull(t: Table, explicitNull: ReadonlySet<string> = new Set()): Table {
  const pk = t.indexes.find((i) => i.kind === 'PRIMARY');
  if (!pk) return t;
  const members = new Set(pk.parts.flatMap((p) => (p.column === undefined ? [] : [p.column.toLowerCase()])));
  const isMember = (c: Column) => members.has(c.name.toLowerCase());
  const bad = t.columns.find((c) => isMember(c) && explicitNull.has(c.name.toLowerCase()));
  if (bad) fail(`PRIMARY KEY 컬럼 \`${bad.name}\` 은 NULL 일 수 없습니다 (MySQL 1171)`);
  return { ...t, columns: t.columns.map((c) => (isMember(c) ? notNull(c) : c)) };
}

// 컬럼 정의를 바꾼(MODIFY·CHANGE) 뒤 그 컬럼을 쓰는 기존 키를 새 정의에 맞춘다 (MySQL 8.0.46·8.4.11 실측, sql_table.cc mysql_prepare_alter_table):
// - 키 파트 길이(prefix)는 새 타입이 prefix 를 가질 수 없거나(INT·ENUM …) 새 길이가 prefix 이하이면 오류 없이 없어진다 (varchar(20) 의 c(10) 을
//   varchar(5) 로 줄이면 KEY (c)). 키를 새로 쓸 때(addIndex)와 달리 거부하지 않는다. 새 길이가 더 길거나 TEXT·BLOB 이면 prefix 가 남는다
// - 그 뒤 새 타입이 키에 맞는지 다시 본다: 길이 없는 TEXT·BLOB(1170)·JSON(3152), 문자열이 아닌 FULLTEXT 컬럼(1283)
// changed: 정의를 바꾼 컬럼의 새 이름(소문자). 이름만 바꾸거나 기본값만 바꾼 컬럼은 포함하지 않는다
export function refitKeyParts(t: Table, changed: ReadonlySet<string>): Table {
  if (!changed.size) return t;
  const isChanged = (p: IndexPart) => p.column !== undefined && changed.has(p.column.toLowerCase());
  const indexes = t.indexes.map((i) => {
    if (!i.parts.some(isChanged)) return i;
    const refit: Index = { ...i, parts: i.parts.map((p) => (isChanged(p) ? withoutOutgrownLength(findColumn(t, p.column!)!, p) : p)) };
    checkKeyParts(t, { ...refit, parts: refit.parts.filter(isChanged) }); // 식 파트(column 없음)는 건너뛴다
    return refit;
  });
  return { ...t, indexes };
}

// prefix 가 새 정의에서 쓸모없으면 지운다: prefix 를 가질 수 없는 타입이거나 새 길이가 prefix 이하 (TEXT·BLOB 의 prefix 는 늘 남는다)
function withoutOutgrownLength(col: Column, part: IndexPart): IndexPart {
  if (part.length === undefined) return part;
  const base = baseType(col.type);
  const full = declaredLength(col); // 괄호가 없는 타입은 NaN — 길이를 알 수 없으니 prefix 를 남긴다
  const isKept = BLOB_TYPES.has(base) || (LENGTH_TYPES.has(base) && (Number.isNaN(full) || part.length < full));
  if (isKept) return part;
  const next: IndexPart = { ...part };
  delete next.length;
  return next;
}

// 키 모양: 정수 부호는 키 길이에 영향이 없다 (`int` ≡ `int unsigned`). 나머지는 타입 원문이 같아야 같은 모양이다
const keyShape = (type: string): string => type.replace(/ unsigned$/, '');

// 같은 문장에서 지우고 같은 이름으로 다시 더한 컬럼에도 그 컬럼을 쓰던 키 파트가 따라온다. 이때 MySQL 은 옛 키 파트의 바이트 길이를 새 컬럼에 prefix 로 넘긴다
// (8.0.46·8.4.11 실측: `age int` → `ADD age VARCHAR(5)` 는 `KEY (age(4))`, `varchar(10)` 키 → `varchar(300)` 은 `KEY (code(10))`, prefix 10 → `varchar(5)`·정수는 1089).
// 모양이 같은 타입이면 키 파트가 그대로라 문제없고 (FULLTEXT 는 길이를 보지 않는다), 그 밖의 타입으로 바꾸면 결과를 재현하지 못하므로 거부한다.
// t: 키 삭제·컬럼 반영을 마친 테이블, readded: 지우고 다시 더한 컬럼 이름(소문자)
export function assertReaddedKeysFit(before: Table, t: Table, readded: ReadonlySet<string>): void {
  for (const name of readded) {
    const oldCol = findColumn(before, name);
    const newCol = findColumn(t, name);
    const isKeyed = t.indexes.some((i) => i.kind !== 'FULLTEXT' && i.parts.some((p) => p.column !== undefined && sameName(p.column, name)));
    if (oldCol && newCol && isKeyed && keyShape(oldCol.type) !== keyShape(newCol.type)) {
      fail(`키에 든 컬럼 \`${newCol.name}\` 을 지우고 같은 문장에서 다른 타입(${oldCol.type} → ${newCol.type})으로 다시 더하면 MySQL 이 옛 키 파트 길이를 prefix 로 넘겨 결과가 달라집니다 — MODIFY·CHANGE 를 쓰거나 ${RE_EXPORT}`);
    }
  }
}

// FK 를 붙인다 (받치는 인덱스는 ensureFkIndexes 가 문장 끝에 만든다)
export function addForeignKey(st: State, t: Table, item: FkItem, generatedName?: string): Table {
  const { refSchema, ...rest } = item.fk;
  if (refSchema !== undefined && refSchema !== st.schemaName) fail(`다른 스키마 \`${refSchema}\` 를 참조하는 FK 는 1차 지원 범위가 아닙니다 — ${RE_EXPORT}`);
  const columns = rest.columns.map((n) => (findColumn(t, n) ?? fail(`FK 컬럼 \`${n}\` 이 없습니다 (MySQL 1072)`)).name);
  assertDistinct(columns);
  const name = item.named ? rest.name : generatedName ?? nextFkName(t);
  checkSetNull(t, columns, rest, name);
  const parent = rest.refTable === t.name ? t : findTable(st, rest.refTable);
  if (!parent && st.fkChecks) fail(`참조하는 테이블 \`${rest.refTable}\` 이 없습니다 (MySQL 1824)`);
  if (parent?.parseError) fail(`참조하는 테이블 \`${parent.name}\` 은 파싱하지 못한 정의라 FK 를 검사할 수 없습니다 — ${RE_EXPORT}`);
  const refColumns = parent ? parentKey(st, t, columns, rest.refColumns, parent) : rest.refColumns;
  if (st.model.tables.some((x) => x.name !== t.name && x.foreignKeys.some((f) => sameName(f.name, name))) || t.foreignKeys.some((f) => sameName(f.name, name))) fail(`FK 이름 \`${name}\` 이 이미 있습니다 (MySQL 1826)`);
  const fk: ForeignKey = { ...rest, name, columns, refColumns };
  return { ...t, foreignKeys: [...t.foreignKeys, fk] };
}

// ON DELETE·ON UPDATE SET NULL 은 NOT NULL 컬럼에 쓸 수 없다. 둘 중 하나만 SET NULL 이어도, 여러 컬럼 중 하나만 NOT NULL 이어도 같다
// (MySQL 8.0.46 실측 1830 — 타입 검사 3780·부모 없음 1824 보다 먼저)
function checkSetNull(t: Table, columns: readonly string[], fk: Pick<ForeignKey, 'onDelete' | 'onUpdate'>, name: string): void {
  if (fk.onDelete !== 'SET NULL' && fk.onUpdate !== 'SET NULL') return;
  const notNullColumn = columns.map((n) => findColumn(t, n)!).find((c) => !c.nullable);
  if (notNullColumn) fail(setNullOnNotNull(notNullColumn.name, name));
}

const setNullOnNotNull = (column: string, fkName: string): string => `컬럼 \`${column}\` 은 NOT NULL 이라 FK \`${fkName}\` 의 SET NULL 을 쓸 수 없습니다 (MySQL 1830)`;

// 문장 끝 검사: SET NULL FK 의 컬럼이 NOT NULL 이면 1830 (MySQL 8.0.46·8.4.11 실측). 새로 붙인 FK 는 addForeignKey 가 붙일 때 보지만, PRIMARY KEY 가 컬럼을 암묵적으로
// NOT NULL 로 만드는 것은 FK 를 붙인 뒤(`FOREIGN KEY (x) … SET NULL, PRIMARY KEY (x)`)에 정해지므로 키가 다 정해진 뒤 여기서 본다.
// notNullBefore: 이 문장 앞에 이미 NOT NULL 이던 컬럼 (소문자, 이 문장에서 바뀐 이름) — 기준에 있는 상태는 다시 검사하지 않는다. CREATE TABLE 은 비워 둔다
export function checkSetNullFks(t: Table, notNullBefore: ReadonlySet<string> = new Set()): void {
  for (const fk of t.foreignKeys) {
    if (fk.onDelete !== 'SET NULL' && fk.onUpdate !== 'SET NULL') continue;
    const column = fk.columns.map((n) => findColumn(t, n)!).find((c) => !c.nullable && !notNullBefore.has(c.name.toLowerCase()));
    if (column) fail(setNullOnNotNull(column.name, fk.name));
  }
}

// ALTER TABLE 의 문장 끝 검사: 이 문장에서 NOT NULL 이 된 컬럼(MODIFY·CHANGE 의 NOT NULL, PRIMARY KEY 의 암묵적 NOT NULL)과 이 문장이 더한 컬럼을 본다.
// 같은 문장에서 지운 FK 는 t 에 없으니 보지 않는다. renamed: 이 문장에서 바뀐 컬럼 이름 (소문자 옛 이름 → 새 이름)
export function checkNowNotNull(before: Table, t: Table, renamed: ReadonlyMap<string, string>): void {
  checkSetNullFks(t, new Set(before.columns.filter((c) => !c.nullable).map((c) => (renamed.get(c.name.toLowerCase()) ?? c.name).toLowerCase())));
}

// 부모 쪽 검사: 참조 컬럼이 있고, 타입·콜레이션이 맞고(3780), 참조 컬럼에 정확히 맞는 PRIMARY KEY·UNIQUE 가 있어야 한다 (8.4 6125).
// 돌려주는 값: 부모 컬럼 표기로 쓴 참조 컬럼 이름
function parentKey(st: State, child: Table, columns: readonly string[], refNames: readonly string[], parent: Table): string[] {
  const refs = refNames.map((n) => findColumn(parent, n) ?? fail(`참조 컬럼 \`${parent.name}\`.\`${n}\` 이 없습니다 (MySQL 3734)`));
  if (refs.length !== columns.length) fail('FK 컬럼 수와 참조 컬럼 수가 다릅니다 (MySQL 1239)');
  columns.forEach((n, k) => {
    const a = findColumn(child, n)!;
    if (!fkCompatible(st, child, a, parent, refs[k])) fail(`FK 컬럼 \`${a.name}\` 과 참조 컬럼 \`${refs[k].name}\` 의 타입·문자셋이 맞지 않습니다 (MySQL 3780)`);
  });
  const names = refs.map((r) => r.name);
  const standard = parent.indexes.some((i) => (i.kind === 'PRIMARY' || i.kind === 'UNIQUE') && i.parts.length === names.length && isFkKey(i, names));
  if (!standard) fail(`참조 컬럼 (${names.join(', ')}) 에 정확히 맞는 PRIMARY KEY·UNIQUE 인덱스가 없습니다 (MySQL 8.4 6125 — 8.0 은 일반 인덱스도 받지만 1차에서는 8.4 규칙을 따릅니다)`);
  return names;
}

// 정수·DECIMAL 은 크기·부호까지 같아야 하고 (정수는 표시 폭을 보지 않는다), 문자열은 길이는 달라도 되지만 문자셋·콜레이션이 같아야 한다.
// 테이블 기본 문자셋은 문자열 컬럼 쌍을 비교할 때만 읽는다 (정수 FK 가 지원하지 않는 문자셋 때문에 거부되지 않게)
function fkCompatible(st: State, child: Table, a: Column, parent: Table, b: Column): boolean {
  if (fkKind(a) !== fkKind(b)) return false;
  if (!CHARSET_TYPES.has(baseType(a.type))) return true;
  return effectiveCollation(a, tableCharset(child.options, st.defaults)) === effectiveCollation(b, tableCharset(parent.options, st.defaults));
}

// 비교용 종류: char·varchar 는 'string', binary·varbinary 는 'binary' (길이는 달라도 된다). 정수는 표시 폭을 뺀다 —
// tinyint(1) ↔ tinyint, 5.7 덤프의 int(11) ↔ int 도 같은 타입이다 (8.0.46 실측). 나머지는 타입 원문
function fkKind(c: Column): string {
  const base = baseType(c.type);
  if (base === 'char' || base === 'varchar') return 'string';
  if (base === 'binary' || base === 'varbinary') return 'binary';
  return INT_TYPES.has(base) ? c.type.replace(/^\w+\(\d+\)/, base) : c.type;
}

// 이 문장에서 붙인 FK 에 받치는 인덱스가 없으면 만든다. 이름: CONSTRAINT 이름 → FOREIGN KEY 뒤에 쓴 인덱스 이름 (둘 다 직접 정한 이름이라 겹치면 1061) → 첫 컬럼 (겹치면 _2 …).
// 받치는 인덱스가 이미 있으면 새 인덱스가 필요 없으므로 이름이 같아도 된다 (MySQL 8.0.46·8.4.11 실측)
export function ensureFkIndexes(t: Table, added: readonly { name: string; indexName?: string; named: boolean }[]): Table {
  let next = t;
  for (const a of added) {
    const fk = next.foreignKeys.find((f) => f.name === a.name)!;
    if (next.indexes.some((i) => leadsWith(i, fk.columns))) continue;
    const given = a.named ? fk.name : a.indexName;
    if (given !== undefined) assertIndexNameFree(next, given);
    const name = given ?? uniqueIndexName(next, fk.columns[0]);
    next = { ...next, indexes: [...next.indexes, { name, kind: 'INDEX', parts: fk.columns.map((column) => ({ column, desc: false })), invisible: false }] };
  }
  return next;
}

// 인덱스·FK 정의를 차례로 붙이고, 붙인 FK 에 받치는 인덱스가 없으면 만든다 (ALTER TABLE ADD·CREATE TABLE 공용).
// fkNamesBefore: 이 문장이 시작할 때 있던 FK 이름 (지우는 FK 포함) — 이름 없는 FK 는 이 중 가장 큰 번호 + 1 부터 하나씩 번호를 받는다 (MySQL 8.0.46·8.4.11 실측: 같은 문장에서
// 직접 쓴 이름은 번호에 영향을 주지 않고, 겹치면 1826). 같은 문장에서 지운 FK 와 같은 이름을 다시 쓰는 것도 1826. 안 주면 t 에 있는 FK 이름 (CREATE TABLE 은 빈 테이블로 부른다).
// FK 를 붙인 뒤 sortForeignKeys 를 부르는 것은 부른 쪽의 몫이다
export function addKeys(st: State, t: Table, items: readonly ConstraintItem[], fkNamesBefore: readonly string[] = t.foreignKeys.map((f) => f.name), plan: AutoKeyPlan = planAutoKeys(t, items)): Table {
  let next: Table = { ...t, indexes: [...plan.kept] };
  let generated = highestFkNumber(t.name, fkNamesBefore);
  for (const item of items) {
    if (item.kind === 'index') {
      next = addIndex(next, item);
      markProvenance(st, t.name, [next.indexes.at(-1)!.name], 'user'); // 직접 더한 인덱스: 이 실행이 안다
      continue;
    }
    next = addForeignKey(st, next, item, item.named ? undefined : `${t.name}_ibfk_${++generated}`);
    if (plan.skipped.has(item)) continue;
    const made = ensureFkIndexes(next, [{ name: next.foreignKeys.at(-1)!.name, ...(item.indexName !== undefined ? { indexName: item.indexName } : {}), named: item.named }]);
    if (made.indexes.length > next.indexes.length) markProvenance(st, t.name, [made.indexes.at(-1)!.name], 'auto'); // FK 가 만든 인덱스
    next = made;
  }
  // 같은 문장에서 지운 FK 와 같은 이름(대소문자 무시)으로 다시 더할 수 없다 — 받치는 인덱스가 있어도 1826 (인덱스 이름 충돌 1061 이 먼저 걸린다)
  const reused = items.find((i): i is FkItem => i.kind === 'fk' && i.named && fkNamesBefore.some((n) => sameName(n, i.fk.name)));
  if (reused) fail(`FK 이름 \`${reused.fk.name}\` 이 이미 있습니다 — 같은 문장에서 지운 FK 와 같은 이름으로 다시 더할 수 없습니다 (MySQL 1826)`);
  return next;
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
// 모든 FK 에 받치는 인덱스 — 자기 쪽과 부모 쪽 (1553, 정렬 방향은 보지 않는다 — leadsWith 주석). renamed: 이 문장에서 바뀐 t 의 컬럼 이름 (다른 테이블 FK 의 참조 이름은 아직 옛 이름)
export function checkTable(st: State, t: Table, renamed: ReadonlyMap<string, string> = new Map()): void {
  const autos = t.columns.filter((c) => c.autoIncrement);
  if (autos.length > 1) fail('AUTO_INCREMENT 컬럼은 하나만 둘 수 있습니다 (MySQL 1075)');
  if (autos.length && !t.indexes.some((i) => i.parts[0]?.column !== undefined && sameName(i.parts[0].column, autos[0].name))) fail(`AUTO_INCREMENT 컬럼 \`${autos[0].name}\` 은 인덱스의 첫 컬럼이어야 합니다 (MySQL 1075)`);
  if (t.columns.every((c) => c.invisible)) fail('보이는 컬럼이 하나 이상 있어야 합니다 (MySQL 4028)');
  for (const fk of t.foreignKeys) if (!t.indexes.some((i) => isFkKey(i, fk.columns))) fail(`FK \`${fk.name}\` 에 필요한 인덱스를 지울 수 없습니다 (MySQL 1553)`);
  for (const child of [...st.model.tables.filter((x) => x.name !== t.name), t]) {
    for (const fk of child.foreignKeys) {
      if (fk.refTable !== t.name || fk.refSchema !== undefined) continue;
      const refs = child === t ? fk.refColumns : fk.refColumns.map((n) => renamed.get(n.toLowerCase()) ?? n);
      if (!t.indexes.some((i) => isFkKey(i, refs))) fail(`\`${child.name}\` 의 FK \`${fk.name}\` 가 쓰는 인덱스를 지울 수 없습니다 (MySQL 1553)`);
    }
  }
}

// MySQL 이 키를 저장하는 순서 (sql_table.cc sort_keys, 8.0.46·8.4.11 실측): UNIQUE(PRIMARY 포함) 먼저 — 그 안에서 NULL 허용 파트가 없는 것, PRIMARY,
// 길이 있는 파트가 없는 것, VIRTUAL 이 아닌 것 순 — 그다음 일반 인덱스: FULLTEXT 가 아닌 것, VIRTUAL 이 아닌 것 순. 같은 무리 안은 원래 순서.
// VIRTUAL 키: VIRTUAL 생성 컬럼이나 함수 식 파트가 하나라도 든 키 (STORED 생성 컬럼은 일반 컬럼과 같다). 함수 식 파트가 NULL 허용인지는 쓰는 컬럼 중
// NULL 허용이 있는지로 본다 (IFNULL 처럼 NULL 을 없애는 식은 구분하지 못하는 한계)
export function sortIndexes(t: Table): Index[] {
  const nullable = (p: IndexPart) =>
    (p.column === undefined ? quotedIdentifiers(p.expr ?? '') ?? [] : [p.column]).some((n) => findColumn(t, n)?.nullable === true);
  const virtual = (p: IndexPart) => p.column === undefined || findColumn(t, p.column)?.generated?.stored === false;
  const rank = (i: Index): number[] => {
    const isVirtual = i.parts.some(virtual) ? 1 : 0;
    if (i.kind !== 'PRIMARY' && i.kind !== 'UNIQUE') return [1, i.kind === 'FULLTEXT' ? 1 : 0, isVirtual, 0, 0];
    return [0, i.parts.some(nullable) ? 1 : 0, i.kind === 'PRIMARY' ? 0 : 1, i.parts.some((p) => p.length !== undefined) ? 1 : 0, isVirtual];
  };
  const cmp = (a: number[], b: number[]) => a.reduce((r, x, k) => r || x - b[k], 0);
  return t.indexes.map((i, n) => ({ i, n, r: rank(i) })).sort((a, b) => cmp(a.r, b.r) || a.n - b.n).map((x) => x.i);
}
