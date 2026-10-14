// SET 문: FOREIGN_KEY_CHECKS·SQL_MODE 를 추적하고, time_zone 은 UTC 로 정했는지만 기억한다 (assertUtcTimestampDefault). 이후 테이블 정의 결과나 허용 여부를 바꾸는 세션 변수
// (default_storage_engine 등)는 조용히 넘기면 MySQL 과 다른 모델이 나오므로 거부하고, 나머지(NAMES, unique_checks 등)는 스키마에 영향이 없어 무시한다.
// 서버 변수(SET GLOBAL·PERSIST·PERSIST_ONLY, @@global.x)는 이 스크립트의 세션을 바꾸지 않아 무시한다 (서버 sql_mode 를 바꾼 사실만 기억해 뒤의 SET sql_mode = DEFAULT 를 거부하고, 값 안의 저장 함수 호출도 거부한다).
// td-export·마이그레이션 스크립트의 'SET @OLD_X = @@X, X = 0' 저장과 'SET X = @OLD_X' 복원을 따른다
import { Cursor } from '../cursor';
import type { Token } from '../lexer';
import { splitList } from './lists';
import { baseType } from './normalize-mysql';
import { assertNoStoredFunctionCall, type State } from './state';
import { DEFAULT_SQL_MODE, fail, RE_EXPORT, type DefaultSpec } from './types';

// 값에 따라 이후 CREATE TABLE 의 결과나 허용 여부가 달라지는 세션 변수 (소문자). 8.0 에 없는 이름(storage_engine, restrict_fk_on_non_standard_key)도 막는다
const SCHEMA_VARIABLES: ReadonlySet<string> = new Set([
  'default_storage_engine', 'storage_engine', 'explicit_defaults_for_timestamp', 'sql_require_primary_key', 'sql_generate_invisible_primary_key',
  'restrict_fk_on_non_standard_key', 'default_collation_for_utf8mb4', 'character_set_database', 'collation_database', 'innodb_strict_mode',
]);

// MySQL 8.0/8.4 의 SQL_MODE 이름. SHOW CREATE·@@sql_mode 가 내는 순서(MySQL 내부 순서, 8.0.46 실측)대로 둔다 — resolveSqlMode 가 이 순서로 줄 세운다.
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

// 세션 time_zone 이 UTC 인 값 (8.0.46·8.4.11 실측: '+0:00'·'-00:00' 은 '+00:00' 이 되고, 시간대 이름은 대소문자를 가리지 않으며 따옴표 없이도 쓴다)
const UTC_OFFSET = /^[+-]0?0:00$/;
const UTC_NAMES: ReadonlySet<string> = new Set(['UTC', 'GMT']);

const FK_CHECKS_OFF: ReadonlySet<string> = new Set(['0', 'OFF', 'FALSE']);
const FK_CHECKS_ON: ReadonlySet<string> = new Set(['1', 'ON', 'TRUE']);

// 대입의 범위. server: GLOBAL·PERSIST·PERSIST_ONLY — 서버 값을 바꾸고 이 스크립트의 세션 값은 그대로라 무시한다
type Scope = 'session' | 'server';

export function applySet(st: State, c: Cursor): void {
  c.expectWord('SET');
  let scope: Scope = 'session';
  for (const toks of splitList(c.toks.slice(c.i), 'SET')) scope = assign(st, new Cursor(toks, c.src), scope);
}

