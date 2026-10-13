// SET 문: FOREIGN_KEY_CHECKS·SQL_MODE 만 추적한다. 이후 테이블 정의 결과나 허용 여부를 바꾸는 세션 변수(default_storage_engine 등)는
// 조용히 넘기면 MySQL 과 다른 모델이 나오므로 거부하고, 나머지(NAMES, time_zone, unique_checks 등)는 스키마에 영향이 없어 무시한다.
// td-export·마이그레이션 스크립트의 'SET @OLD_X = @@X, X = 0' 저장과 'SET X = @OLD_X' 복원을 따른다
import { Cursor } from '../cursor';
import { splitList } from './lists';
import type { State } from './state';
import { DEFAULT_SQL_MODE, fail, RE_EXPORT } from './types';

// 값에 따라 이후 CREATE TABLE 의 결과나 허용 여부가 달라지는 세션 변수 (소문자). 8.0 에 없는 이름(storage_engine, restrict_fk_on_non_standard_key)도 막는다
const SCHEMA_VARIABLES: ReadonlySet<string> = new Set([
  'default_storage_engine', 'storage_engine', 'explicit_defaults_for_timestamp', 'sql_require_primary_key', 'sql_generate_invisible_primary_key',
  'restrict_fk_on_non_standard_key', 'default_collation_for_utf8mb4', 'character_set_database', 'collation_database', 'innodb_strict_mode',
]);

// MySQL 8.0/8.4 의 SQL_MODE 이름. SHOW CREATE·@@sql_mode 가 내는 순서(MySQL 내부 순서, 8.0.46 실측)대로 둔다 — sqlModeOf 가 이 순서로 줄 세운다.
// 8.0 에서 없어진 NO_AUTO_CREATE_USER·MAXDB·ORACLE 같은 이름은 1231
const SQL_MODES: readonly string[] = [
  'REAL_AS_FLOAT', 'PIPES_AS_CONCAT', 'ANSI_QUOTES', 'IGNORE_SPACE', 'NOT_USED', 'ONLY_FULL_GROUP_BY', 'NO_UNSIGNED_SUBTRACTION', 'NO_DIR_IN_CREATE', 'ANSI',
  'NO_AUTO_VALUE_ON_ZERO', 'NO_BACKSLASH_ESCAPES', 'STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES', 'NO_ZERO_IN_DATE', 'NO_ZERO_DATE', 'ALLOW_INVALID_DATES',
  'ERROR_FOR_DIVISION_BY_ZERO', 'TRADITIONAL', 'HIGH_NOT_PRECEDENCE', 'NO_ENGINE_SUBSTITUTION', 'PAD_CHAR_TO_FULL_LENGTH', 'TIME_TRUNCATE_FRACTIONAL',
];
const KNOWN_SQL_MODES: ReadonlySet<string> = new Set(SQL_MODES);
// 다른 모드 여럿을 묶은 이름. MySQL 은 풀어 쓴 모드에 자기 이름까지 남겨 내는데, 그 규칙은 재현하지 않고 거부한다
const COMBINATION_SQL_MODES: ReadonlySet<string> = new Set(['ANSI', 'TRADITIONAL']);
// 이후 테이블 정의를 다르게 읽게 하는 모드: REAL_AS_FLOAT 는 REAL 을 FLOAT 로, ANSI_QUOTES 는 "…" 를 문자열이 아닌 식별자로 읽는다. 모델에 반영하지 않으므로 거부한다
const DDL_SQL_MODES: ReadonlySet<string> = new Set(['REAL_AS_FLOAT', 'ANSI_QUOTES']);

const FK_CHECKS_OFF: ReadonlySet<string> = new Set(['0', 'OFF', 'FALSE']);
const FK_CHECKS_ON: ReadonlySet<string> = new Set(['1', 'ON', 'TRUE']);

export function applySet(st: State, c: Cursor): void {
  c.expectWord('SET');
  for (const toks of splitList(c.toks.slice(c.i), 'SET')) assign(st, new Cursor(toks, c.src));
}

