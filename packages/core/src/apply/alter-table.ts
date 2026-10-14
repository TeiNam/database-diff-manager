// ALTER TABLE 한 문장. 절 순서와 무관하게 MySQL 과 같은 단계로 적용한다 (sql_table.cc mysql_prepare_alter_table):
// 1) 기존 컬럼 삭제 2) 기존 컬럼 변경 — 이름은 문장 전 컬럼 기준 (RENAME COLUMN a TO b, b TO a 맞바꾸기가 된다) 3) 컬럼 추가
// 4) 위치(FIRST·AFTER) — 3·4 는 컬럼을 더하는 절과 위치를 준 절을 절 순서대로 하나씩 5) 키 삭제 → 남은 키에 컬럼 삭제·이름 변경 반영
// (지우고 같은 이름으로 다시 더한 컬럼의 키는 남는다), 바꾼(MODIFY·CHANGE) 컬럼의 키 파트 길이·타입 맞춤 → 인덱스 이름 변경·가시성
// 6) 키 추가(컬럼 정의 안의 PRIMARY KEY·UNIQUE 포함), FK 자동 인덱스, FK 이름 순 정렬 7) PRIMARY KEY 컬럼 NOT NULL, 검사(NOT NULL 이 된 SET NULL FK 컬럼 포함)·키 순서
// 8) 테이블 옵션 9) 다른 테이블 FK 가 참조하는 컬럼 이름 10) 테이블 이름 변경
import { Cursor } from '../cursor';
import type { Token } from '../lexer';
import type { Column, IndexKind, Table } from '../model';
import { parseColumnSpec, parseConstraint, parseDefault, parseIndexBody, parsePosition, parseUsing, startsConstraint } from './def-parser';
import { assertTargetsKept, classifyFkIndexes, isFlagged, planAutoKeys, renameProvenance, shrunkIndexes, syncProvenance, withoutNames, type AutoKeyPlan } from './auto-index';
import { addKeys, assertKeyPartBytes, assertReaddedKeysFit, checkNowNotNull, checkTable, columnKeyItems, dropKeys, dropSoleColumnChecks, enforcePrimaryKeyNotNull, exprUses, isExplicitNull, isSoleColumnCheck, partitionColumns, refitKeyParts, remapKeys, renameIndex, setIndexVisibility, sortForeignKeys, sortIndexes, type KeyDrop } from './keys';
import { splitList } from './lists';
import { baseType, effectiveCollation, finalizeColumn, NO_LITERAL_DEFAULT, normalizeDefault, tableCharset, type TableCharset } from './normalize-mysql';
import { assertColumnCount, assertForeignKeyCount, assertKeyCount } from './limits';
import { assertInnoDbTable, innodbEngineName, optionValue, parseCommonOption, setOption } from './options';
import { childTables, findColumn, isReferencedColumn, needTable, objectName, renameRefColumns, replaceTable, sameName, type State } from './state';
import { assertZoneFreeDefault } from './session';
import { renameTable } from './table-stmt';
import { fail, RE_EXPORT, type ColumnSpec, type ConstraintItem, type DefaultSpec, type Position } from './types';

const PARTITION = `파티션 절은 1차 지원 범위가 아닙니다 (MySQL 이 행을 옮깁니다) — ${RE_EXPORT}`;
const CHARSET = `테이블 문자셋 변경(CONVERT TO·CHARACTER SET=·COLLATE=)은 1차 지원 범위가 아닙니다 — ${RE_EXPORT}`;
const PARTITION_WORDS: ReadonlySet<string> = new Set(['PARTITION', 'REMOVE', 'COALESCE', 'REORGANIZE', 'TRUNCATE', 'EXCHANGE', 'ANALYZE', 'CHECK', 'OPTIMIZE', 'REBUILD', 'REPAIR', 'DISCARD', 'IMPORT']);
const CHARSET_WORDS: ReadonlySet<string> = new Set(['CONVERT', 'DEFAULT', 'CHARACTER', 'CHARSET', 'COLLATE']);