// 대입 하나. 돌려주는 값은 다음 대입이 물려받는 범위다: 앞에 쓴 GLOBAL·PERSIST·PERSIST_ONLY·SESSION·LOCAL 은 수식어 없는 뒤 대입에도 이어진다
// (MySQL: 가장 최근 수식어를 따른다). '@@global.x' 처럼 이름에 붙인 범위는 그 대입에만 쓴다
function assign(st: State, a: Cursor, inherited: Scope): Scope {
  if (a.isWord('NAMES') || a.isWord('CHARACTER') || a.isWord('CHARSET')) return inherited;
  const scope = scopeWord(a) ?? inherited;
  const variable = target(a);
  if (!variable.name.startsWith('@') && (variable.scope ?? scope) === 'server') {
    // 서버 변수: 값이 식이어도, 스키마에 영향을 주는 변수여도 이 세션과 상관없다. 다만 서버 sql_mode 를 바꾼 사실은 기억한다 (sessionSqlMode).
    // PERSIST_ONLY 는 실행 중인 값을 바꾸지 않지만 범위를 가르지 않고 함께 본다 (드물어 보수적으로 거부).
    // 값을 읽지 않고 버려도 그 안의 저장 함수 호출은 실행되어 사용자 변수를 바꿀 수 있으므로 다른 무시하는 문장과 같이 거부한다 (리뷰 7회차 R7-2)
    if (variable.name === 'sql_mode') st.serverSqlModeChanged = true;
    assertNoStoredFunctionCall(st, a.toks);
    return scope;
  }
  assignSession(st, a, variable.name);
  return scope;
}

function scopeWord(a: Cursor): Scope | undefined {
  if (a.acceptWord('GLOBAL') || a.acceptWord('PERSIST') || a.acceptWord('PERSIST_ONLY')) return 'server';
  return a.acceptWord('SESSION') || a.acceptWord('LOCAL') ? 'session' : undefined;
}

function assignSession(st: State, a: Cursor, target: string): void {
  if (SCHEMA_VARIABLES.has(target)) fail(`이후 테이블 정의 결과를 바꾸는 세션 변수는 받을 수 없습니다: ${target} — ${RE_EXPORT}`);
  if (!a.acceptOp('=')) {
    a.expectOp(':');
    a.expectOp('=');
  }
  const written = a.peek(); // 쓴 값의 첫 토큰 (time_zone 은 리터럴만 UTC 로 본다)
  const value = valueOf(st, a);
  if (!a.done) fail(`SET 값은 리터럴·@변수·@@변수만 받습니다: ${a.src.slice(a.peek()!.s).trim()}`);
  if (target.startsWith('@')) st.saved.set(target, value);
  else if (target === 'foreign_key_checks') st.fkChecks = foreignKeyChecksOf(value);
  else if (target === 'sql_mode') st.sqlMode = sessionSqlMode(st, value);
  else if (target === 'time_zone') st.timeZoneUtc = isUtcZone(written);
}

// UTC 를 쓴 리터럴인가. 변수에서 되돌리는 대입(SET time_zone = @OLD_TIME_ZONE)·@@time_zone·DEFAULT 는 서버 시간대일 수 있어 UTC 로 보지 않는다
const isUtcZone = (t: Token | undefined): boolean =>
  (t?.t === 'string' || t?.t === 'word') && (UTC_OFFSET.test(t.v) || UTC_NAMES.has(t.v.toUpperCase()));

// TIMESTAMP 컬럼의 리터럴 기본값 (리뷰 3회차 M-1·4회차 M-1, 8.0.46·8.4.11 실측): MySQL 은 그 값을 쓰는 세션의 시간대에서 UTC 로 바꿔 저장하고, SHOW CREATE 는 읽는 세션의
// 시간대로 다시 바꿔 찍는다 ('+09:00' 세션의 '2020-01-01 09:00:00' 을 UTC 세션에서 읽으면 '2020-01-01 00:00:00'). td-export 는 UTC 세션(sqlx 기본값 time_zone='+00:00')에서
// SHOW CREATE 를 읽으므로 기준 버전의 값은 UTC 글자다. 스크립트가 앞에서 세션 time_zone 을 UTC 로 정했으면 (mysqldump·phpMyAdmin 머리의 SET TIME_ZONE='+00:00') 쓴 글자가
// 곧 UTC 라 그대로 받는다. 그 밖에는 서버 시간대(KST 서버의 SYSTEM 등)나 다른 시간대에서 바뀌어 저장된 값을 알 수 없으므로 받지 않는다. 스크립트는 이미 그 시간대로
// 실행됐으므로 스크립트를 고치라고 안내하지 않는다. CURRENT_TIMESTAMP·NULL 과 DATETIME 은 시간대를 타지 않는다
export function assertUtcTimestampDefault(st: Pick<State, 'timeZoneUtc'>, column: string, type: string, value: DefaultSpec | undefined): void {
  if (st.timeZoneUtc || value === undefined || value.kind === 'null' || value.kind === 'now' || baseType(type) !== 'timestamp') return;
  fail(`TIMESTAMP 컬럼 \`${column}\` 의 리터럴 기본값은 MySQL 이 세션 시간대에서 UTC 로 바꿔 저장하는데, 스크립트를 실행한 서버의 시간대를 알 수 없어 저장된 값을 정할 수 없습니다 — ${RE_EXPORT}`);
}