function assign(st: State, a: Cursor): void {
  if (a.isWord('NAMES') || a.isWord('CHARACTER') || a.isWord('CHARSET')) return;
  if (a.isWord('GLOBAL') || a.isWord('PERSIST') || a.isWord('PERSIST_ONLY')) fail('SET GLOBAL·PERSIST 는 받을 수 없습니다');
  if (!a.acceptWord('SESSION')) a.acceptWord('LOCAL');
  const target = variable(a);
  if (SCHEMA_VARIABLES.has(target)) fail(`이후 테이블 정의 결과를 바꾸는 세션 변수는 받을 수 없습니다: ${target} — ${RE_EXPORT}`);
  if (!a.acceptOp('=')) {
    a.expectOp(':');
    a.expectOp('=');
  }
  const value = valueOf(st, a);
  if (!a.done) fail(`SET 값은 리터럴·@변수·@@변수만 받습니다: ${a.src.slice(a.peek()!.s).trim()}`);
  if (target.startsWith('@')) st.saved.set(target, value);
  else if (target === 'foreign_key_checks') st.fkChecks = foreignKeyChecksOf(value);
  else if (target === 'sql_mode') st.sqlMode = sqlModeOf(value);
}

// '@v' (사용자 변수), '@@[session.]x' 와 'x' (세션 변수, 소문자)
function variable(a: Cursor): string {
  if (!a.acceptOp('@')) return a.ident().toLowerCase();
  return a.acceptOp('@') ? systemName(a) : `@${a.ident().toLowerCase()}`;
}

function systemName(a: Cursor): string {
  const first = a.ident().toLowerCase();
  if (!a.acceptOp('.')) return first;
  if (first === 'global' || first === 'persist' || first === 'persist_only') fail('SET GLOBAL·PERSIST 는 받을 수 없습니다');
  return a.ident().toLowerCase();
}

function valueOf(st: State, a: Cursor): string {
  if (a.acceptOp('@')) {
    if (a.acceptOp('@')) return current(st, systemName(a));
    const name = `@${a.ident().toLowerCase()}`;
    return st.saved.get(name) ?? fail(`값을 저장하지 않은 변수입니다: ${name}`);
  }
  const t = a.next();
  if (t.t === 'string' || t.t === 'number') return t.v;
  if (t.t === 'word') return t.v.toUpperCase();
  return fail(`SET 값을 읽을 수 없습니다: ${t.v}`);
}

const current = (st: State, name: string): string => (name === 'foreign_key_checks' ? (st.fkChecks ? '1' : '0') : name === 'sql_mode' ? st.sqlMode : '');

// MySQL 8.0.46 실측: 단어 ON·OFF·TRUE·FALSE(대소문자 무관)와 숫자 0·1 을 받고, 따옴표를 친 'TRUE'·'FALSE'·'0'·'1' 은 1231 로 거부한다 (받아도 해가 없어 함께 받는다).
// DEFAULT 는 8.0.46 이 0(꺼짐)으로 만드는데 켜진 기본값을 기대하기 쉽고 버전마다 달라질 수 있어 받지 않는다
function foreignKeyChecksOf(value: string): boolean {
  const word = value.toUpperCase();
  if (FK_CHECKS_OFF.has(word)) return false;
  if (FK_CHECKS_ON.has(word)) return true;
  if (word === 'DEFAULT') return fail('FOREIGN_KEY_CHECKS = DEFAULT 는 받을 수 없습니다 — 0 이나 1 로 써 주세요');
  return fail(`FOREIGN_KEY_CHECKS 에 쓸 수 없는 값입니다: ${value} (MySQL 1231)`);
}

// 쓴 모드를 MySQL 순서로 줄 세워 대문자로 돌려준다 (루틴이 기억하는 sql_mode 가 SHOW CREATE 와 같아야 한다). 같은 이름은 한 번만 쓰고,
// 빈 항목('A,' · ',A')은 MySQL 처럼 건너뛴다. ANSI·TRADITIONAL 같은 묶음 이름과 REAL_AS_FLOAT·ANSI_QUOTES 는 받지 않는다
function sqlModeOf(value: string): string {
  if (value === 'DEFAULT') return DEFAULT_SQL_MODE;
  const written = new Set(value.toUpperCase().split(',').filter((mode) => mode !== ''));
  const unknown = [...written].find((mode) => !KNOWN_SQL_MODES.has(mode));
  if (unknown !== undefined) fail(`SQL_MODE 에 쓸 수 없는 값입니다: ${unknown} (MySQL 1231)`);
  const combination = [...written].find((mode) => COMBINATION_SQL_MODES.has(mode));
  if (combination !== undefined) fail(`SQL_MODE ${combination} 는 다른 모드 여럿을 묶은 이름이라 받을 수 없습니다 — ${RE_EXPORT}`);
  const ddl = [...written].find((mode) => DDL_SQL_MODES.has(mode));
  if (ddl !== undefined) fail(`SQL_MODE ${ddl} 는 이후 테이블 정의를 다르게 읽게 해 받을 수 없습니다 — ${RE_EXPORT}`);
  return SQL_MODES.filter((mode) => written.has(mode)).join(',');
}