type Clause =
  | { k: 'add'; spec: ColumnSpec; pos: Position }
  | { k: 'modify'; old: string; spec: ColumnSpec; pos: Position; rename: boolean } // MODIFY(rename=false)·CHANGE(true)
  | { k: 'renameColumn'; old: string; to: string }
  | { k: 'alterColumn'; old: string; set: (col: Column, table: TableCharset) => Column } // table: 테이블 기본 문자셋 (ENUM·SET 기본값의 멤버 찾기)
  | { k: 'dropColumn'; name: string }
  | { k: 'key'; item: ConstraintItem }
  | ({ k: 'dropKey' } & KeyDrop)
  | { k: 'renameIndex'; old: string; to: string }
  | { k: 'indexVisibility'; name: string; invisible: boolean }
  | { k: 'option'; key: string; value: string | undefined }
  | { k: 'renameTable'; to: string }
  | { k: 'noop' };

interface Entry {
  from?: string; // 문장 전 이름 (새 컬럼은 없음)
  col: Column;
}

export function alterTable(st: State, c: Cursor): void {
  const name = objectName(c, st);
  const clauses = splitList(c.toks.slice(c.i), 'ALTER TABLE 절').flatMap((toks) => parseClause(new Cursor(toks, c.src), st));
  if (!clauses.length) fail('ALTER TABLE 에 바꿀 내용이 없습니다');
  alterWith(st, name, clauses);
}

// CREATE [UNIQUE|FULLTEXT|SPATIAL] INDEX name [USING x] ON t (키 파트) [옵션] [ALGORITHM=…] [LOCK=…] = ALTER TABLE t ADD …
export function createIndex(st: State, c: Cursor): void {
  const kind: IndexKind = c.acceptWord('UNIQUE') ? 'UNIQUE' : c.acceptWord('FULLTEXT') ? 'FULLTEXT' : c.acceptWord('SPATIAL') ? 'SPATIAL' : 'INDEX';
  c.expectWord('INDEX');
  const name = c.ident();
  const using = parseUsing(c);
  c.expectWord('ON');
  const table = objectName(c, st);
  const index = parseIndexBody(new Cursor(withoutAlgorithmLock(c.toks.slice(c.i)), c.src), kind, name);
  alterWith(st, table, [{ k: 'key', item: { kind: 'index', index: using && !index.using ? { ...index, using } : index, named: true } }]);
}

// DROP INDEX name ON t [ALGORITHM=…] [LOCK=…] = ALTER TABLE t DROP INDEX name
export function dropIndexOn(st: State, c: Cursor): void {
  const name = c.ident();
  c.expectWord('ON');
  const table = objectName(c, st);
  const rest = withoutAlgorithmLock(c.toks.slice(c.i));
  if (rest.length) fail(`알 수 없는 내용입니다: ${rest[0].v} (MySQL 1064)`);
  alterWith(st, table, [{ k: 'dropKey', what: sameName(name, 'PRIMARY') ? 'primary' : 'index', name }]);
}

function alterWith(st: State, name: string, clauses: readonly Clause[]): void {
  const before = needTable(st, name);
  assertInnoDbTable(before);
  assertForeignKeyCount(before);
  const { table, renamed } = applyClauses(st, before, clauses);
  replaceTable(st, name, table);
  renameRefColumns(st, name, renamed); // 9) 다른 테이블 FK 가 참조하는 컬럼 이름 (자기 참조는 remapKeys 가 고쳤다)
  const rename = clauses.filter((x): x is Extract<Clause, { k: 'renameTable' }> => x.k === 'renameTable').at(-1);
  if (rename && rename.to !== name) renameTable(st, name, rename.to);
}

function parseClause(c: Cursor, st: State): Clause[] {
  if (c.acceptWord('ADD')) return parseAdd(c);
  if (c.acceptWord('MODIFY')) {
    c.acceptWord('COLUMN');
    const spec = parseColumnSpec(c);
    return [end(c, { k: 'modify', old: spec.name, spec, pos: parsePosition(c), rename: false }), ...columnKeys(spec)];
  }
  if (c.acceptWord('CHANGE')) {
    c.acceptWord('COLUMN');
    const old = c.ident();
    const spec = parseColumnSpec(c);
    return [end(c, { k: 'modify', old, spec, pos: parsePosition(c), rename: true }), ...columnKeys(spec)];
  }
  if (c.acceptWord('DROP')) return [end(c, parseDrop(c))];
  if (c.acceptWord('RENAME')) return [end(c, parseRename(c, st))];
  if (c.acceptWord('ALTER')) return [end(c, parseAlter(c, st))];
  return parseOptions(c);
}

