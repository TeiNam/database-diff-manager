// ALTER 적용 중 상태: 작업용 모델 사본, 세션 값(FOREIGN_KEY_CHECKS·SQL_MODE·time_zone 이 UTC 인지 — 모르는 값이면 그 까닭), 기준 이름 추적
import { Cursor } from '../cursor';
import { routineNameKey } from '../diff';
import type { Column, ForeignKey, Routine, SchemaModel, Table } from '../model';
import { splitList } from './lists';
import { fail, RE_EXPORT, type ApplyDefaults } from './types';

// src 타입 검사(tsconfig.src.json)는 DOM·node 타입 없이 ES2023 lib 만 쓰므로 전역 structuredClone 이 선언되어 있지 않다.
// 실행 환경(Node 17+·브라우저)은 전역으로 제공하므로 선언만 둔다 (모듈 안 선언이라 실행 코드는 생기지 않는다)
declare function structuredClone<T>(value: T): T;

// 이 실행(applyScript)이 아는 인덱스 출처. auto: FK 가 자동으로 만든 인덱스 (FK 를 지워도 MySQL 의 자동 표시는 남는다), user: 직접 더한 인덱스·RENAME INDEX 한 인덱스.
// 기준 덤프에서 온 인덱스는 출처를 모른다 (표에 없다 — 덤프의 이름으로 짐작한다, auto-index.ts)
export type IndexProvenance = 'auto' | 'user';

// 지금 이름 → 기준 버전 이름 (스크립트에서 새로 만든 것은 undefined). 끝에서 rename 매핑을 만든다
export interface Origins {
  tables: Map<string, string | undefined>;
  columns: Map<string, Map<string, string | undefined>>; // 테이블(지금 이름) → (컬럼 지금 이름 → 기준 이름)
  indexes: Map<string, Map<string, string | undefined>>;
  provenance: Map<string, Map<string, IndexProvenance>>; // 테이블(지금 이름) → (인덱스 이름 소문자 → 출처). auto-index.ts 의 markProvenance 가 적는다
}

// 부모 테이블을 같은 참조 컬럼 목록으로 참조하는 FK 들. columns: 참조 컬럼 (소문자, FK 에 쓴 차례), children: 그 FK 를 가진 테이블 → 그 테이블의 FK 수
export interface RefList {
  readonly columns: readonly string[];
  readonly children: Map<string, number>;
}

// 모르는 값 (리뷰 10회차): 값을 모르는 변수(저장하지 않았거나 저장 함수 호출 뒤 잊은 사용자 변수, @@global 서버 변수 …)에서 정한 사용자 변수.
// unknown 은 왜 모르는지 밝힌 안내 글이다 — 그 값을 모르게 만든 앞 문장을 적는다. 그 값을 읽는 SET 도 받고, 값에 기대는 뒤 문장만 거부한다 (unknown-session.ts)
export interface Unknown {
  readonly unknown: string;
}
export type SessionValue = string | Unknown;
export const isUnknown = (v: SessionValue): v is Unknown => typeof v !== 'string';

