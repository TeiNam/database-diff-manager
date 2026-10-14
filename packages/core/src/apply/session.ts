// SET 문: FOREIGN_KEY_CHECKS·SQL_MODE 를 추적하고, time_zone 은 UTC 로 정했는지만 기억한다 (assertUtcTimestampDefault). 이후 테이블 정의 결과나 허용 여부를 바꾸는 세션 변수
// (default_storage_engine 등)는 조용히 넘기면 MySQL 과 다른 모델이 나오므로 거부하고, 나머지(NAMES, unique_checks 등)는 스키마에 영향이 없어 값을 버린다 — 값을 모르는
// 변수에서 되돌려도 받는다 (리뷰 9회차). 값을 쓰는 대상(사용자 변수, 세션 SQL_MODE·TIME_ZONE·FOREIGN_KEY_CHECKS)도 값을 모르는 변수에서 정하면 그 SET 에서 거부하지 않고
// 모르는 값으로 둔다 — 그 값에 기대는 뒤 문장만 거부한다 (리뷰 10회차, unknown-session.ts). 트랜잭션 특성·역할·자원 그룹의 SET(SET TRANSACTION·SET ROLE·SET DEFAULT ROLE·
// SET RESOURCE GROUP)도 무시한다.
// 서버 변수(SET GLOBAL·PERSIST·PERSIST_ONLY, @@global.x)는 이 스크립트의 세션을 바꾸지 않아 무시한다 (서버 sql_mode 를 바꾼 사실만 기억해 뒤의 SET sql_mode = DEFAULT 가 정한 세션 값을 모르는 값으로 두고,
// 값 안의 저장 함수 호출은 함수가 바꿨을 수 있는 사용자 변수 등을 모르는 값으로 둔다 — stored-call.ts).
// td-export·마이그레이션 스크립트의 'SET @OLD_X = @@X, X = 0' 저장과 'SET X = @OLD_X' 복원을 따른다
import { Cursor } from '../cursor';
import type { Token } from '../lexer';
import { splitList } from './lists';
import { baseType } from './normalize-mysql';
import { isUnknown, type SessionValue, type State } from './state';
import { forgetStateChangedBy, storedFunctionCall } from './stored-call';
import { DEFAULT_SQL_MODE, fail, RE_EXPORT, type DefaultSpec } from './types';

// 값에 따라 이후 CREATE TABLE 의 결과나 허용 여부가 달라지는 세션 변수 (소문자). 8.0 에 없는 이름(storage_engine, restrict_fk_on_non_standard_key)도 막는다
const SCHEMA_VARIABLES: ReadonlySet<string> = new Set([
  'default_storage_engine', 'storage_engine', 'explicit_defaults_for_timestamp', 'sql_require_primary_key', 'sql_generate_invisible_primary_key',
  'restrict_fk_on_non_standard_key', 'default_collation_for_utf8mb4', 'character_set_database', 'collation_database', 'innodb_strict_mode',
]);

// 값을 모델에 쓰는 세션 변수 (소문자, assignSession 이 따라가는 것): FOREIGN_KEY_CHECKS·SQL_MODE 는 값을, time_zone 은 UTC 로 정했는지를 쓴다. 사용자 변수도 뒤 SET 이 읽으므로
// 값을 쓴다 — 값을 모르는 변수에서 정하면 모르는 값을 기억한다 (setUnknown). 그 밖의 세션 변수(unique_checks·sql_notes·character_set_client·collation_connection …)는 값을
// 버리므로, 값을 모르는 변수(저장하지 않았거나 저장 함수 호출 뒤 잊은 사용자 변수, @@global·@@persist 서버 변수)에서 되돌려도 받는다 — mysqldump·Workbench 꼬리의
// 'SET UNIQUE_CHECKS = @OLD_UNIQUE_CHECKS' (리뷰 9회차 Claude 참고 1)
const TRACKED_VARIABLES: ReadonlySet<string> = new Set(['foreign_key_checks', 'sql_mode', 'time_zone']);
const usesValue = (target: string): boolean => target.startsWith('@') || TRACKED_VARIABLES.has(target);

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

