// CREATE·DROP·RENAME TABLE
import { renamedAutoName } from '../auto-name';
import { Cursor } from '../cursor';
import type { Table, TableOption } from '../model';
import { parseTableItem } from './def-parser';
import { addKeys, checkSetNullFks, checkTable, columnKeyItems, enforcePrimaryKeyNotNull, isExplicitNull, sortChecks, sortForeignKeys, sortIndexes } from './keys';
import { splitList } from './lists';
import { canonicalCharset, canonicalCollation, charsetOfCollation, finalizeColumn, primaryCollation, tableCharset } from './normalize-mysql';
import { innodbEngineName, optionValue, parseCommonOption, setOption } from './options';
import { findTable, forgetOrigins, moveOrigins, nameTaken, needTable, objectName, objectNameList, sameName, trackNew, type State } from './state';
import { fail, RE_EXPORT, type ConstraintItem } from './types';

// 테이블(또는 뷰) 이름 변경: 다른 테이블 FK 의 참조 테이블과 자동 제약명('<옛>_ibfk_N'·'<옛>_chk_N')이 따라 바뀐다 (MySQL 8.0)
export function renameTable(st: State, from: string, to: string): void {
  if (nameTaken(st, to)) fail(`이름 \`${to}\` 인 테이블·뷰가 이미 있습니다 (MySQL 1050)`);
  if (st.model.views.some((v) => v.name === from)) {
    st.model.views = st.model.views.map((v) => (v.name === from ? { ...v, name: to } : v));
    return;
  }
  const t = needTable(st, from);
  assertRenamedFkNamesFree(st, t, to);
  const foreignKeys = t.foreignKeys.map((f) => ({ ...f, name: renamedAutoName(f.name, from, to, 'ibfk') }));
  const checks = t.checks.map((k) => ({ ...k, name: renamedAutoName(k.name, from, to, 'chk') }));
  const renamed: Table = {
    ...t,
    name: to,
    // 자동 이름이 바뀌면 SHOW CREATE 의 FK·CHECK 순서(이름 순)도 달라진다 (MySQL 8.0.46·8.4.11 실측). 이름이 안 바뀌면 순서를 건드리지 않는다
    foreignKeys: foreignKeys.some((f, i) => f.name !== t.foreignKeys[i].name) ? sortForeignKeys(foreignKeys) : foreignKeys,
    checks: checks.some((k, i) => k.name !== t.checks[i].name) ? sortChecks(checks) : checks,
  };
  st.model.tables = st.model.tables
    .map((x) => (x.name === from ? renamed : x))
    .map((x) => ({ ...x, foreignKeys: x.foreignKeys.map((f) => (f.refTable === from && f.refSchema === undefined ? { ...f, refTable: to } : f)) }));
  moveOrigins(st.origins, from, to);
}

// 테이블 이름을 바꾸면 자동 FK 이름 '<옛>_ibfk_N' 이 '<새>_ibfk_N' 이 된다. FK 이름은 스키마 안에서 유일하고 대소문자를 구분하지 않으므로, 바뀐 이름이 같은 테이블의 다른 FK 나
// 다른 테이블의 FK 와 겹치면 1826 이다 (MySQL 8.0.46·8.4.11 실측: RENAME TABLE·ALTER TABLE … RENAME TO 모두)
function assertRenamedFkNamesFree(st: State, t: Table, to: string): void {
  const names = t.foreignKeys.map((f) => renamedAutoName(f.name, t.name, to, 'ibfk'));
  const others = st.model.tables.filter((x) => x.name !== t.name).flatMap((x) => x.foreignKeys.map((f) => f.name));
  const clash = names.find((name, k) => name !== t.foreignKeys[k].name && [...others, ...names.filter((_, j) => j !== k)].some((n) => sameName(n, name)));
  if (clash !== undefined) fail(`이름을 바꾸면 자동 FK 이름 \`${clash}\` 이 다른 FK 와 겹칩니다: \`${t.name}\` → \`${to}\` (MySQL 1826)`);
}