export interface State {
  model: SchemaModel; // ponytail: 작업용 사본 하나를 고쳐 쓴다 (입력 모델은 그대로, 실패하면 통째로 버린다)
  readonly schemaName: string;
  readonly defaults: ApplyDefaults;
  fkChecks: boolean;
  // 세션 FOREIGN_KEY_CHECKS 를 모르면 그 까닭 (안내 글, 알면 undefined) — 앞의 SET 이 값을 모르는 변수에서 정했다. 모르는 동안은 fkChecks 를 쓰지 않는다 (unknown-session.ts)
  fkChecksUnknown: string | undefined;
  sqlMode: string;
  // 세션 SQL_MODE 를 모르면 그 까닭 (안내 글, 알면 undefined). 모르는 동안은 sqlMode 를 쓰지 않는다 — 모드에 기대는 문장을 거부한다 (unknown-session.ts)
  sqlModeUnknown: string | undefined;
  // 처음 세션 SQL_MODE (ApplyOptions.sqlMode, 주지 않았으면 MySQL 기본 모드) — 스크립트를 실행한 서버의 sql_mode 다. SET sql_mode = DEFAULT 가 이 값으로 되돌린다 (session.ts)
  readonly initialSqlMode: string;
  // 스크립트가 서버(GLOBAL·PERSIST) sql_mode 를 바꿨는가 — 바꾼 뒤의 SET sql_mode = DEFAULT 는 바뀐 전역 값을 읽는데 그 값은 알 수 없어 세션 SQL_MODE 를 모르는 값으로 둔다
  // (session.ts sqlModeDefault, 리뷰 7회차 R7-1·10회차)
  serverSqlModeChanged: boolean;
  timeZoneUtc: boolean; // 스크립트가 세션 time_zone 을 UTC 로 정했는가 — 아니면 서버 시간대라 TIMESTAMP 리터럴 기본값을 받지 않는다 (session.ts assertUtcTimestampDefault)
  // 세션 time_zone 을 모르는 까닭 ('…어' 로 끝나는 안내 글 — 그 뒤 time_zone 을 다시 정하면 지운다). 이때 timeZoneUtc 는 false 다: UTC 로 정한 세션 time_zone 을 바꿨을 수 있는
  // 저장 함수 호출(stored-call.ts), 값을 모르는 변수에서 정한 SET (session.ts). 없으면 서버 시간대라 모른다
  timeZoneUnknown: string | undefined;
  // SET @v = … 로 저장한 사용자 변수 (소문자, '@' 포함) — 모르는 값을 넣었으면 Unknown 이다. 무시한 문장이 저장 함수를 부르면 모두 잊는다 (stored-call.ts)
  readonly saved: Map<string, SessionValue>;
  // 저장 함수 호출이 잊게 한 사용자 변수 — 호출 전에 저장한 것이다. 안내에만 쓴다: 다시 저장하면 saved 를 먼저 본다 (session.ts unknownVariable, 리뷰 9회차)
  readonly forgotten: Set<string>;
  // 무시한 문장이 부른 마지막 저장 함수 (안내에 쓰는 이름). 함수는 사용자 변수·세션 time_zone·전역 sql_mode 를 바꿀 수 있는데, 문장을 실행하지 않아 바뀐 값을 모른다 —
  // 그 뒤 값을 다시 정하지 않은 사용자 변수와 SET sql_mode = DEFAULT 가 정한 세션 SQL_MODE 는 모르는 값이다 (session.ts, 리뷰 8회차·10회차)
  storedCall: string | undefined;
  readonly origins: Origins;
  // 테이블 이름 → st.model.tables 안의 자리. 이름 목록은 늘 정확하고 (테이블을 더하고 지우고 이름을 바꾸는 CREATE·DROP·RENAME TABLE 이 고친다),
  // 자리는 DROP TABLE 뒤에 어긋날 수 있어 tableIndex 가 확인한다. 테이블이 수만 개인 스크립트에서도 문장마다 모든 테이블을 훑어 이름을 찾지 않게 한다
  readonly tableAt: Map<string, number>;
  // 스키마의 FK 이름(소문자) → 개수와, FK 가 참조하는 테이블(부모) 이름 → 참조 컬럼 목록(소문자 JSON) → RefList (다른 스키마를 참조하는 FK 는 세지 않는다).
  // FK 이름은 스키마 안에서 유일해야 해서 FK 를 더하거나 이름이 바뀔 때마다 본다. 참조 색인은 부모를 바꾸는 문장이 모든 테이블을 훑지 않고 참조 컬럼 목록마다 한 번만
  // 보게 한다 — 테이블 수천 개가 참조하는 허브 테이블도 문장마다 드는 시간이 자식 수에 비례하지 않는다 (리뷰 1회차 M-1). 테이블을 바꾸는 replaceTable·appendTable·
  // removeTables 가 고치고, 부모 컬럼 이름을 따라 자식 FK 의 참조 컬럼을 바꾸는 renameRefColumns 는 목록을 키째로 옮긴다. st.model.tables 를 직접 다시 쓰는
  // 그 밖의 곳은 FK 이름·참조 컬럼을 바꾸지 않으며 참조 테이블 이름을 바꾸면 moveRefTable 을 부른다
  readonly fkNames: Map<string, number>;
  readonly refTables: Map<string, Map<string, RefList>>;
  // 루틴 '<종류>:<이름 소문자>' (routineKey). CREATE·DROP FUNCTION·PROCEDURE 가 고친다
  readonly routineKeys: Set<string>;
}