// 컬럼 정의 안의 PRIMARY KEY·UNIQUE 는 그 컬럼 절 바로 뒤의 키 절과 같다 (MySQL 도 문장의 키 목록에 쓴 차례대로 넣는다)
const columnKeys = (spec: ColumnSpec): Clause[] => columnKeyItems(spec).map((item) => ({ k: 'key', item }));

// 절 끝: 남은 토큰이 있으면 실패
function end<T>(c: Cursor, clause: T): T {
  if (!c.done) fail(`알 수 없는 내용입니다: ${c.peek()!.v} (MySQL 1064)`);
  return clause;
}

function parseAdd(c: Cursor): Clause[] {
  if (c.isWord('PARTITION')) return fail(PARTITION);
  if (!c.acceptWord('COLUMN') && startsConstraint(c)) return [end(c, { k: 'key', item: parseConstraint(c) })];
  if (c.isOp('(')) {
    const specs = splitList(c.parenTokens(), '컬럼').map((toks) => {
      const one = new Cursor(toks, c.src);
      return end(one, parseColumnSpec(one));
    });
    return end(c, specs.flatMap((spec): Clause[] => [{ k: 'add', spec, pos: undefined }, ...columnKeys(spec)]));
  }
  const spec = parseColumnSpec(c);
  return [end(c, { k: 'add', spec, pos: parsePosition(c) }), ...columnKeys(spec)];
}

function parseDrop(c: Cursor): Clause {
  if (c.acceptWord('PRIMARY', 'KEY')) return { k: 'dropKey', what: 'primary', name: 'PRIMARY' };
  if (c.acceptWord('INDEX') || c.acceptWord('KEY')) return { k: 'dropKey', what: 'index', name: c.ident() };
  if (c.acceptWord('FOREIGN', 'KEY')) return { k: 'dropKey', what: 'fk', name: c.ident() };
  if (c.acceptWord('CHECK')) return { k: 'dropKey', what: 'check', name: c.ident() };
  if (c.acceptWord('CONSTRAINT')) return { k: 'dropKey', what: 'constraint', name: c.ident() };
  if (c.isWord('PARTITION')) return fail(PARTITION);
  c.acceptWord('COLUMN');
  const name = c.ident();
  if (!c.acceptWord('RESTRICT')) c.acceptWord('CASCADE');
  return { k: 'dropColumn', name };
}

function parseRename(c: Cursor, st: State): Clause {
  if (c.acceptWord('COLUMN')) {
    const old = c.ident();
    c.expectWord('TO');
    return { k: 'renameColumn', old, to: c.ident() };
  }
  if (c.acceptWord('INDEX') || c.acceptWord('KEY')) {
    const old = c.ident();
    c.expectWord('TO');
    return { k: 'renameIndex', old, to: c.ident() };
  }
  if (!c.acceptWord('TO')) c.acceptWord('AS');
  return { k: 'renameTable', to: objectName(c, st) };
}

function parseAlter(c: Cursor, st: State): Clause {
  if (c.acceptWord('INDEX')) {
    const name = c.ident();
    if (c.acceptWord('INVISIBLE')) return { k: 'indexVisibility', name, invisible: true };
    c.expectWord('VISIBLE');
    return { k: 'indexVisibility', name, invisible: false };
  }
  if (c.isWord('CHECK') || c.isWord('CONSTRAINT')) return fail(`ALTER CHECK·CONSTRAINT 는 1차 지원 범위가 아닙니다 — ${RE_EXPORT}`);
  c.acceptWord('COLUMN');
  const old = c.ident();
  if (c.acceptWord('SET', 'DEFAULT')) {
    if (c.isOp('(')) return fail(`식 기본값 SET DEFAULT (…) 은 1차 지원 범위가 아닙니다 — ${RE_EXPORT}`);
    const value = parseDefault(c);
    return { k: 'alterColumn', old, set: (col, table) => setDefault(st, col, value, table) };
  }
  if (c.acceptWord('DROP', 'DEFAULT')) return { k: 'alterColumn', old, set: dropDefault };
  if (c.acceptWord('SET', 'VISIBLE')) return { k: 'alterColumn', old, set: (col) => ({ ...col, invisible: false }) };
  if (c.acceptWord('SET', 'INVISIBLE')) return { k: 'alterColumn', old, set: (col) => ({ ...col, invisible: true }) };
  return fail(`알 수 없는 ALTER COLUMN 절입니다: ${c.peek()?.v ?? '(끝)'} (MySQL 1064)`);
}