// MySQL 은 대입의 값을 모두 먼저 계산하고(이때 저장 함수가 돈다) 차례로 대입한다. DEFAULT 는 대입할 때 전역 값을 읽으므로, 뒤 대입이 부르는 저장 함수가 바꾼 전역 sql_mode 를
// 읽는다 (8.0.46·8.4.11 실측) — 그래서 문장 안의 저장 함수 호출을 대입보다 먼저 기억한다. 사용자 변수는 값을 계산할 때 읽으므로 대입마다 차례로 본다.
// 저장 함수 호출은 문장을 읽을 때의 세션 SQL_MODE(IGNORE_SPACE)로 대입보다 먼저 가린다 — 앞 대입이 바꾼 sql_mode 로 뒤 대입을 읽지 않는다 (리뷰 10회차 R10-1)
export function applySet(st: State, c: Cursor): void {
  c.expectWord('SET');
  if (isNonSchemaSet(c)) return;
  const items = splitList(c.toks.slice(c.i), 'SET');
  const calls = items.map((toks) => storedFunctionCall(st, toks, c.src));
  st.storedCall = calls.find((call) => call !== undefined) ?? st.storedCall;
  let scope: Scope = 'session';
  items.forEach((toks, k) => {
    scope = assign(st, new Cursor(toks, c.src), scope, calls[k]);
  });
}

// 스키마와 이 도구가 따라가는 세션 값에 상관없어 통째로 무시하는 SET (리뷰 9회차 Claude 참고 2·10회차 참고 3·4): 트랜잭션 특성(SET [GLOBAL|SESSION|LOCAL|PERSIST|PERSIST_ONLY]
// TRANSACTION ISOLATION LEVEL …·READ ONLY — PERSIST 꼴도 MySQL 이 받는다, 8.0.46·8.4.11 실측), 활성 역할(SET ROLE …), 계정의 기본 역할(SET DEFAULT ROLE … TO …), 스레드의 자원
// 그룹(SET RESOURCE GROUP rg [FOR id …]). MySQL 문법에 식이 들어갈 자리가 없어 저장 함수도 부르지 않는다. 키워드 뒤에 아무것도 없으면 MySQL 처럼 1064 다. c 는 SET 바로 뒤다
const SCOPE_WORDS: readonly string[] = ['GLOBAL', 'SESSION', 'LOCAL', 'PERSIST', 'PERSIST_ONLY'];
const NON_SCHEMA_SETS: readonly (readonly string[])[] = [['TRANSACTION'], ...SCOPE_WORDS.map((w) => [w, 'TRANSACTION']), ['ROLE'], ['DEFAULT', 'ROLE'], ['RESOURCE', 'GROUP']];

function isNonSchemaSet(c: Cursor): boolean {
  const words = NON_SCHEMA_SETS.find((w) => c.isWord(...w));
  if (words === undefined) return false;
  if (c.peek(words.length) === undefined) fail(`SET ${words.join(' ')} 뒤에 정할 내용이 없습니다 (MySQL 1064)`);
  return true;
}

