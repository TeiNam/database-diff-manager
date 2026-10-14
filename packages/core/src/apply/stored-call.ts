// 무시하는 문장 속 저장 함수 호출 (리뷰 7회차 R7-2·8회차·9회차). 이 도구는 문장을 실행하지 않으므로 저장 함수가 바꿨을 수 있는 세션 상태를 모르는 값으로 둔다.
// 문장은 받는다 — 거부는 뒤에서 그 값을 읽는 문장이 한다 (session.ts). 함수를 만들어 데이터를 고친 뒤 지우는 마이그레이션이 흔하다
import type { Token } from '../lexer';
import { isUnknown, routineKey, type State } from './state';

// 이름이 같은 저장 함수가 있어도 MySQL 이 내장 함수를 부르는 잘 알려진 이름 (소문자). 따옴표·스키마 없이 쓸 때만이다 (8.0.46·8.4.11 실측: 이 이름의 저장 함수를 모두
// 만든 뒤 불러도 내장 함수가 돈다). 백틱으로 감싸면(`now`()) 저장 함수를 부르는 이름이 있어 저장 함수 호출로 본다. 목록에 없는 내장 함수도 이름이 같은 저장 함수가
// 모델에 있으면 저장 함수 호출로 본다 (보수적 — 뒤에서 그 값을 읽는 문장만 거부된다)
const BUILTIN_FUNCTIONS: ReadonlySet<string> = new Set([
  'concat', 'concat_ws', 'substring', 'substr', 'left', 'right', 'length', 'char_length', 'lower', 'upper', 'trim', 'ltrim', 'rtrim', 'replace', 'lpad', 'rpad',
  'repeat', 'reverse', 'locate', 'instr', 'format', 'hex', 'unhex', 'md5', 'sha1', 'sha2', 'uuid', 'group_concat', 'field', 'find_in_set',
  'if', 'ifnull', 'nullif', 'coalesce', 'isnull', 'greatest', 'least',
  'now', 'curdate', 'curtime', 'current_timestamp', 'sysdate', 'utc_timestamp', 'date', 'year', 'month', 'day', 'date_add', 'date_sub', 'datediff', 'date_format',
  'str_to_date', 'from_unixtime', 'unix_timestamp', 'timestampdiff',
  'abs', 'ceil', 'floor', 'round', 'truncate', 'mod', 'rand', 'cast', 'convert', 'count', 'sum', 'avg', 'min', 'max',
  'json_object', 'json_array', 'json_extract', 'json_unquote', 'json_set', 'json_contains',
  'last_insert_id', 'row_count', 'database', 'user', 'current_user', 'version', 'uuid_to_bin', 'bin_to_uuid', 'inet_aton', 'inet_ntoa', 'sleep',
]);
// 그 가운데 바로 뒤에 '(' 가 붙어야 내장 함수인 이름 (MySQL lex.h 의 SYM_FN — 매뉴얼 "Function Name Parsing and Resolution"). 공백·주석을 끼우면(NOW () · NOW/**/())
// MySQL 이 식별자로 읽어 저장 함수를 부른다. 나머지 이름(CONCAT·IFNULL …)은 공백·주석과 상관없이 내장 함수다 (리뷰 9회차 R9-1 — 목록의 이름마다 8.0.46·8.4.11 실측).
// IGNORE_SPACE 세션에서는 공백만 끼운 꼴도 내장 함수지만(주석을 끼우면 저장 함수) 가르지 않고 센다 (보수적)
const ADJACENT_ONLY_BUILTINS: ReadonlySet<string> = new Set([
  'now', 'curdate', 'curtime', 'sysdate', 'date_add', 'date_sub', 'substring', 'substr', 'trim', 'group_concat', 'cast', 'count', 'sum', 'min', 'max',
]);

const DIGITS = /^[0-9]+$/;
const isOp = (t: Token | undefined, v: string): boolean => t?.t === 'op' && t.v === v;
const isModelFunction = (st: State, name: string): boolean => st.routineKeys.has(routineKey({ kind: 'function', name }));

interface Name {
  readonly text: string;
  readonly start: number; // 이름의 첫 토큰 자리
}

// toks[end] 에서 끝나는 이름: 백틱 식별자, 단어, 숫자로 시작하는 단어. MySQL 은 숫자로만 되지 않은 이름이면 숫자로 시작해도 식별자로 읽는데(1fn — 8.0.46·8.4.11 실측)
// 렉서는 숫자 1 과 단어 fn 으로 나누므로, 단어 바로 앞에 붙은 숫자 토큰을 이름에 넣는다 (리뷰 8회차 R8-2)
function nameEndingAt(toks: readonly Token[], end: number): Name | undefined {
  const t = toks[end];
  if (t?.t === 'ident') return { text: t.v, start: end };
  if (t?.t !== 'word') return undefined;
  const digits = toks[end - 1];
  return digits?.t === 'number' && DIGITS.test(digits.v) && digits.e === t.s ? { text: digits.v + t.v, start: end - 1 } : { text: t.v, start: end };
}

interface Callee {
  readonly name: Name;
  readonly schema: Name | undefined; // '스키마.이름(' 의 스키마
}

