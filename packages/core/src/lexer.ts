// SQL 텍스트를 토큰으로 나눈다. MySQL SHOW CREATE 출력 형식을 대상으로 한다.
export type TokenType = 'ident' | 'string' | 'number' | 'word' | 'op';

export interface Token {
  t: TokenType;
  v: string; // 디코딩된 값 (따옴표·이스케이프 제거)
  s: number; // 원문 시작 오프셋
  e: number; // 원문 끝 오프셋 (exclusive)
}

export class LexError extends Error {}

const WORD_START = /[A-Za-z_$\u0080-\uFFFF]/;
const WORD_CHAR = /[A-Za-z0-9_$\u0080-\uFFFF]/;
const DIGIT = /[0-9]/;
// 16진수·비트 리터럴: 0x00FF, 0b101 (뒤에 단어 문자가 이어지면 리터럴이 아니다), x'0A', b'101' — 한 토큰(number)으로 원문 그대로 둔다
const HEX_BIT = /0x[0-9A-Fa-f]+|0b[01]+|[xX]'[0-9A-Fa-f]*'|[bB]'[01]*'/y;
const ESCAPES: Record<string, string> = { '0': '\0', n: '\n', r: '\r', t: '\t', Z: '\x1a', b: '\b' };

// 문자열 규칙. noBackslashEscapes: SQL_MODE 의 NO_BACKSLASH_ESCAPES (백슬래시를 이스케이프로 보지 않음)
export interface LexMode {
  noBackslashEscapes?: boolean;
}

export function tokenize(src: string, mode: LexMode = {}): Token[] {
  return [...lexTokens(src, mode)];
}

// 토큰을 하나씩 만든다. mode 는 매 문자열마다 읽으므로 호출자가 도중에 바꿀 수 있다 (덤프 안의 SET SQL_MODE)
export function* lexTokens(src: string, mode: LexMode = {}): Generator<Token> {
  let i = 0;
  let versioned = 0; // 열려 있는 /*!NNNNN 주석 수
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith('/*!', i)) {
      i += 3;
      while (i < src.length && DIGIT.test(src[i])) i++;
      versioned++;
      continue;
    }
    if (versioned > 0 && src.startsWith('*/', i)) { i += 2; versioned--; continue; }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new LexError(`닫히지 않은 주석 (위치 ${i})`);
      i = end + 2;
      continue;
    }
    if (src.startsWith('-- ', i) || c === '#') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === '`' || c === "'" || c === '"') {
      const [v, e] = readQuoted(src, i, c, mode.noBackslashEscapes === true);
      yield { t: c === '`' ? 'ident' : 'string', v, s: i, e };
      i = e;
      continue;
    }
    const literal = hexBitLiteral(src, i);
    if (literal) {
      yield { t: 'number', v: literal, s: i, e: i + literal.length };
      i += literal.length;
      continue;
    }
    if (DIGIT.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      yield { t: 'number', v: src.slice(i, j), s: i, e: j };
      i = j;
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i;
      while (j < src.length && WORD_CHAR.test(src[j])) j++;
      yield { t: 'word', v: src.slice(i, j), s: i, e: j };
      i = j;
      continue;
    }
    yield { t: 'op', v: c, s: i, e: i + 1 };
    i++;
  }
}

function hexBitLiteral(src: string, at: number): string | undefined {
  HEX_BIT.lastIndex = at;
  const m = HEX_BIT.exec(src);
  if (!m) return undefined;
  const end = at + m[0].length;
  return m[0].startsWith('0') && end < src.length && WORD_CHAR.test(src[end]) ? undefined : m[0];
}

function readQuoted(src: string, start: number, quote: string, noBackslashEscapes = false): [string, number] {
  let value = '';
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === quote) {
      if (src[i + 1] === quote) { value += quote; i += 2; continue; }
      return [value, i + 1];
    }
    if (c === '\\' && quote !== '`' && !noBackslashEscapes) {
      const n = src[i + 1] ?? '';
      value += ESCAPES[n] ?? n;
      i += 2;
      continue;
    }
    value += c;
    i++;
  }
  throw new LexError(`닫히지 않은 따옴표 (위치 ${start})`);
}