export const routineKey = (r: Pick<Routine, 'kind' | 'name'>): string => `${r.kind}:${routineNameKey(r.name)}`;

export function initialState(base: SchemaModel, schemaName: string, defaults: ApplyDefaults, sqlMode: string): State {
  const model = structuredClone(base);
  const origins: Origins = { tables: new Map(), columns: new Map(), indexes: new Map(), provenance: new Map() };
  for (const t of model.tables) trackNew(origins, t, true);
  const tableAt = new Map<string, number>();
  model.tables.forEach((t, k) => {
    if (!tableAt.has(t.name)) tableAt.set(t.name, k); // 같은 이름이 둘이면 앞의 것 (find 와 같다)
  });
  const st: State = { model, schemaName, defaults, fkChecks: true, fkChecksUnknown: undefined, sqlMode, sqlModeUnknown: undefined, initialSqlMode: sqlMode, serverSqlModeChanged: false, timeZoneUtc: false, timeZoneUnknown: undefined, saved: new Map(), forgotten: new Set(), storedCall: undefined, origins, tableAt, fkNames: new Map(), refTables: new Map(), routineKeys: new Set(model.routines.map(routineKey)) };
  for (const t of model.tables) countForeignKeys(st, t, 1);
  return st;
}

function addCount(counts: Map<string, number>, key: string, delta: number): void {
  const n = (counts.get(key) ?? 0) + delta;
  if (n > 0) counts.set(key, n);
  else counts.delete(key);
}

function countForeignKeys(st: State, t: Table | undefined, delta: 1 | -1): void {
  for (const f of t?.foreignKeys ?? []) {
    addCount(st.fkNames, f.name.toLowerCase(), delta);
    if (f.refSchema === undefined) countReference(st, f, t!.name, delta);
  }
}

// FK 하나를 참조 색인(부모 → 참조 컬럼 목록 → 자식)에 더하거나 뺀다. 빈 항목은 지운다 — 부모 항목이 있으면 그 부모를 참조하는 FK 가 있다
function countReference(st: State, f: ForeignKey, child: string, delta: 1 | -1): void {
  const columns = f.refColumns.map((c) => c.toLowerCase());
  const key = JSON.stringify(columns);
  const lists = st.refTables.get(f.refTable) ?? new Map<string, RefList>();
  const list = lists.get(key) ?? { columns, children: new Map<string, number>() };
  addCount(list.children, child, delta);
  if (list.children.size) lists.set(key, list);
  else lists.delete(key);
  if (lists.size) st.refTables.set(f.refTable, lists);
  else st.refTables.delete(f.refTable);
}

// 참조 컬럼 목록 하나를 부모의 목록 표에 넣는다. 같은 키의 목록이 이미 있으면 자식 수를 합친다 (없으면 목록을 그대로 옮긴다 — 자식이 수천 개여도 새로 만들지 않는다)
function mergeRefList(lists: Map<string, RefList>, list: RefList): void {
  const key = JSON.stringify(list.columns);
  const target = lists.get(key);
  if (!target) lists.set(key, list);
  else for (const [child, n] of list.children) addCount(target.children, child, n);
}