// CREATE TABLE [IF NOT EXISTS] name (정의…) [옵션…]. LIKE·SELECT·파티션은 1차 범위 밖
export function createTable(st: State, c: Cursor): void {
  const ifNotExists = c.acceptWord('IF', 'NOT', 'EXISTS');
  const name = objectName(c, st);
  if (!c.isOp('(')) fail(`CREATE TABLE … LIKE·SELECT 는 1차 지원 범위가 아닙니다 — ${RE_EXPORT}`);
  if (nameTaken(st, name)) {
    if (ifNotExists) return; // MySQL 은 경고만 남기고 아무것도 하지 않는다
    fail(`테이블 \`${name}\` 이 이미 있습니다 (MySQL 1050)`);
  }
  const items = splitList(c.parenTokens(), '테이블 정의').map((toks) => parseTableItem(new Cursor(toks, c.src)));
  const options = createOptions(c, st);
  const charset = tableCharset(options, st.defaults);
  const specs = items.flatMap((i) => (i.kind === 'column' ? [i.spec] : []));
  if (!specs.length) fail('키·FK 가 쓸 컬럼이 없습니다 — 테이블에는 컬럼이 하나 이상 있어야 합니다 (MySQL 1072)'); // 컬럼 없이 키만 쓴 정의 (MySQL 8.0.46·8.4.11 실측 1072; 빈 괄호는 1064)
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.name.toLowerCase())) fail(`컬럼 \`${s.name}\` 이 두 번 있습니다 (MySQL 1060)`);
    seen.add(s.name.toLowerCase());
  }
  const explicitNull = new Set(specs.filter(isExplicitNull).map((s) => s.name.toLowerCase()));
  let t: Table = { kind: 'table', name, columns: specs.map((s) => finalizeColumn(s, charset)), indexes: [], foreignKeys: [], checks: [], options, fidelity: 'full' };
  // 키는 쓴 차례대로 들어간다: 컬럼 안 PRIMARY KEY·UNIQUE(columnKeyItems)는 그 컬럼 정의를 쓴 자리에서, 표 수준 키·FK 는 쓴 자리에서 (ALTER 의 columnKeys 와 같다).
  // SHOW CREATE 의 같은 무리 안 순서가 이 차례다 (sortIndexes). addKeys 가 인덱스 출처(provenance)도 적는다
  t = addKeys(st, t, items.flatMap((i): ConstraintItem[] => (i.kind === 'column' ? columnKeyItems(i.spec) : [i])));
  t = enforcePrimaryKeyNotNull(t, explicitNull); // PRIMARY KEY 컬럼은 NOT NULL, NULL 을 직접 쓴 컬럼이면 1171
  checkSetNullFks(t); // FK 를 붙인 뒤에 PRIMARY KEY 가 컬럼을 NOT NULL 로 만들었으면 addForeignKey 의 검사가 놓친다 (1830)
  checkTable(st, t);
  t = { ...t, indexes: sortIndexes(t), foreignKeys: sortForeignKeys(t.foreignKeys) };
  st.model.tables = [...st.model.tables, t];
  trackNew(st.origins, t, false);
}