// 기본값을 바꾼다 (undefined 면 DEFAULT 절이 없다 — 키를 남기지 않는다: 모델 해시·왕복 비교가 키 유무를 본다)
function withDefault(col: Column, value: string | undefined): Column {
  const next: Column = { ...col };
  delete next.default;
  return value === undefined ? next : { ...next, default: value };
}

// ALTER COLUMN … SET DEFAULT 값 (MySQL 8.0.46·8.4.11 실측). TEXT·BLOB·JSON·GEOMETRY 는 NULL 이든 리터럴이든 1101 이다 (NOT NULL 이어도, 생성 컬럼이어도 다른 오류보다 먼저 — 컬럼 정의의
// `DEFAULT NULL` 은 받지만 SET DEFAULT 는 아니다). 생성 컬럼(VIRTUAL·STORED)은 1221. AUTO_INCREMENT 컬럼은 값을 검증한 뒤 받지만 SHOW CREATE 에 기본값이 찍히지 않아 저장하지 않는다
function setDefault(st: State, col: Column, value: DefaultSpec, table: TableCharset): Column {
  const base = baseType(col.type);
  if (NO_LITERAL_DEFAULT.has(base)) fail(`${base.toUpperCase()} 컬럼 \`${col.name}\` 에는 기본값을 쓸 수 없습니다 (MySQL 1101)`);
  if (col.generated) fail(`생성 컬럼 \`${col.name}\` 에는 DEFAULT 를 쓸 수 없습니다 (MySQL 1221)`);
  const normalized = normalizeDefault(value, col, table);
  assertZoneFreeDefault(st, col.name, col.type, value);
  return withDefault(col, col.autoIncrement ? undefined : normalized);
}

// DROP DEFAULT: DEFAULT 절이 없어진다. NULL 허용 컬럼도 `DEFAULT NULL` 이 사라진다 (MySQL 8.0.46·8.4.11 실측: `n1 varchar(10)` 으로 찍힌다).
// 그 뒤 SET DEFAULT NULL 을 하면 다시 `DEFAULT NULL` 이 보인다
const dropDefault = (col: Column): Column => withDefault(col, undefined);

// 테이블 옵션 (쉼표 없이 이어 쓸 수 있다). ROW_FORMAT=DEFAULT·KEY_BLOCK_SIZE=0·COMMENT='' 는 옵션을 지운다
function parseOptions(c: Cursor): Clause[] {
  const out: Clause[] = [];
  while (!c.done) {
    const word = c.peek()!.v.toUpperCase();
    const common = parseCommonOption(c);
    if (common) out.push({ k: 'option', ...common });
    else if (c.acceptWord('ENGINE')) out.push({ k: 'option', key: 'ENGINE', value: innodbEngineName(optionValue(c)) });
    else if (c.acceptWord('AUTO_INCREMENT') || c.acceptWord('ALGORITHM') || c.acceptWord('LOCK')) {
      optionValue(c);
      out.push({ k: 'noop' });
    } else if (c.acceptWord('FORCE')) out.push({ k: 'noop' });
    else if (CHARSET_WORDS.has(word)) fail(CHARSET);
    else if (PARTITION_WORDS.has(word)) fail(PARTITION);
    else fail(`지원하지 않는 ALTER TABLE 절입니다: ${c.peek()!.v} — ${RE_EXPORT}`);
  }
  return out;
}