// 모든 FK 의 참조 테이블 이름을 from 에서 to 로 바꾼 뒤 (RENAME TABLE) 참조 색인을 옮긴다 (FK_CHECKS=0 으로 to 를 미리 참조한 FK 와 합친다)
export function moveRefTable(st: State, from: string, to: string): void {
  const lists = st.refTables.get(from);
  if (!lists) return;
  st.refTables.delete(from);
  const target = st.refTables.get(to);
  if (!target) {
    st.refTables.set(to, lists); // 흔한 경우: 표를 그대로 옮긴다 (자식이 수천 개여도 문장마다 새로 만들지 않는다)
    return;
  }
  for (const list of lists.values()) mergeRefList(target, list);
}

// 부모 컬럼의 이름이 바뀌면 (RENAME COLUMN·CHANGE — renamed: 소문자 옛 이름 → 새 이름) 그 컬럼을 참조하는 다른 테이블 FK 의 참조 컬럼도 바뀐다 (MySQL 8.0).
// 참조 색인에서 바뀐 컬럼이 든 참조 컬럼 목록의 자식만 다시 만들고, 목록은 새 컬럼 목록 키로 통째로 옮긴다. FK 이름은 그대로라 FK 이름 색인은 건드리지 않는다.
// 부모의 자식을 모두 다시 만들고 자식마다 참조 색인을 다시 세면, 허브 테이블에서 자식 하나가 참조하는 컬럼 이름만 바꿔도 1,000,000자 스크립트가 30 초였다 (리뷰 2회차 I-2)
export function renameRefColumns(st: State, parent: string, renamed: ReadonlyMap<string, string>): void {
  if (!renamed.size) return;
  const moved = moveRefColumns(st, parent, renamed);
  if (!moved.length) return;
  const rename = (n: string) => renamed.get(n.toLowerCase()) ?? n;
  const changes = (f: ForeignKey) => f.refTable === parent && f.refSchema === undefined && f.refColumns.some((c) => renamed.has(c.toLowerCase()));
  const tables = st.model.tables.slice();
  // 자식 이름: 목록 하나면 그 목록의 자식 그대로 (Set 을 만들지 않는다), 여럿이면 여러 목록에 든 자식도 한 번만 고친다
  for (const name of moved.length === 1 ? moved[0].children.keys() : new Set(moved.flatMap((l) => [...l.children.keys()]))) {
    const at = tableIndex(st, name);
    if (at < 0) continue;
    const child = tables[at];
    tables[at] = { ...child, foreignKeys: child.foreignKeys.map((f) => (changes(f) ? { ...f, refColumns: f.refColumns.map(rename) } : f)) };
  }
  st.model.tables = tables;
}

// 바뀐 컬럼이 든 부모의 참조 컬럼 목록을 새 컬럼 목록 키로 옮기고, 옮긴 목록(새 컬럼·옮긴 자식)을 돌려준다. 부모 자신(자기 참조 FK)은 replaceTable 이 새 정의로
// 이미 셌으므로 그 자리에 남긴다. 맞바꾸기(a → b, b → a)도 되도록 옮길 목록을 모두 떼어 낸 뒤 넣고, 같은 키의 목록이 이미 있으면 합친다
function moveRefColumns(st: State, parent: string, renamed: ReadonlyMap<string, string>): RefList[] {
  const lists = st.refTables.get(parent);
  if (!lists) return [];
  const moving: RefList[] = [];
  for (const [key, list] of [...lists]) {
    const own = list.children.get(parent);
    if (!list.columns.some((c) => renamed.has(c)) || (own !== undefined && list.children.size === 1)) continue;
    lists.delete(key);
    if (own !== undefined) {
      list.children.delete(parent);
      lists.set(key, { columns: list.columns, children: new Map([[parent, own]]) });
    }
    moving.push({ columns: list.columns.map((c) => (renamed.get(c) ?? c).toLowerCase()), children: list.children });
  }
  for (const list of moving) mergeRefList(lists, list);
  return moving;
}

// 부모 테이블을 참조하는 FK 의 참조 컬럼 목록들 (자기 참조 포함)
export const refLists = (st: State, parent: string): RefList[] => [...(st.refTables.get(parent)?.values() ?? [])];

