// 출력 DDL 에 따옴표 없이 들어가는 입력 값의 화이트리스트 (MD·SQL 덤프 출처 공통, 스펙 4.6 주입 방지).
// 이름은 quoteIdent, 문자열은 quoteString 으로 인용하므로 여기서는 인용하지 않고 그대로 찍는 값만 본다.
// 맞지 않으면 UnsafeValueError 를 던진다 — 파서가 그 객체를 parse-error 로 남긴다
import { scanGaps } from './comment-scan';
import { LexError, tokenize, type Token } from './lexer';

export class UnsafeValueError extends Error {}

// 엔진·문자셋·콜레이션·행 형식 등 식별자형 값
const WORD_VALUE = /^\w+$/;
// ON UPDATE 에 올 수 있는 값 (SHOW CREATE·information_schema 표기)
const ON_UPDATE_VALUE = /^current_timestamp(\(\d*\))?$/i;
// mysql 클라이언트가 문장 밖에서 명령으로 읽는 단어 (줄 맨 앞)
const CLIENT_COMMAND = /^DELIMITER$/i;
// 데이터 타입 괄호 안: 숫자 목록(길이·정밀도) 또는 문자열 목록(enum·set)
const TYPE_ARG = (t: Token) => t.t === 'number' || t.t === 'string';

const fail = (what: string, value: string): never => {
  throw new UnsafeValueError(`${what} 값이 허용 형식이 아닙니다: ${JSON.stringify(value)}`);
};

export function assertWord(value: string, what: string): string {
  return WORD_VALUE.test(value) ? value : fail(what, value);
}

export function assertOnUpdate(value: string): string {
  return ON_UPDATE_VALUE.test(value) ? value : fail('ON UPDATE', value);
}

const lex = (src: string, what: string): Token[] => {
  try {
    return tokenize(src);
  } catch (e) {
    if (e instanceof LexError) return fail(what, src);
    throw e;
  }
};

// 토큰 사이(앞뒤 포함)에 공백 말고 다른 글자가 있으면 주석이다 (lexer 는 주석을 건너뛴다)
function hasComment(src: string, toks: Token[]): boolean {
  let pos = 0;
  for (const t of [...toks, { s: src.length, e: src.length }]) {
    if (src.slice(pos, t.s).trim() !== '') return true;
    pos = t.e;
  }
  return false;
}

// 식(Default 식, 인덱스 식, 생성 컬럼 식, CHECK 식)과 뷰 본문: 문장 끝(;)·주석·괄호 불균형·클라이언트 명령(DELIMITER, '\\g' 같은
// 백슬래시 명령)이 있으면 거부한다. 한 식 안에서는 어느 것도 나올 수 없다.
// allowComments: SHOW CREATE VIEW 본문처럼 주석이 문장 경계를 바꾸지 않는 출처 (최종 단일 문장 검사가 다시 본다). 그때도 주석은
// 평평해야 한다 — 주석 안 '/*', hint 안 백슬래시·delimiter 는 mysql 클라이언트의 주석 경계를 바꾼다 (comment-scan, 12회차)
export function assertExpression(src: string, what: string, opts: { allowComments?: boolean } = {}): string {
  const toks = lex(src, what);
  if (!opts.allowComments && hasComment(src, toks)) return fail(what, src);
  if (opts.allowComments && !scanGaps(src, toks).safe) return fail(what, src);
  let depth = 0;
  for (const t of toks) {
    if (t.t === 'word' && CLIENT_COMMAND.test(t.v)) return fail(what, src);
    if (t.t !== 'op') continue;
    if (t.v === ';' || t.v === '\\') return fail(what, src);
    if (t.v === '(') depth++;
    else if (t.v === ')' && --depth < 0) return fail(what, src);
  }
  return depth === 0 ? src : fail(what, src);
}

// MySQL 데이터 타입: 이름(단어) 뒤에 선택적인 괄호 하나 — 숫자 목록(varchar(32), decimal(10,2)) 또는 문자열 목록(enum·set) —
// 그 뒤에 수식 단어(unsigned, zerofill, CHARACTER SET x, COLLATE x …). 단어는 \w+ 만 허용한다
export function assertDataType(src: string): string {
  const toks = lex(src, '타입');
  if (!toks.length || hasComment(src, toks)) return fail('타입', src);
  let i = 0;
  const isWord = (t: Token | undefined) => t?.t === 'word' && WORD_VALUE.test(t.v) && !CLIENT_COMMAND.test(t.v);
  while (isWord(toks[i])) i++;
  if (i === 0) return fail('타입', src);
  if (toks[i]?.t === 'op' && toks[i].v === '(') {
    i++;
    for (let expectArg = true; ; expectArg = !expectArg) {
      const t = toks[i++];
      if (expectArg ? !t || !TYPE_ARG(t) : !(t?.t === 'op' && (t.v === ',' || t.v === ')'))) return fail('타입', src);
      if (!expectArg && t.v === ')') break;
    }
  }
  while (isWord(toks[i])) i++;
  return i === toks.length ? src : fail('타입', src);
}