function applyClauses(st: State, before: Table, clauses: readonly Clause[]): { table: Table; renamed: Map<string, string> } {
  const charset = tableCharset(before.options, st.defaults);
  const pick = <K extends Clause['k']>(k: K) => clauses.filter((x): x is Extract<Clause, { k: K }> => x.k === k);
  const dropped = droppedColumns(before, pick('dropColumn')); // 1) 기존 컬럼 삭제
  assertColumnCount(before.columns.length - dropped.size + pick('add').length); // 컬럼 1017개 한도 (1117) — 위치를 찾기 전에 보아 계산량을 묶는다
  const entries = arrangeColumns(st, before, clauses, charset, dropped); // 2) 기존 컬럼 변경 (이름은 문장 전 기준) 3) 컬럼 추가 4) 위치
  assertUniqueColumns(entries);
  const renamed = new Map(entries.filter((e) => e.from !== undefined && e.from !== e.col.name).map((e) => [e.from!.toLowerCase(), e.col.name]));
  assertNoDependents(st, before, dropped, renamed, pick('dropKey'));
  updateColumnOrigins(st, before.name, entries);
  const renames = pick('renameIndex');
  // 문장 시작에 아는 출처·덤프 이름으로 가린 FK 자동 인덱스. RENAME INDEX 가 건드린 옛 이름·새 이름은 뺀다 (자동 표시가 지워지고, 다른 인덱스가 그 이름을 이어받는다)
  const flagged = withoutNames(classifyFkIndexes(before, st.origins.provenance.get(before.name)), renames.flatMap((r) => [r.old, r.to]));
  let t = dropSoleColumnChecks(keepKeys(before, entries, clauses, dropped, renamed), dropped); // 5) 키 삭제 → 컬럼 변화 반영 (지우는 컬럼만 쓰는 CHECK 도 함께) → 인덱스 이름 변경·가시성
  for (const r of renames) {
    t = renameIndex(t, r.old, r.to);
    moveIndexOrigin(st, before.name, r.old, r.to);
    renameProvenance(st, before.name, r.old, r.to);
  }
  for (const v of pick('indexVisibility')) t = setIndexVisibility(t, v.name, v.invisible);
  const items = pick('key').map((x) => x.item);
  assertKeyCount(t.indexes.filter((i) => !isFlagged(flagged, i.name)).length + items.filter((i) => i.kind === 'index').length); // 버려지지 않는 키만 세어도 64개를 넘으면 1069
  const plan = planAutoKeys(t, items, flagged, shrunkIndexes(before, t, renames)); // 이 문장의 키(더한 키·DROP COLUMN 으로 줄어든 키)가 FK 자동 인덱스를 대신하는가
  const existing = new Set(t.indexes); // 문장 앞부터 있던 키 (키 순서 — sortIndexes)
  t = addConstraints(st, before, t, items, plan); // 6) 키 추가와 FK 자동 인덱스
  assertTargetsKept(t, pick('indexVisibility').map((v) => v.name)); // 버려진 자동 인덱스에 ALTER INDEX 를 썼으면 1176
  t = enforcePrimaryKeyNotNull(t, explicitNullColumns(clauses)); // 7) PRIMARY KEY 컬럼 NOT NULL·검사·키 순서 8) 테이블 옵션
  checkNowNotNull(before, t, renamed);
  checkTable(st, t, renamed);
  t = { ...t, indexes: sortIndexes(t, { before, existing, renames }) };
  syncIndexOrigins(st, before.name, t);
  syncProvenance(st, before.name, t, flagged);
  for (const o of pick('option')) t = { ...t, options: setOption(t.options, o.key, o.value) };
  assertKeyPartBytes(t, st.defaults); // 이 문장에서 바꾼 ROW_FORMAT 으로 본다
  return { table: t, renamed };
}

// 지우는 컬럼 (소문자 이름). 같은 컬럼을 두 번 지우면 MySQL 은 1091 (대소문자 무시, 실측)
function droppedColumns(before: Table, drops: readonly Extract<Clause, { k: 'dropColumn' }>[]): Set<string> {
  const dropped = new Set<string>();
  for (const d of drops) {
    const name = (findColumn(before, d.name) ?? fail(`컬럼 \`${d.name}\` 이 없습니다 (MySQL 1091)`)).name.toLowerCase();
    if (dropped.has(name)) fail(`컬럼 \`${d.name}\` 을 두 번 지울 수 없습니다 (MySQL 1091)`);
    dropped.add(name);
  }
  return dropped;
}