// 부모 테이블을 참조하는 FK 가 있는 테이블 이름 (자기 참조 포함)
export function childNames(st: State, parent: string): Set<string> {
  const names = new Set<string>();
  for (const list of refLists(st, parent)) for (const child of list.children.keys()) names.add(child);
  return names;
}

// childNames 의 테이블을 st.model.tables 순서로 (모든 테이블을 차례로 훑던 검사와 같은 테이블을 먼저 만난다)
export function childTables(st: State, parent: string): Table[] {
  const at = [...childNames(st, parent)].map((n) => tableIndex(st, n)).filter((k) => k >= 0);
  return at.sort((a, b) => a - b).map((k) => st.model.tables[k]);
}

// 참조 컬럼 목록에 parent 말고 다른 테이블의 FK 가 있는가 (자기 참조는 그 테이블의 FK 로 따로 본다)
export function hasOtherChild(list: RefList, parent: string): boolean {
  for (const child of list.children.keys()) if (child !== parent) return true;
  return false;
}

// parent 의 컬럼(이름 대소문자 무시)을 참조하는 FK 가 있는가 (자기 참조 포함)
export const isReferencedColumn = (st: State, parent: string, column: string): boolean =>
  refLists(st, parent).some((list) => list.columns.includes(column.toLowerCase()));

// 테이블의 이름 추적을 시작한다 (fromBase: 기준 버전에 있던 테이블이면 지금 이름이 곧 기준 이름). 출처 표는 건드리지 않는다 — CREATE TABLE 은 addKeys 가 이미 적었다
export function trackNew(origins: Origins, t: Table, fromBase: boolean): void {
  const origin = (name: string) => (fromBase ? name : undefined);
  origins.tables.set(t.name, origin(t.name));
  origins.columns.set(t.name, new Map(t.columns.map((c) => [c.name, origin(c.name)])));
  origins.indexes.set(t.name, new Map(t.indexes.map((i) => [i.name, origin(i.name)])));
}

export function moveOrigins(origins: Origins, from: string, to: string): void {
  if (from === to) return; // 옮긴 뒤 from 을 지우므로 같은 이름이면 항목이 사라진다
  for (const m of [origins.tables, origins.columns, origins.indexes, origins.provenance] as Map<string, unknown>[]) {
    if (!m.has(from)) continue;
    m.set(to, m.get(from));
    m.delete(from);
  }
}

export function forgetOrigins(origins: Origins, name: string): void {
  origins.tables.delete(name);
  origins.columns.delete(name);
  origins.indexes.delete(name);
  origins.provenance.delete(name);
}

// 컬럼·인덱스·제약 이름은 대소문자를 구분하지 않는다
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();


export const findColumn = (t: Pick<Table, 'columns'>, name: string): Column | undefined => t.columns.find((c) => sameName(c.name, name));

// 컬럼 이름(소문자) → 컬럼. 같은 이름이 둘이면 앞의 것 (findColumn 과 같다). 키 파트마다 컬럼을 찾는 곳은 이 표를 쓴다 — 컬럼 1017개·키 파트 1008개인 테이블에서
// 키 파트마다 컬럼 목록을 훑으면 문장 하나에 이름 비교가 100만 번 든다 (리뷰 4회차 M-2). 컬럼 배열은 고쳐 쓰지 않고 늘 새로 만들므로 같은 배열이면 만든 표를 다시 쓴다:
// 컬럼을 바꾸지 않는 문장(COMMENT·키)이 이어지면 문장마다 컬럼을 모두 다시 훑지 않는다
const byNameCache = new WeakMap<readonly Column[], ReadonlyMap<string, Column>>();