// CREATE TABLE 의 테이블 옵션 → SHOW CREATE 모양 (ENGINE·DEFAULT CHARSET 은 늘 있고, COLLATE 는 showsCollate 일 때만)
function createOptions(c: Cursor, st: State): TableOption[] {
  let charset: string | undefined;
  let collation: string | undefined;
  let rest: TableOption[] = [];
  while (!c.done) {
    c.acceptWord('DEFAULT');
    const common = parseCommonOption(c);
    if (common) rest = setOption(rest, common.key, common.value);
    else if (c.acceptWord('ENGINE')) innodbEngineName(optionValue(c)); // InnoDB 만 받는다 (그 밖의 엔진은 RE_EXPORT 로 거부)
    else if (c.acceptWord('CHARACTER', 'SET') || c.acceptWord('CHARSET')) charset = canonicalCharset(optionValue(c));
    else if (c.acceptWord('COLLATE')) collation = canonicalCollation(optionValue(c));
    else if (c.acceptWord('AUTO_INCREMENT')) optionValue(c);
    else if (c.isWord('PARTITION')) fail(`파티션 절은 1차 지원 범위가 아닙니다 — ${RE_EXPORT}`);
    else fail(`지원하지 않는 테이블 옵션입니다: ${c.peek()?.v ?? '(끝)'} — ${RE_EXPORT}`); // CREATE TABLE … SELECT 와 모델에 없는 옵션
    c.acceptOp(',');
  }
  const coll = collation ?? (charset ? primaryCollation(charset) : st.defaults.collation);
  const cs = charsetOfCollation(coll);
  if (charset && charset !== cs) fail(`COLLATE ${coll} 은 문자셋 ${charset} 의 콜레이션이 아닙니다 (MySQL 1253)`);
  // 기본 문자셋이 binary 인 테이블은 MySQL 이 CHAR·VARCHAR·TEXT 컬럼을 BINARY·VARBINARY·BLOB 으로 바꾼다 (8.0.46·8.4.11 실측) — 컬럼 쪽 CHARACTER SET binary 와 같은 이유로 거부한다
  if (cs === 'binary') fail(`테이블 문자셋 binary 는 MySQL 이 문자열 컬럼을 BINARY·VARBINARY·BLOB 으로 바꿔 1차 지원 범위가 아닙니다 — ${RE_EXPORT}`);
  return [{ key: 'ENGINE', value: 'InnoDB' }, { key: 'DEFAULT CHARSET', value: cs }, ...(showsCollate(cs, coll) ? [{ key: 'COLLATE', value: coll }] : []), ...rest];
}

// SHOW CREATE TABLE 은 utf8mb4 의 콜레이션은 늘 찍고 (기본 utf8mb4_0900_ai_ci 도), 그 밖의 문자셋은 그 문자셋의 기본 콜레이션이면 찍지 않는다 (MySQL 8.0.46·8.4.11 실측).
// 안 찍은 옵션이 모델에 있으면 덤프를 읽은 모델과 달라 비교에서 CONVERT TO CHARACTER SET 변경으로 잡힌다
const showsCollate = (charset: string, collation: string): boolean => charset === 'utf8mb4' || collation !== primaryCollation(charset);

// DROP TABLE [IF EXISTS] a [, b …] [RESTRICT|CASCADE]. 하나라도 없으면(IF EXISTS 제외) 아무것도 지우지 않는다
export function dropTable(st: State, c: Cursor): void {
  const ifExists = c.acceptWord('IF', 'EXISTS');
  const names = objectNameList(c, st);
  const targets = names.filter((n) => findTable(st, n) !== undefined || (ifExists ? false : fail(`테이블 \`${n}\` 이 없습니다 (MySQL 1051)`)));
  if (st.fkChecks) {
    for (const child of st.model.tables) {
      if (targets.includes(child.name)) continue;
      const fk = child.foreignKeys.find((f) => f.refSchema === undefined && targets.includes(f.refTable));
      if (fk) fail(`\`${child.name}\` 의 FK \`${fk.name}\` 가 참조하는 테이블 \`${fk.refTable}\` 은 지울 수 없습니다 (MySQL 3730)`);
    }
  }
  st.model.tables = st.model.tables.filter((t) => !targets.includes(t.name));
  for (const n of targets) forgetOrigins(st.origins, n);
}

// RENAME TABLE a TO b [, c TO d …] — 앞에서부터 차례로 (맞바꾸기는 임시 이름을 거친다)
export function renameTables(st: State, c: Cursor): void {
  for (const toks of splitList(c.toks.slice(c.i), 'RENAME TABLE')) {
    const one = new Cursor(toks, c.src);
    const from = objectName(one, st);
    one.expectWord('TO');
    const to = objectName(one, st);
    if (!one.done) fail(`알 수 없는 내용입니다: ${one.peek()!.v}`);
    renameTable(st, from, to);
  }
}