// 5) 키 삭제 → 남은 키에 컬럼 삭제·이름 변경 반영 → 바꾼 컬럼의 키 파트 길이·타입 맞춤. 같은 문장에서 지우고 같은 이름으로 다시 더한 컬럼의 키 파트는
// 새 컬럼에 남는다 (컬럼 이름이 같아졌을 뿐인 CHANGE·RENAME COLUMN 대상에는 안 남는다 — MySQL 8.0.46·8.4.11 실측)
function keepKeys(before: Table, entries: readonly Entry[], clauses: readonly Clause[], dropped: ReadonlySet<string>, renamed: ReadonlyMap<string, string>): Table {
  const added = new Set(clauses.flatMap((x) => (x.k === 'add' ? [x.spec.name.toLowerCase()] : [])));
  const readded = new Set([...dropped].filter((n) => added.has(n)));
  const keyDrops = clauses.filter((x): x is Extract<Clause, { k: 'dropKey' }> => x.k === 'dropKey');
  const t = remapKeys(dropKeys({ ...before, columns: entries.map((e) => e.col) }, keyDrops), new Set([...dropped].filter((n) => !readded.has(n))), renamed);
  assertReaddedKeysFit(before, t, readded);
  const modified = clauses.flatMap((x) => (x.k === 'modify' ? [x.spec.name.toLowerCase()] : []));
  return refitKeyParts(t, new Set([...modified, ...readded]));
}

// 6) 키 추가와 FK 자동 인덱스. 이름 없는 FK 번호는 이 문장 앞의 FK 이름(지우는 것 포함) 기준이고, FK 를 더했으면 SHOW CREATE 순서(이름 순)로 다시 놓는다
function addConstraints(st: State, before: Table, t: Table, items: readonly ConstraintItem[], plan: AutoKeyPlan): Table {
  const next = addKeys(st, t, items, before.foreignKeys.map((f) => f.name), plan, before);
  return items.some((i) => i.kind === 'fk') ? { ...next, foreignKeys: sortForeignKeys(next.foreignKeys) } : next;
}

// 이 문장의 컬럼 정의가 NULL 이나 DEFAULT NULL 을 쓴 컬럼의 (최종) 이름, 소문자 — PRIMARY KEY 에 있으면 1171 (enforcePrimaryKeyNotNull)
function explicitNullColumns(clauses: readonly Clause[]): Set<string> {
  const specs = clauses.flatMap((x) => (x.k === 'add' || x.k === 'modify' ? [x.spec] : []));
  return new Set(specs.filter(isExplicitNull).map((s) => s.name.toLowerCase()));
}

// 2) 기존 컬럼 변경 3) 컬럼 추가 4) 위치. 컬럼을 더하는 절과 FIRST·AFTER 를 준 MODIFY·CHANGE 는 절 순서대로 하나씩 목록에 넣는다 — MySQL 8.0.46·8.4.11 실측:
// AFTER 는 그때까지 목록에 든 컬럼(바뀐 컬럼은 새 이름)만 보므로, 뒤 절에서 더하거나 옮기는 컬럼을 앞서 가리키면 1054. 옮기는 컬럼은 옮기기 전 자리에 있다가 자기 절 차례에 빠져나온다
function arrangeColumns(st: State, before: Table, clauses: readonly Clause[], charset: TableCharset, dropped: ReadonlySet<string>): Entry[] {
  const list: Entry[] = before.columns.filter((col) => !dropped.has(col.name.toLowerCase())).map((col) => ({ from: col.name, col }));
  const moved = changeColumns(st, before, list, clauses, charset);
  for (const ch of clauses) {
    if (ch.k === 'add') insertEntry(list, { col: finalizeIn(st, ch.spec, charset) }, ch.pos);
    else if (ch.k === 'modify' && moved.has(ch)) {
      const e = moved.get(ch)!;
      list.splice(list.indexOf(e), 1);
      insertEntry(list, e, ch.pos);
    }
  }
  return list;
}

