// 세션 문자셋 (리뷰 11회차 Claude F4, 8.0.46·8.4.11 에서 mysql 클라이언트로 실측). MySQL 은 문장의 바이트를 character_set_client 로 읽어 이름·COMMENT 는 utf8mb3 로, 문자열
// 리터럴은 character_set_connection 으로 바꿔 저장한다. 스크립트는 UTF-8 이므로(화면이 UTF-8 로만 읽는다) 'SET NAMES latin1' 뒤의 DEFAULT '가'·COMMENT '회원 이름'·`가` 는
// 'ê°€'·'íšŒì› ì´ë¦„'·`ê°€` 로 저장되고, connection 만 latin1 이어도 DEFAULT '가' 는 '?' 다 (ENUM('가','나') 는 1291). 두 문자셋이 UTF-8 계열이나 binary(바이트 그대로)가
// 아니면, 또는 모르면, ASCII 밖 글자가 든 DDL·루틴 문장을 거부한다 — 깨진 글자를 재현하지 않는다. 데이터 문장·SET 같은 무시하는 문장은 스키마를 바꾸지 않아 받는다.
// 처음 세션은 utf8mb4 와 그 기본 콜레이션 utf8mb4_0900_ai_ci 로 본다 (mysql 클라이언트 8.0 의 기본 연결 — CLIENT_DEFAULTS). collation_connection·character_set_results 도
// 따라가 @@collation_connection·@@character_set_results 를 읽어 두었다 되돌리는 mysqldump·phpMyAdmin 머리·꼬리, mysqldump --routines 의 루틴 블록이 아는 값을 되돌린다
// (리뷰 12회차 R12-2·Claude F1 — 11회차는 모르는 값으로 읽어 되돌린 뒤의 한글 DDL 을 거부했다). 저장 함수 안의 SET NAMES·character_set_client 는 함수에서 돌아올 때
// MySQL 이 부른 쪽의 값으로 되돌려 따라가지 않는다 (8.0.46·8.4.11 실측)
import type { Cursor } from '../cursor';
import type { Token } from '../lexer';
import { knownPrimaryCollation } from './normalize-mysql';
import { cappedReason, isUnknown, type SessionValue, type State } from './state';
import { fail, RE_EXPORT } from './types';

// 값을 따라가는 세션 문자셋 변수 (소문자). character_set_connection 과 collation_connection 은 서로를 정한다: 문자셋을 정하면 콜레이션은 그 문자셋의 기본 콜레이션이 되고,
// 콜레이션을 정하면 문자셋은 그 콜레이션의 문자셋이 된다 (8.0.46·8.4.11 실측). character_set_results 는 DDL 을 읽는 데 쓰지 않고 읽기만 따라간다
export const CHARSET_VARIABLES: ReadonlySet<string> = new Set(['character_set_client', 'character_set_connection', 'character_set_results', 'collation_connection']);
// 스크립트(UTF-8)의 바이트를 같은 글자로 읽는 문자셋 (utf8 은 utf8mb3 로 읽는다)
const SAFE_CHARSETS: ReadonlySet<string> = new Set(['utf8mb4', 'utf8mb3', 'binary']);
const NON_ASCII = /[^\x00-\x7f]/;
const GLOBAL_DEFAULT = 'DEFAULT 는 서버의 전역 값을 읽는데 그 값을 알 수 없습니다';

// 세션의 연결 문자셋과 콜레이션 (character_set_connection·collation_connection)
interface Connection {
  readonly charset: SessionValue;
  readonly collation: SessionValue;
}

// 문자셋 이름 (소문자, utf8 은 MySQL 8.0 처럼 utf8mb3)
function charsetName(name: string): string {
  const lower = name.toLowerCase();
  return lower === 'utf8' ? 'utf8mb3' : lower;
}

// 콜레이션 이름 (소문자, utf8_ 로 시작하면 MySQL 8.0 처럼 utf8mb3_ — 8.0.46·8.4.11 의 @@collation_connection 은 utf8mb3_general_ci 다)
const collationName = (name: string): string => name.toLowerCase().replace(/^utf8_/, 'utf8mb3_');

// 문자셋을 정한 연결: 콜레이션은 그 문자셋의 기본 콜레이션이다 (SET NAMES x·character_set_connection = x). 이 도구가 기본 콜레이션을 모르는 문자셋이면 콜레이션만 모른다
function connectionOf(charset: SessionValue): Connection {
  if (isUnknown(charset)) return { charset, collation: charset };
  return { charset, collation: knownPrimaryCollation(charset) ?? { unknown: `문자셋 ${charset} 의 기본 콜레이션은 이 도구가 모릅니다` } };
}

// 콜레이션을 정한 연결: 문자셋은 binary 면 binary, 그 밖에는 첫 '_' 앞이다 (MySQL 의 콜레이션 이름은 문자셋 이름으로 시작한다 — utf8mb4_0900_ai_ci, latin1_swedish_ci)
function connectionWith(collation: SessionValue): Connection {
  if (isUnknown(collation)) return { charset: collation, collation };
  return { charset: collation === 'binary' ? 'binary' : charsetName(collation.split('_')[0]), collation };
}

function setConnection(st: State, c: Connection): void {
  st.connectionCharset = c.charset;
  st.connectionCollation = c.collation;
}