export function columnsByName(t: Pick<Table, 'columns'>): ReadonlyMap<string, Column> {
  const cached = byNameCache.get(t.columns);
  if (cached) return cached;
  const byName = new Map<string, Column>();
  for (const c of t.columns) {
    const key = c.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, c);
  }
  byNameCache.set(t.columns, byName);
  return byName;
}
// 테이블 이름은 대소문자를 구분한다 (Linux 기본 lower_case_table_names=0). 자리(st.model.tables 안), 없으면 -1.
// 표의 자리가 어긋났으면 (앞의 테이블을 지웠다) 다시 찾아 고친다
export function tableIndex(st: State, name: string): number {
  const at = st.tableAt.get(name);
  if (at === undefined) return -1;
  if (st.model.tables[at]?.name === name) return at;
  const found = st.model.tables.findIndex((t) => t.name === name);
  if (found < 0) st.tableAt.delete(name);
  else st.tableAt.set(name, found);
  return found;
}

export const findTable = (st: State, name: string): Table | undefined => st.model.tables[tableIndex(st, name)];

// 테이블·뷰는 이름 공간을 함께 쓴다
export const nameTaken = (st: State, name: string): boolean => st.tableAt.has(name) || st.model.views.some((v) => v.name === name);

export function needTable(st: State, name: string): Table {
  const t = findTable(st, name) ?? fail(`테이블 \`${name}\` 이 없습니다 (MySQL 1146)`);
  if (t.parseError) fail(`테이블 \`${name}\` 은 파싱하지 못한 정의라 바꿀 수 없습니다 — ${RE_EXPORT}`);
  return t;
}

// name 자리의 테이블을 next 로 바꾼 새 배열 (배열 복사는 테이블마다 새 객체를 만드는 map 보다 훨씬 싸다). 이름이 바뀌면 표도 고친다 (RENAME)
export function replaceTable(st: State, name: string, next: Table): void {
  const at = tableIndex(st, name);
  if (at < 0) return;
  const tables = st.model.tables.slice();
  // 새 정의를 먼저 센다: 그대로인 FK 는 개수가 0 이 되지 않아 큰 표에서 항목을 지웠다 다시 넣지 않는다 (Map 의 삭제·추가 반복은 항목이 수천 개면 느리다)
  countForeignKeys(st, next, 1);
  countForeignKeys(st, tables[at], -1);
  tables[at] = next;
  st.model.tables = tables;
  if (next.name === name) return;
  st.tableAt.delete(name);
  st.tableAt.set(next.name, at);
}

// 새 테이블을 맨 뒤에 둔다 (CREATE TABLE)
export function appendTable(st: State, t: Table): void {
  st.tableAt.set(t.name, st.model.tables.length);
  st.model.tables = [...st.model.tables, t];
  countForeignKeys(st, t, 1);
}

// 테이블을 지운다 (DROP TABLE). 뒤의 테이블 자리는 tableIndex 가 찾을 때 고친다
export function removeTables(st: State, names: ReadonlySet<string>): void {
  for (const t of st.model.tables) if (names.has(t.name)) countForeignKeys(st, t, -1);
  st.model.tables = st.model.tables.filter((t) => !names.has(t.name));
  for (const n of names) st.tableAt.delete(n);
}

// 스키마 한정 이름: `cur`.`t` 는 현재 스키마일 때만 받는다
export function objectName(c: Cursor, st: State): string {
  const first = c.ident();
  if (!c.acceptOp('.')) return first;
  if (first !== st.schemaName) fail(`다른 스키마 \`${first}\` 의 객체는 바꿀 수 없습니다 — 이 버전은 스키마 \`${st.schemaName}\` 하나를 나타냅니다`);
  return c.ident();
}

// 'a [, b …] [RESTRICT|CASCADE]' 이름 목록 (DROP TABLE·DROP VIEW). c 는 목록 앞. RESTRICT·CASCADE 는 마지막 이름 뒤에만 쓸 수 있다
export function objectNameList(c: Cursor, st: State): string[] {
  const items = splitList(c.toks.slice(c.i), '이름');
  return items.map((toks, k) => {
    const one = new Cursor(toks, c.src);
    const name = objectName(one, st);
    const isLast = k === items.length - 1;
    if (isLast && !one.acceptWord('RESTRICT')) one.acceptWord('CASCADE');
    if (!one.done) fail(`알 수 없는 내용입니다: ${one.peek()!.v} (MySQL 1064)`);
    return name;
  });
}