// 위치가 있는 MODIFY·CHANGE 절 → 그 컬럼. 컬럼 정의(타입·이름)는 여기서 바뀌고, 자리는 arrangeColumns 가 정한다
function changeColumns(st: State, before: Table, entries: Entry[], clauses: readonly Clause[], charset: TableCharset): Map<Clause, Entry> {
  const touched = new Set<string>();
  const moved = new Map<Clause, Entry>();
  for (const ch of clauses) {
    if (ch.k !== 'modify' && ch.k !== 'renameColumn' && ch.k !== 'alterColumn') continue;
    const e = entries.find((x) => x.from !== undefined && sameName(x.from, ch.old)) ?? fail(`컬럼 \`${ch.old}\` 이 없습니다 (MySQL 1054)`);
    if (touched.has(e.from!)) fail(`한 문장에서 컬럼 \`${ch.old}\` 을 두 번 바꿀 수 없습니다 (MySQL 1054)`);
    touched.add(e.from!);
    if (ch.k === 'renameColumn') e.col = { ...e.col, name: ch.to };
    else if (ch.k === 'alterColumn') e.col = ch.set(e.col, charset);
    else {
      // MODIFY·CHANGE 정의에는 AS 를 쓸 수 없으므로(파서가 거부한다) 생성 컬럼이면 일반 컬럼으로 바꾸는 절이다. STORED 는 바뀌지만 VIRTUAL 은 MySQL 이 거부한다 (실측 3106)
      if (e.col.generated && !e.col.generated.stored) fail(`VIRTUAL 생성 컬럼 \`${e.col.name}\` 은 일반 컬럼으로 바꿀 수 없습니다 — 생성 컬럼의 STORED 여부는 바꿀 수 없습니다 (MySQL 3106)`);
      if (!ch.rename && ch.spec.name !== e.col.name) fail(`MODIFY 에 쓴 이름 \`${ch.spec.name}\` 이 컬럼 \`${e.col.name}\` 과 대소문자가 다릅니다 — 이름을 바꾸려면 CHANGE 를 쓰세요`);
      const next = finalizeIn(st, ch.spec, charset);
      assertRetypeAllowed(st, before, e.col, next, charset);
      e.col = next;
      if (ch.pos) moved.set(ch, e);
    }
  }
  return moved;
}

// 컬럼 정의 → Column. 세션 time_zone 을 바꾼 뒤의 TIMESTAMP 리터럴 기본값은 받지 않는다 (assertZoneFreeDefault — 값 검사(1067)가 먼저다)
function finalizeIn(st: State, spec: ColumnSpec, charset: TableCharset): Column {
  const col = finalizeColumn(spec, charset);
  assertZoneFreeDefault(st, spec.name, spec.type, spec.default);
  return col;
}

function insertEntry(list: Entry[], e: Entry, pos: Position): void {
  if (!pos) list.push(e);
  else if ('first' in pos) list.unshift(e);
  else {
    const at = list.findIndex((x) => sameName(x.col.name, pos.after));
    if (at < 0) fail(`AFTER 에 쓴 컬럼 \`${pos.after}\` 이 없습니다 (MySQL 1054)`);
    list.splice(at + 1, 0, e);
  }
}

function assertUniqueColumns(entries: readonly Entry[]): void {
  if (!entries.length) fail('테이블의 모든 컬럼을 지울 수 없습니다 — DROP TABLE 을 쓰세요 (MySQL 1090)');
  const seen = new Set<string>();
  for (const { col } of entries) {
    if (seen.has(col.name.toLowerCase())) fail(`컬럼 \`${col.name}\` 이 두 번 있습니다 (MySQL 1060)`);
    seen.add(col.name.toLowerCase());
  }
}

