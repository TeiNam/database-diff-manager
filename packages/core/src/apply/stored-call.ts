// 무시하는 문장 속 저장 함수 호출 (리뷰 7회차 R7-2·8회차·9회차·10회차). 이 도구는 문장을 실행하지 않으므로 저장 함수가 바꿨을 수 있는 세션 상태를 모르는 값으로 둔다.
// 문장은 받는다 — 거부는 뒤에서 그 값에 기대는 문장이 한다 (unknown-session.ts·session.ts). 함수를 만들어 데이터를 고친 뒤 지우는 마이그레이션이 흔하다.
// 이름이 같은 저장 함수가 있어도 MySQL 이 내장 함수를 부르는 꼴은 native-functions.ts 가 가른다
import type { Token } from '../lexer';
import { callsNativeFunction } from './native-functions';
import { routineKey, type State } from './state';

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

const hasMode = (sqlMode: string, mode: string): boolean => sqlMode.split(',').includes(mode);

// 호출을 읽는 세션 SQL_MODE 의 IGNORE_SPACE (리뷰 10회차 R10-1 — 공백을 끼운 NOW () 도 내장 함수가 된다). 모르면 undefined: 세션 SQL_MODE 를 모르거나(앞의 SET 이 값을 모르는
// 변수에서 정했다), 처음 세션 SQL_MODE(서버가 기준 버전 루틴에서 짐작한 값 — 설계 4장)에 IGNORE_SPACE 가 있어 지금 값의 IGNORE_SPACE 가 짐작에서 왔을 수 있다 (보수적)
function ignoreSpace(st: State): boolean | undefined {
  if (st.sqlModeUnknown !== undefined) return undefined;
  if (!hasMode(st.sqlMode, 'IGNORE_SPACE')) return false;
  return hasMode(st.initialSqlMode, 'IGNORE_SPACE') ? undefined : true;
}

// 스키마 없이 쓴 이름이 MySQL 이 내장 함수로 읽는 꼴인가 (native-functions.ts — 이름과 '(' 사이의 원문으로 공백·주석을 가른다). 이름 토큰이 단어여야 한다 (백틱·숫자로 시작하는
// 이름은 센다)
function isBuiltinCall(st: State, toks: readonly Token[], src: string, open: number, name: Name): boolean {
  const word = toks[open - 1];
  if (word.t !== 'word' || name.start !== open - 1) return false;
  return callsNativeFunction(word.v, src.slice(word.e, toks[open].s), ignoreSpace(st));
}

// toks[open] 의 '(' 가 저장 함수 호출을 여는가 — 안내에 쓰는 이름 (아니면 undefined). 스키마를 붙인 호출은 늘 저장 함수다: 현재 스키마면 모델의 함수만 보고, 다른 스키마의
// 함수는 이 버전이 모르는 함수라 본문을 볼 수 없어 함께 센다. 'INTO t (' 는 INSERT·REPLACE 의 테이블과 컬럼 목록이다. 스키마 없는 이름은 모델의 함수만 보되,
// 내장 함수가 이기는 꼴은 뺀다 (리뷰 8회차 R8-1·9회차 R9-1 — MySQL 은 따옴표·스키마 없는 CONCAT( 를 이름이 같은 저장 함수가 있어도 내장 함수로 읽는다)
function storedCallAt(st: State, toks: readonly Token[], src: string, open: number): string | undefined {
  const callee = calleeBefore(toks, open);
  if (!callee) return undefined;
  const { name, schema } = callee;
  const before = toks[(schema ?? name).start - 1];
  if (before?.t === 'word' && before.v.toUpperCase() === 'INTO') return undefined;
  if (schema) return schema.text === st.schemaName && !isModelFunction(st, name.text) ? undefined : `${schema.text}.${name.text}`;
  if (!isModelFunction(st, name.text)) return undefined;
  return isBuiltinCall(st, toks, src, open, name) ? undefined : name.text;
}

// 문장이 부르는 첫 저장 함수 (없으면 undefined). src: 토큰의 원문. 문자열·주석 속 글자는 토큰이 아니라 걸리지 않는다. 내장 함수 판정은 지금 세션 SQL_MODE 로 한다 —
// SET 문은 대입하기 전에 문장 전체를 읽으므로 session.ts 가 대입보다 먼저 부른다
export function storedFunctionCall(st: State, toks: readonly Token[], src: string): string | undefined {
  for (let k = 1; k < toks.length; k++) {
    if (!isOp(toks[k], '(')) continue;
    const call = storedCallAt(st, toks, src, k);
    if (call !== undefined) return call;
  }
  return undefined;
}

// 무시하는 문장(조회·데이터 문장, 값을 버리는 서버 변수 대입 — no-op.ts·session.ts)이 저장 함수를 부르면, 함수가 바꿨을 수 있는 세션 상태를 모르는 값으로 둔다 (리뷰 8회차):
// 사용자 변수는 모두 잊고(다른 변수에서 옮긴 값도 함께 — 함수는 어느 변수든 바꿀 수 있다. 호출 전에 저장한 이름은 안내에 쓰려고 st.forgotten 에 남긴다 — 이미 모르는 값이었던
// 것도 같다: mysqldump 머리의 'SET @OLD_TIME_ZONE=@@TIME_ZONE' 은 따라가지 않는 변수를 읽어 모르는 값이지만 꼬리가 되돌리는 저장한 값이다, 리뷰 11회차 R11-3), UTC 로 정한 세션
// time_zone 도 UTC 로 보지 않으며, 전역 sql_mode 도 바뀌었을 수 있다고 기억한다 (st.storedCall — 뒤의 SET sql_mode = DEFAULT 가 정한 세션 값을 모른다). 세션 sql_mode·
// FOREIGN_KEY_CHECKS 는 MySQL 이 함수에서 돌아올 때 되돌린다 (8.0.46·8.4.11 실측).
// 한계: 함수가 바꾼 그 밖의 세션 변수(default_storage_engine 등)는 따라가지 않는다 — 막으려면 호출 뒤의 CREATE TABLE 을 거의 모두 거부해야 한다 (설계 3.2)
// call: 그 문장이(SET 문이면 그 대입이) 부르는 저장 함수 (storedFunctionCall, 없으면 undefined — 아무것도 바꾸지 않는다)
export function forgetStateChangedBy(st: State, call: string | undefined): void {
  if (call === undefined) return;
  for (const name of st.saved.keys()) st.forgotten.add(name);
  st.saved.clear();
  if (st.timeZoneUtc) st.timeZoneUnknown = `무시한 문장의 저장 함수 호출(\`${call}\`)이 세션 시간대를 바꿨을 수 있어`;
  st.timeZoneUtc = false;
  st.storedCall = call;
}