// @@character_set_client·@@character_set_connection·@@character_set_results·@@collation_connection 은 따라간 값을 읽는다 (mysqldump 의
// SET @saved_cs_client = @@character_set_client … 되돌림). 아니면 undefined
const READS: ReadonlyMap<string, (st: State) => SessionValue> = new Map([
  ['character_set_client', (st: State) => st.clientCharset], ['character_set_connection', (st: State) => st.connectionCharset],
  ['character_set_results', (st: State) => st.resultsCharset], ['collation_connection', (st: State) => st.connectionCollation],
]);
export const currentCharset = (st: State, name: string): SessionValue | undefined => READS.get(name)?.(st);

// SET NAMES x [COLLATE y] · NAMES DEFAULT 는 client·results·connection 을 함께 x 로, collation_connection 을 y 나 x 의 기본 콜레이션으로 정한다. SET CHARACTER SET x ·
// CHARSET x 는 client·results 를 x 로, connection 을 스키마 기본 문자셋·콜레이션으로 정한다 (MySQL: character_set_database·collation_database — 8.0.46·8.4.11 실측).
// DEFAULT 는 서버의 전역 character_set_client 를 읽어 모르는 값이다. a 는 NAMES·CHARACTER·CHARSET 자리이고, 돌려주는 대입은 applySet 이 2단계에서 반영한다
export function namesWrite(st: State, a: Cursor): () => void {
  const statement = `SET ${a.src.slice(a.toks[0].s, a.toks[a.toks.length - 1].e)}`;
  const names = a.acceptWord('NAMES');
  if (!names && !a.acceptWord('CHARSET')) a.expectWord('CHARACTER', 'SET');
  const t = a.next();
  if (t.t !== 'word' && t.t !== 'ident' && t.t !== 'string') fail(`문자셋 이름이 필요합니다: ${t.v} (MySQL 1064)`);
  const charset: SessionValue = t.t === 'word' && t.v.toUpperCase() === 'DEFAULT' ? { unknown: `앞의 \`${statement}\` 문장의 ${GLOBAL_DEFAULT}` } : charsetName(t.v);
  // COLLATE 는 NAMES x 뒤에만 쓴다 (NAMES DEFAULT COLLATE y 는 1064 — 8.0.46·8.4.11 실측). x 와 문자셋이 다르면 MySQL 은 1253 으로 거부한다
  const collate = names && !isUnknown(charset) && a.acceptWord('COLLATE') ? collationName(a.next().v) : undefined;
  if (!a.done) fail(`알 수 없는 내용입니다: ${a.peek()!.v} (MySQL 1064)`);
  const connection = !names ? { charset: charsetName(st.defaults.charset), collation: st.defaults.collation } : collate === undefined ? connectionOf(charset) : { charset, collation: collate };
  return () => {
    st.clientCharset = charset;
    st.resultsCharset = charset;
    setConnection(st, connection);
  };
}

// character_set_client·character_set_connection·character_set_results·collation_connection 대입 (applySet 2단계). written: 쓴 값의 첫 토큰 (DEFAULT 는 서버의 전역 값을
// 읽는다). 모르는 값이면 이 대입(assignment)과 까닭을 남긴다
export function assignCharset(st: State, target: string, value: SessionValue, written: Token | undefined, assignment: string): void {
  const resolved: SessionValue = written?.t === 'word' && value === 'DEFAULT' ? { unknown: GLOBAL_DEFAULT } : value;
  const known: SessionValue = isUnknown(resolved)
    ? { unknown: cappedReason(`앞의 \`${assignment}\` 문장이 세션 ${target} 를 알 수 없는 값으로 정했습니다 — ${resolved.unknown}`) }
    : resolved;
  if (target === 'collation_connection') return setConnection(st, connectionWith(isUnknown(known) ? known : collationName(known)));
  const charset = isUnknown(known) ? known : charsetName(known);
  if (target === 'character_set_connection') setConnection(st, connectionOf(charset));
  else if (target === 'character_set_client') st.clientCharset = charset;
  else st.resultsCharset = charset;
}

// 세션 문자셋이 스크립트의 UTF-8 바이트를 같은 글자로 읽지 않으면 ASCII 밖 글자가 든 DDL·루틴 문장을 거부한다. ddl: 문장 원문, toks: 그 토큰 (주석 속 글자는 토큰이 아니다)
export function assertUtf8Session(st: State, ddl: string, toks: readonly Token[]): void {
  const unsafe = unsafeCharset(st);
  if (unsafe !== undefined && toks.some((t) => NON_ASCII.test(ddl.slice(t.s, t.e)))) fail(unsafe);
}

// 받을 수 없는 세션 문자셋의 안내 (둘 다 UTF-8 계열·binary 면 undefined)
function unsafeCharset(st: State): string | undefined {
  for (const [name, value] of [['character_set_client', st.clientCharset], ['character_set_connection', st.connectionCharset]] as const) {
    if (isUnknown(value)) return `세션 ${name} 를 알 수 없어 MySQL 이 이 문장의 ASCII 밖 글자(한글 등)를 어떤 글자로 저장했는지 정할 수 없습니다 — ${value.unknown} — ${RE_EXPORT}`;
    if (!SAFE_CHARSETS.has(value)) {
      return `세션 ${name}=${value} 가 UTF-8 이 아니어서 MySQL 이 이 문장의 ASCII 밖 글자(한글 등)를 ${value} 바이트로 읽어 다른 글자로 저장합니다 — ${RE_EXPORT}`;
    }
  }
  return undefined;
}