interface Variable {
  name: string; // '@v' (사용자 변수) 또는 시스템 변수 이름 (소문자)
  scope?: Scope; // '@@global.x'·'@@session.x' 처럼 이름에 붙인 범위
}

// '@v', '@@[global.|session.]x', 'x'
function target(a: Cursor): Variable {
  if (!a.acceptOp('@')) return { name: a.ident().toLowerCase() };
  return a.acceptOp('@') ? systemName(a) : { name: `@${a.ident().toLowerCase()}` };
}

const NAME_SCOPES: ReadonlyMap<string, Scope> = new Map([['global', 'server'], ['persist', 'server'], ['persist_only', 'server'], ['session', 'session'], ['local', 'session']]);

function systemName(a: Cursor): Variable {
  const first = a.ident().toLowerCase();
  if (!a.acceptOp('.')) return { name: first };
  return { name: a.ident().toLowerCase(), scope: NAME_SCOPES.get(first) };
}

function valueOf(st: State, a: Cursor): string {
  if (a.acceptOp('@')) {
    if (a.acceptOp('@')) {
      const source = systemName(a);
      return source.scope === 'server' ? fail(`서버 변수 값(@@global·@@persist 의 ${source.name})은 알 수 없어 받을 수 없습니다`) : current(st, source.name);
    }
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

// 세션 sql_mode 에 쓴 값. DEFAULT 는 MySQL 이 세션 값을 전역 값, 곧 스크립트를 실행한 서버의 sql_mode 로 되돌린다 — 이 도구에서는 처음 세션 SQL_MODE 다
// (서버가 기준 버전 루틴에서 짐작한 값. 주지 않았으면 MySQL 기본 모드 — 리뷰 6회차 M-2). 컴파일 기본값(DEFAULT_SQL_MODE)으로 두면 SET 없이 만든 루틴과 어긋난다.
// 다만 스크립트가 앞에서 GLOBAL·PERSIST 로 서버 sql_mode 를 바꿨으면 DEFAULT 가 읽는 전역 값은 바뀐 값이라 처음 세션 SQL_MODE 와 다르다 — 그 값을 알 수 없어 받지 않는다 (리뷰 7회차 R7-1)
function sessionSqlMode(st: State, value: string): string {
  if (value !== 'DEFAULT') return resolveSqlMode(value);
  if (st.serverSqlModeChanged) fail(`SET sql_mode = DEFAULT 는 받을 수 없습니다 — 이 스크립트가 앞에서 전역(GLOBAL·PERSIST) sql_mode 를 바꿨습니다. DEFAULT 는 바뀐 전역 값으로 되돌리므로 처음 세션 SQL_MODE 와 달라지는데 그 값을 알 수 없습니다 — ${RE_EXPORT}`);
  return st.initialSqlMode;
}

// 쓴 모드를 MySQL 순서로 줄 세워 대문자로 돌려준다 (루틴이 기억하는 sql_mode 가 SHOW CREATE 와 같아야 한다). 같은 이름은 한 번만 쓰고,
// 빈 항목('A,' · ',A')은 MySQL 처럼 건너뛴다. ANSI·TRADITIONAL 같은 묶음 이름과 REAL_AS_FLOAT·ANSI_QUOTES 는 받지 않는다 (ApplyFailure).
// SET SQL_MODE 의 값과 처음 세션 SQL_MODE(ApplyOptions.sqlMode)가 함께 쓴다 — 서버도 기준 버전 루틴의 SQL_MODE 를 이것으로 가린다.
// 여기서 DEFAULT 는 MySQL 기본 모드다 (SET 문의 DEFAULT 는 sessionSqlMode 가 처음 세션 SQL_MODE 로 푼다)
export function resolveSqlMode(value: string): string {
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