// toks[open] 의 '(' 앞의 [스키마.]이름 (아니면 undefined). 스키마로 한정한 자리('.' 바로 뒤)는 숫자처럼 보이는 토큰(0xface·0b101·123)도 이름이다: MySQL 은 '.' 바로 뒤를
// 식별자로 읽는데 (shop.0xface() 는 저장 함수 0xface — 8.0.46·8.4.11 실측) 렉서는 16진수·비트·숫자 리터럴로 읽는다 (리뷰 9회차 R9-2). 한정하지 않은 숫자는 MySQL 도
// 리터럴로 읽는다 (0xface() 는 1064)
function calleeBefore(toks: readonly Token[], open: number): Callee | undefined {
  const last = toks[open - 1];
  if (last?.t === 'number') {
    const schema = isOp(toks[open - 2], '.') ? nameEndingAt(toks, open - 3) : undefined;
    return schema ? { name: { text: last.v, start: open - 1 }, schema } : undefined;
  }
  const name = nameEndingAt(toks, open - 1);
  if (!name) return undefined;
  return { name, schema: isOp(toks[name.start - 1], '.') ? nameEndingAt(toks, name.start - 2) : undefined };
}

// 스키마 없이 쓴 이름이 MySQL 이 내장 함수로 읽는 꼴인가 (BUILTIN_FUNCTIONS — 바로 '(' 가 붙어야 하는 이름은 ADJACENT_ONLY_BUILTINS). 이름 토큰이 단어여야 한다 (백틱은 센다)
function isBuiltinCall(toks: readonly Token[], open: number, name: Name): boolean {
  const word = toks[open - 1];
  const lower = name.text.toLowerCase();
  if (word.t !== 'word' || !BUILTIN_FUNCTIONS.has(lower)) return false;
  return word.e === toks[open].s || !ADJACENT_ONLY_BUILTINS.has(lower);
}

// toks[open] 의 '(' 가 저장 함수 호출을 여는가 — 안내에 쓰는 이름 (아니면 undefined). 스키마를 붙인 호출은 늘 저장 함수다: 현재 스키마면 모델의 함수만 보고, 다른 스키마의
// 함수는 이 버전이 모르는 함수라 본문을 볼 수 없어 함께 센다. 'INTO t (' 는 INSERT·REPLACE 의 테이블과 컬럼 목록이다. 스키마 없는 이름은 모델의 함수만 보되,
// 내장 함수가 이기는 꼴은 뺀다 (리뷰 8회차 R8-1·9회차 R9-1 — MySQL 은 따옴표·스키마 없는 CONCAT( 를 이름이 같은 저장 함수가 있어도 내장 함수로 읽는다)
function storedCallAt(st: State, toks: readonly Token[], open: number): string | undefined {
  const callee = calleeBefore(toks, open);
  if (!callee) return undefined;
  const { name, schema } = callee;
  const before = toks[(schema ?? name).start - 1];
  if (before?.t === 'word' && before.v.toUpperCase() === 'INTO') return undefined;
  if (schema) return schema.text === st.schemaName && !isModelFunction(st, name.text) ? undefined : `${schema.text}.${name.text}`;
  if (!isModelFunction(st, name.text)) return undefined;
  return isBuiltinCall(toks, open, name) ? undefined : name.text;
}

// 문장이 부르는 첫 저장 함수 (없으면 undefined). 문자열·주석 속 글자는 토큰이 아니라 걸리지 않는다
export function storedFunctionCall(st: State, toks: readonly Token[]): string | undefined {
  for (let k = 1; k < toks.length; k++) {
    if (!isOp(toks[k], '(')) continue;
    const call = storedCallAt(st, toks, k);
    if (call !== undefined) return call;
  }
  return undefined;
}

// 무시하는 문장(조회·데이터 문장, 값을 버리는 서버 변수 대입 — no-op.ts·session.ts)이 저장 함수를 부르면, 함수가 바꿨을 수 있는 세션 상태를 모르는 값으로 둔다 (리뷰 8회차):
// 사용자 변수는 모두 잊고(다른 변수에서 옮긴 값도 함께 — 함수는 어느 변수든 바꿀 수 있다. 저장한 값을 잊은 이름은 안내에 쓰려고 st.forgotten 에 남긴다), UTC 로 정한 세션
// time_zone 도 UTC 로 보지 않으며, 전역 sql_mode 도 바뀌었을 수 있다고 기억한다 (st.storedCall — 뒤의 SET sql_mode = DEFAULT 가 정한 세션 값을 모른다). 세션 sql_mode·
// FOREIGN_KEY_CHECKS 는 MySQL 이 함수에서 돌아올 때 되돌린다 (8.0.46·8.4.11 실측).
// 한계: 함수가 바꾼 그 밖의 세션 변수(default_storage_engine 등)는 따라가지 않는다 — 막으려면 호출 뒤의 CREATE TABLE 을 거의 모두 거부해야 한다 (설계 3.2)
export function forgetStateChangedByCall(st: State, toks: readonly Token[]): void {
  const call = storedFunctionCall(st, toks);
  if (call === undefined) return;
  for (const [name, value] of st.saved) if (!isUnknown(value)) st.forgotten.add(name);
  st.saved.clear();
  if (st.timeZoneUtc) st.timeZoneUnknown = `무시한 문장의 저장 함수 호출(\`${call}\`)이 세션 시간대를 바꿨을 수 있어`;
  st.timeZoneUtc = false;
  st.storedCall = call;
}
