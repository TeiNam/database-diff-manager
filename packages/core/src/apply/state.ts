// ALTER 적용 중 상태: 작업용 모델 사본, 세션 값(FOREIGN_KEY_CHECKS·SQL_MODE), 기준 이름 추적
import { Cursor } from '../cursor';
import type { Column, SchemaModel, Table } from '../model';
import { splitList } from './lists';
import { fail, RE_EXPORT, type ApplyDefaults } from './types';

// src 타입 검사(tsconfig.src.json)는 DOM·node 타입 없이 ES2023 lib 만 쓰므로 전역 structuredClone 이 선언되어 있지 않다.
// 실행 환경(Node 17+·브라우저)은 전역으로 제공하므로 선언만 둔다 (모듈 안 선언이라 실행 코드는 생기지 않는다)
declare function structuredClone<T>(value: T): T;

// 이 실행(applyScript)이 아는 인덱스 출처. auto: FK 가 자동으로 만든 인덱스 (FK 를 지워도 MySQL 의 자동 표시는 남는다), user: 직접 더한 인덱스·RENAME INDEX 한 인덱스,
// ambiguous: 자동인지 직접 만든 것인지 덤프만으로 알 수 없는 채로 남은 인덱스. 기준 덤프에서 온 인덱스는 출처를 모른다 (표에 없다 — 덤프의 이름으로 짐작한다)
export type IndexProvenance = 'auto' | 'user' | 'ambiguous';

// 지금 이름 → 기준 버전 이름 (스크립트에서 새로 만든 것은 undefined). 끝에서 rename 매핑을 만든다
export interface Origins {
  tables: Map<string, string | undefined>;
  columns: Map<string, Map<string, string | undefined>>; // 테이블(지금 이름) → (컬럼 지금 이름 → 기준 이름)
  indexes: Map<string, Map<string, string | undefined>>;
  provenance: Map<string, Map<string, IndexProvenance>>; // 테이블(지금 이름) → (인덱스 이름 소문자 → 출처). auto-index.ts 의 markProvenance 가 적는다
}

export interface State {
  model: SchemaModel; // ponytail: 작업용 사본 하나를 고쳐 쓴다 (입력 모델은 그대로, 실패하면 통째로 버린다)
  readonly schemaName: string;
  readonly defaults: ApplyDefaults;
  fkChecks: boolean;
  sqlMode: string;
  readonly saved: Map<string, string>; // SET @v = … 로 저장한 사용자 변수 (소문자, '@' 포함)
  readonly origins: Origins;
}

export function initialState(base: SchemaModel, schemaName: string, defaults: ApplyDefaults, sqlMode: string): State {
  const model = structuredClone(base);
  const origins: Origins = { tables: new Map(), columns: new Map(), indexes: new Map(), provenance: new Map() };
  for (const t of model.tables) trackNew(origins, t, true);
  return { model, schemaName, defaults, fkChecks: true, sqlMode, saved: new Map(), origins };
}

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
// 테이블 이름은 대소문자를 구분한다 (Linux 기본 lower_case_table_names=0)
export const findTable = (st: State, name: string): Table | undefined => st.model.tables.find((t) => t.name === name);
// 테이블·뷰는 이름 공간을 함께 쓴다
export const nameTaken = (st: State, name: string): boolean => st.model.tables.some((t) => t.name === name) || st.model.views.some((v) => v.name === name);

export function needTable(st: State, name: string): Table {
  const t = findTable(st, name) ?? fail(`테이블 \`${name}\` 이 없습니다 (MySQL 1146)`);
  if (t.parseError) fail(`테이블 \`${name}\` 은 파싱하지 못한 정의라 바꿀 수 없습니다 — ${RE_EXPORT}`);
  return t;
}

export function replaceTable(st: State, name: string, next: Table): void {
  st.model.tables = st.model.tables.map((t) => (t.name === name ? next : t));
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