export function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

// SHOW CREATE TABLE의 문자열 인용 규칙 (sql_show.cc append_unescaped)
export function quoteString(value: string): string {
  const body = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0')
    .replace(/\x1a/g, '\\Z');
  return `'${body}'`;
}

// 원문에 나오는 따옴표 식별자(`…`) 값. 문자열·주석 안은 빼고, 토큰으로 나눌 수 없으면 undefined
export function quotedIdentifiers(src: string): string[] | undefined {
  try {
    return tokenize(src).filter((t) => t.t === 'ident').map((t) => t.v);
  } catch (e) {
    if (e instanceof LexError) return undefined;
    throw e;
  }
}

const TABLE_KEYWORD = /^(FROM|JOIN|STRAIGHT_JOIN)$/i;

const tryTokenize = (src: string): Token[] | undefined => {
  try {
    return tokenize(src);
  } catch (e) {
    if (e instanceof LexError) return undefined;
    throw e;
  }
};

// SELECT 본문에서 FROM/JOIN 뒤에 오는 테이블 이름 (`schema`.`table` 은 table). 토큰으로 나눌 수 없으면 undefined
export function tableReferences(src: string): string[] | undefined {
  const tokens = tryTokenize(src);
  if (!tokens) return undefined;
  const out: string[] = [];
  tokens.forEach((tok, i) => {
    if (tok.t !== 'word' || !TABLE_KEYWORD.test(tok.v)) return;
    let j = i + 1;
    while (tokens[j]?.v === '(' && tokens[j].t === 'op') j++;
    const first = tokens[j];
    if (first?.t !== 'ident') return;
    const qualified = tokens[j + 1]?.t === 'op' && tokens[j + 1].v === '.' && tokens[j + 2]?.t === 'ident';
    out.push(qualified ? tokens[j + 2].v : first.v);
  });
  return out;
}

// '(' 앞에 오지만 함수 이름이 아닌 키워드
const NOT_CALL = /^(FROM|JOIN|STRAIGHT_JOIN|IN|ON|AS|AND|OR|NOT|XOR|EXISTS|WHERE|SELECT|USING|ANY|ALL|SOME|UNION|VALUES|OVER|WINDOW|LATERAL|WITH|INTERVAL|HAVING|BY|THEN|ELSE|WHEN|CASE|IS)$/i;

// 뷰 본문이 쓰는 객체 이름. relations: FROM/JOIN 뒤 테이블·뷰 (테이블·뷰 이름 공간), routines: `이름`( 형태의 함수 호출
// (`schema`.`fn`( 은 fn. 함수 이름 공간 — 같은 이름의 테이블과 무관하다)
export interface References {
  relations: string[];
  routines: string[];
}

// 별칭(AS 뒤)·컬럼 참조(`t`.`c`)·문자열·주석 안의 이름은 빼고, 토큰으로 나눌 수 없으면 undefined
export function viewReferences(src: string): References | undefined {
  const tokens = tryTokenize(src);
  const tables = tableReferences(src);
  if (!tokens || !tables) return undefined;
  const calls = tokens.filter((tok, i) => (tok.t === 'ident' || (tok.t === 'word' && !NOT_CALL.test(tok.v))) && tokens[i + 1]?.t === 'op' && tokens[i + 1].v === '(').map((tok) => tok.v);
  return { relations: [...new Set(tables)], routines: [...new Set(calls)] };
}

// 뷰 본문이 쓰는 객체 이름 (viewReferences). 토큰으로 나눌 수 없으면 후보 중 `이름` 이 나오기만 해도 양쪽 모두로 본다 (안전 쪽).
// 뷰 생성 순서·객체 카드 복사 묶음·수동 확인 전파가 같은 판정을 쓰도록 한곳에 둔다
export function objectReferences(body: string, candidates: Iterable<string>): References {
  const refs = viewReferences(body);
  if (refs) return refs;
  const hits = [...new Set(candidates)].filter((n) => body.includes(quoteIdent(n)));
  return { relations: hits, routines: hits };
}