// 대입 하나. call: 이 대입의 값이 부르는 저장 함수 (applySet 이 문장을 읽을 때 가렸다). 돌려주는 값은 다음 대입이 물려받는 범위다: 앞에 쓴 GLOBAL·PERSIST·PERSIST_ONLY·
// SESSION·LOCAL 은 수식어 없는 뒤 대입에도 이어진다 (MySQL: 가장 최근 수식어를 따른다). '@@global.x' 처럼 이름에 붙인 범위는 그 대입에만 쓴다
function assign(st: State, a: Cursor, inherited: Scope, call: string | undefined): Scope {
  if (a.isWord('NAMES') || a.isWord('CHARACTER') || a.isWord('CHARSET')) return inherited;
  const scope = scopeWord(a) ?? inherited;
  const variable = target(a);
  if (!variable.name.startsWith('@') && (variable.scope ?? scope) === 'server') {
    // 서버 변수: 값이 식이어도, 스키마에 영향을 주는 변수여도 이 세션과 상관없다. 다만 서버 sql_mode 를 바꾼 사실은 기억한다 (sqlModeDefault).
    // PERSIST_ONLY 는 실행 중인 값을 바꾸지 않지만 범위를 가르지 않고 함께 본다 (드물어 보수적으로 거부).
    // 값을 읽지 않고 버려도 그 안의 저장 함수 호출은 실행되어 사용자 변수 등을 바꿀 수 있으므로 다른 무시하는 문장과 같이 그 값을 모르는 값으로 둔다 (리뷰 8회차)
    if (variable.name === 'sql_mode') st.serverSqlModeChanged = true;
    forgetStateChangedBy(st, call);
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
  if (!a.acceptOp('=') && !(a.acceptOp(':') && a.acceptOp('='))) fail(notAssignment(a));
  const written = a.peek(); // 쓴 값의 첫 토큰 (time_zone 은 리터럴만 UTC 로 본다)
  const value = valueOf(st, a);
  if (!a.done) fail(`SET 값은 리터럴·@변수·@@변수만 받습니다: ${a.src.slice(a.peek()!.s).trim()}`);
  if (!usesValue(target)) return; // 값을 버리는 변수 — 모르는 값이어도 받는다
  const assignment = `SET ${a.src.slice(a.toks[0].s, a.toks[a.toks.length - 1].e)}`; // 안내에 쓰는 이 대입 ('SET SQL_MODE=@OLD_SQL_MODE')
  if (target.startsWith('@')) {
    st.saved.set(target, isUnknown(value) ? { unknown: `사용자 변수 ${target} 에 앞의 \`${assignment}\` 문장이 알 수 없는 값을 넣었습니다 — ${value.unknown}` } : value);
    return;
  }
  const tracked = target === 'sql_mode' && value === 'DEFAULT' ? sqlModeDefault(st) : value;
  if (isUnknown(tracked)) setUnknown(st, target, assignment, tracked.unknown);
  else setKnown(st, target, tracked, written);
}

// 아는 값으로 정한 세션 값 (모르던 값이면 다시 안다)
function setKnown(st: State, target: string, value: string, written: Token | undefined): void {
  if (target === 'foreign_key_checks') {
    st.fkChecks = foreignKeyChecksOf(value);
    st.fkChecksUnknown = undefined;
  } else if (target === 'sql_mode') {
    st.sqlMode = resolveSqlMode(value);
    st.sqlModeUnknown = undefined;
  } else {
    st.timeZoneUtc = isUtcZone(written);
    st.timeZoneUnknown = undefined;
  }
}

// 값을 모르는 변수에서 정한 세션 값 (리뷰 10회차): 거부하지 않고 모르는 값으로 둔다 — 그 값에 기대는 뒤 문장을 unknown-session.ts·assertUtcTimestampDefault 가 거부하며
// 이 대입(assignment)과 값을 모르는 까닭(why)을 밝힌다
function setUnknown(st: State, target: string, assignment: string, why: string): void {
  if (target === 'time_zone') {
    st.timeZoneUtc = false;
    st.timeZoneUnknown = `앞의 \`${assignment}\` 문장이 세션 시간대를 알 수 없는 값으로 정해(${why})`;
    return;
  }
  const reason = `앞의 \`${assignment}\` 문장이 세션 ${target.toUpperCase()} 를 알 수 없는 값으로 정했습니다 — ${why}`;
  if (target === 'sql_mode') st.sqlModeUnknown = reason;
  else st.fkChecksUnknown = reason;
}

// UTC 를 쓴 리터럴인가. 변수에서 되돌리는 대입(SET time_zone = @OLD_TIME_ZONE)·@@time_zone·DEFAULT 는 서버 시간대일 수 있어 UTC 로 보지 않는다
const isUtcZone = (t: Token | undefined): boolean =>
  (t?.t === 'string' || t?.t === 'word') && (UTC_OFFSET.test(t.v) || UTC_NAMES.has(t.v.toUpperCase()));

// TIMESTAMP 컬럼의 리터럴 기본값 (리뷰 3회차 M-1·4회차 M-1, 8.0.46·8.4.11 실측): MySQL 은 그 값을 쓰는 세션의 시간대에서 UTC 로 바꿔 저장하고, SHOW CREATE 는 읽는 세션의
// 시간대로 다시 바꿔 찍는다 ('+09:00' 세션의 '2020-01-01 09:00:00' 을 UTC 세션에서 읽으면 '2020-01-01 00:00:00'). td-export 는 UTC 세션(sqlx 기본값 time_zone='+00:00')에서
// SHOW CREATE 를 읽으므로 기준 버전의 값은 UTC 글자다. 스크립트가 앞에서 세션 time_zone 을 UTC 로 정했으면 (mysqldump·phpMyAdmin 머리의 SET TIME_ZONE='+00:00') 쓴 글자가
// 곧 UTC 라 그대로 받는다. 그 밖에는 서버 시간대(KST 서버의 SYSTEM 등)나 다른 시간대에서 바뀌어 저장된 값을 알 수 없으므로 받지 않는다. 스크립트는 이미 그 시간대로
// 실행됐으므로 스크립트를 고치라고 안내하지 않는다. CURRENT_TIMESTAMP·NULL 과 DATETIME 은 시간대를 타지 않는다
// UTC 로 정한 뒤 무시한 문장이 저장 함수를 불렀으면 함수가 세션 time_zone 을 바꿨을 수 있다 (MySQL 은 함수 안의 SET time_zone 을 되돌리지 않는다, 8.0.46·8.4.11 실측 — 리뷰 8회차).
// 값을 모르는 변수에서 되돌린 time_zone(저장 함수 호출 뒤의 SET TIME_ZONE = @OLD_TIME_ZONE)도 그 SET 은 받고 여기서 거부한다 (리뷰 10회차 — 안내는 st.timeZoneUnknown)
export function assertUtcTimestampDefault(st: Pick<State, 'timeZoneUtc' | 'timeZoneUnknown'>, column: string, type: string, value: DefaultSpec | undefined): void {
  if (st.timeZoneUtc || value === undefined || value.kind === 'null' || value.kind === 'now' || baseType(type) !== 'timestamp') return;
  const unknown = st.timeZoneUnknown ?? '스크립트를 실행한 서버의 시간대를 알 수 없어';
  fail(`TIMESTAMP 컬럼 \`${column}\` 의 리터럴 기본값은 MySQL 이 세션 시간대에서 UTC 로 바꿔 저장하는데, ${unknown} 저장된 값을 정할 수 없습니다 — ${RE_EXPORT}`);
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

// 쓴 값: 리터럴·@변수·@@변수 (식은 assignSession 이 거부한다 — 값 안의 저장 함수 호출이 숨지 않게 값을 버리는 변수도 같다). 값을 알 수 없는 읽기(저장하지 않았거나 저장 함수
// 호출 뒤 잊은 사용자 변수, @@global·@@persist 서버 변수, 모르는 세션 값의 @@sql_mode·@@foreign_key_checks)는 왜 모르는지 밝힌 Unknown 이다 — 거부는 그 값에 기대는 뒤 문장이 한다
function valueOf(st: State, a: Cursor): SessionValue {
  if (a.acceptOp('@')) return a.acceptOp('@') ? systemValue(st, a) : userValue(st, a);
  const t = a.next();
  if (t.t === 'string' || t.t === 'number') return t.v;
  if (t.t === 'word') return t.v.toUpperCase();
  return fail(`SET 값을 읽을 수 없습니다: ${t.v}`);
}

function systemValue(st: State, a: Cursor): SessionValue {
  const source = systemName(a);
  if (source.scope !== 'server') return current(st, source.name);
  return { unknown: `서버 변수 값(@@global·@@persist 의 ${source.name})은 알 수 없습니다` };
}

function userValue(st: State, a: Cursor): SessionValue {
  const name = `@${a.ident().toLowerCase()}`;
  return st.saved.get(name) ?? { unknown: unknownVariable(st, name) };
}

// 값을 모르는 사용자 변수. 무시한 문장이 저장 함수를 부른 뒤로 다시 정하지 않은 변수는 그 함수가 바꿨을 수 있다 (리뷰 7회차 R7-2·8회차). 호출 전에 저장한 변수
// (mysqldump 머리의 @OLD_SQL_MODE)도 함수가 바꿀 수 있어 저장한 값을 믿지 않는다 — 안내에 그렇게 밝힌다 (리뷰 9회차)
function unknownVariable(st: State, name: string): string {
  if (st.storedCall === undefined) return `값을 저장하지 않은 변수입니다: ${name}`;
  const call = `무시한 문장의 저장 함수 호출(\`${st.storedCall}\`)`;
  const reason = st.forgotten.has(name)
    ? `${call}이 이 변수를 바꿨을 수 있습니다. 호출 전에 저장한 값이지만 저장 함수는 어느 사용자 변수든 바꿀 수 있어 그 값을 그대로 쓰지 않는데`
    : `${call}이 이 변수를 바꿨을 수 있는데`;
  return `사용자 변수 ${name} 의 값을 알 수 없습니다 — ${reason}, 이 도구는 문장을 실행하지 않아 바뀐 값을 모릅니다`;
}

// '변수 = 값' 꼴이 아닌 대입 (SET autocommit 1): 무엇을 바꾸는지 가르지 않고 받지 않는다 (리뷰 9회차 Claude 참고 2 — "':' 필요" 대신)
function notAssignment(a: Cursor): string {
  const end = a.peek() ?? a.toks[a.toks.length - 1];
  return `'변수 = 값' 꼴이 아닌 SET 은 받지 않습니다: SET ${a.src.slice(a.toks[0].s, end.e)} … — ${RE_EXPORT}`;
}

// @@x 로 읽은 세션 값 (모르는 세션 값이면 그 까닭을 그대로 넘긴다). time_zone 등 그 밖의 값은 쓰지 않는다 — 되돌린 time_zone 은 UTC 로 보지 않는다
function current(st: State, name: string): SessionValue {
  if (name === 'foreign_key_checks') return st.fkChecksUnknown !== undefined ? { unknown: st.fkChecksUnknown } : st.fkChecks ? '1' : '0';
  if (name === 'sql_mode') return st.sqlModeUnknown !== undefined ? { unknown: st.sqlModeUnknown } : st.sqlMode;
  return '';
}

// MySQL 8.0.46 실측: 단어 ON·OFF·TRUE·FALSE(대소문자 무관)와 숫자 0·1 을 받고, 따옴표를 친 'TRUE'·'FALSE'·'0'·'1' 은 1231 로 거부한다 (받아도 해가 없어 함께 받는다).
// DEFAULT 는 8.0.46 이 0(꺼짐)으로 만드는데 켜진 기본값을 기대하기 쉽고 버전마다 달라질 수 있어 받지 않는다
function foreignKeyChecksOf(value: string): boolean {
  const word = value.toUpperCase();
  if (FK_CHECKS_OFF.has(word)) return false;
  if (FK_CHECKS_ON.has(word)) return true;
  if (word === 'DEFAULT') return fail('FOREIGN_KEY_CHECKS = DEFAULT 는 받을 수 없습니다 — 0 이나 1 로 써 주세요');
  return fail(`FOREIGN_KEY_CHECKS 에 쓸 수 없는 값입니다: ${value} (MySQL 1231)`);
}

// SET sql_mode = DEFAULT: MySQL 은 세션 값을 전역 값, 곧 스크립트를 실행한 서버의 sql_mode 로 되돌린다 — 이 도구에서는 처음 세션 SQL_MODE 다
// (서버가 기준 버전 루틴에서 짐작한 값. 주지 않았으면 MySQL 기본 모드 — 리뷰 6회차 M-2). 컴파일 기본값(DEFAULT_SQL_MODE)으로 두면 SET 없이 만든 루틴과 어긋난다.
// 다만 스크립트가 앞에서 GLOBAL·PERSIST 로 서버 sql_mode 를 바꿨으면 DEFAULT 가 읽는 전역 값은 바뀐 값이라 처음 세션 SQL_MODE 와 다르다 (리뷰 7회차 R7-1). 무시한 문장이 부른
// 저장 함수도 전역 sql_mode 를 바꿀 수 있다 (함수 안의 SET GLOBAL — 8.0.46·8.4.11 실측, 리뷰 8회차). 그 전역 값은 알 수 없어 모르는 값이다 (리뷰 10회차 — 기대는 뒤 문장만 거부한다)
function sqlModeDefault(st: State): SessionValue {
  const changed = st.serverSqlModeChanged
    ? '이 스크립트가 그 앞에서 전역(GLOBAL·PERSIST) sql_mode 를 바꿔'
    : st.storedCall !== undefined ? `무시한 문장의 저장 함수 호출(\`${st.storedCall}\`)이 전역 sql_mode 를 바꿨을 수 있어` : undefined;
  return changed === undefined ? st.initialSqlMode : { unknown: `DEFAULT 는 세션 값을 전역 sql_mode 로 되돌리는데, ${changed} 그 값을 알 수 없습니다` };
}

// 쓴 모드를 MySQL 순서로 줄 세워 대문자로 돌려준다 (루틴이 기억하는 sql_mode 가 SHOW CREATE 와 같아야 한다). 같은 이름은 한 번만 쓰고,
// 빈 항목('A,' · ',A')은 MySQL 처럼 건너뛴다. ANSI·TRADITIONAL 같은 묶음 이름과 REAL_AS_FLOAT·ANSI_QUOTES 는 받지 않는다 (ApplyFailure).
// SET SQL_MODE 의 값과 처음 세션 SQL_MODE(ApplyOptions.sqlMode)가 함께 쓴다 — 서버도 기준 버전 루틴의 SQL_MODE 를 이것으로 가린다.
// 여기서 DEFAULT 는 MySQL 기본 모드다 (SET 문의 DEFAULT 는 sqlModeDefault 가 처음 세션 SQL_MODE 로 푼다)
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