// 지우거나 이름을 바꾸는 컬럼을 쓰는 것: 생성 컬럼(3108)·CHECK(3959, 그 컬럼만 쓰는 CHECK 를 지울 때는 제외)·함수 인덱스(3837)·파티션 식(3855)은 MySQL 이 거부하고, 지우는 컬럼을 쓰는
// FK 는 자기 쪽 1828, 다른 테이블(자기 참조 포함) 쪽 1829. 같은 문장에서 함께 지우는 키는 빼고 본다
function assertNoDependents(st: State, t: Table, dropped: ReadonlySet<string>, renamed: ReadonlyMap<string, string>, keyDrops: readonly KeyDrop[]): void {
  const changed = [...dropped, ...renamed.keys()];
  if (!changed.length) return;
  const keyDropped = (what: KeyDrop['what'], name: string) => keyDrops.some((d) => (d.what === what || d.what === 'constraint') && sameName(d.name, name));
  for (const name of changed) {
    const gen = t.columns.find((c) => c.generated && !dropped.has(c.name.toLowerCase()) && exprUses(c.generated.expr, name));
    if (gen) fail(`생성 컬럼 \`${gen.name}\` 이 쓰는 컬럼 \`${name}\` 은 지우거나 이름을 바꿀 수 없습니다 (MySQL 3108)`);
    const check = t.checks.find((k) => !keyDropped('check', k.name) && exprUses(k.expr, name) && !isSoleColumnCheck(k, dropped));
    if (check) fail(`CHECK \`${check.name}\` 이 쓰는 컬럼 \`${name}\` 은 지우거나 이름을 바꿀 수 없습니다 (MySQL 3959)`);
    if (t.partition && partitionColumns(t.partition).has(name.toLowerCase())) fail(`파티션 식이 쓰는 컬럼 \`${name}\` 은 지우거나 이름을 바꿀 수 없습니다 (MySQL 3855)`);
    const fn = t.indexes.find((i) => !keyDropped('index', i.name) && i.parts.some((p) => p.expr !== undefined && exprUses(p.expr, name)));
    if (fn) fail(`함수 인덱스 \`${fn.name}\` 이 쓰는 컬럼 \`${name}\` 은 지우거나 이름을 바꿀 수 없습니다 (MySQL 3837)`);
  }
  for (const name of dropped) {
    const own = t.foreignKeys.find((f) => !keyDropped('fk', f.name) && f.columns.some((c) => sameName(c, name)));
    if (own) fail(`FK \`${own.name}\` 가 쓰는 컬럼 \`${name}\` 은 지울 수 없습니다 (MySQL 1828)`);
    if (!isReferencedColumn(st, t.name, name)) continue; // 참조 색인: 아무 FK 도 참조하지 않는 컬럼이면 자식 테이블을 훑지 않는다
    for (const child of childTables(st, t.name)) {
      const fk = child.foreignKeys.find((f) => f.refTable === t.name && f.refSchema === undefined && !(child.name === t.name && keyDropped('fk', f.name)) && f.refColumns.some((c) => sameName(c, name)));
      if (fk) fail(`\`${child.name}\` 의 FK \`${fk.name}\` 가 참조하는 컬럼 \`${name}\` 은 지울 수 없습니다 (MySQL 1829)`);
    }
  }
}

// FK 로 이어진 컬럼(자기 FK 컬럼·다른 테이블이 참조하는 컬럼)의 타입·콜레이션 변경은 1차 범위 밖 (MySQL 3780 과 허용 사례를 가르지 않는다)
function assertRetypeAllowed(st: State, t: Table, old: Column, next: Column, charset: TableCharset): void {
  if (old.type === next.type && effectiveCollation(old, charset) === effectiveCollation(next, charset)) return;
  const linked = t.foreignKeys.some((f) => f.columns.some((c) => sameName(c, old.name))) || isReferencedColumn(st, t.name, old.name);
  if (linked) fail(`FK 로 이어진 컬럼 \`${old.name}\` 의 타입·문자셋 변경은 1차 지원 범위가 아닙니다 — ${RE_EXPORT}`);
}

function updateColumnOrigins(st: State, table: string, entries: readonly Entry[]): void {
  const before = st.origins.columns.get(table) ?? new Map<string, string | undefined>();
  st.origins.columns.set(table, new Map(entries.map((e) => [e.col.name, e.from === undefined ? undefined : before.get(e.from)])));
}

function moveIndexOrigin(st: State, table: string, from: string, to: string): void {
  const m = st.origins.indexes.get(table);
  const key = m && [...m.keys()].find((k) => sameName(k, from));
  if (!m || key === undefined) return;
  const origin = m.get(key);
  m.delete(key);
  m.set(to, origin);
}

// 키 목록에 맞춰 인덱스 이름 추적을 정리한다 (지운 키는 빠지고 새 키는 undefined)
function syncIndexOrigins(st: State, table: string, t: Table): void {
  const m = st.origins.indexes.get(table) ?? new Map<string, string | undefined>();
  st.origins.indexes.set(table, new Map(t.indexes.map((i) => [i.name, m.get(i.name)])));
}

// 끝의 ALGORITHM [=] x · LOCK [=] x 는 스키마에 영향이 없어 뺀다
function withoutAlgorithmLock(toks: readonly Token[]): Token[] {
  const out = [...toks];
  const isKey = (k: number) => out[k]?.t === 'word' && /^(ALGORITHM|LOCK)$/i.test(out[k].v);
  for (;;) {
    const n = out.length;
    if (n >= 3 && isKey(n - 3) && out[n - 2].t === 'op' && out[n - 2].v === '=') out.splice(n - 3, 3);
    else if (n >= 2 && isKey(n - 2)) out.splice(n - 2, 2);
    else return out;
  }
}
