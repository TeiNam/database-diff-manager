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
// \% 와 \_ 는 LIKE 패턴 밖에서 백슬래시를 남긴 두 글자다 (MySQL 8.0.46·8.4.11 실측, 매뉴얼 "String Literals"). 그 밖의 모르는 이스케이프는 백슬래시만 버린다
const ESCAPES: Record<string, string> = { '0': '\0', n: '\n', r: '\r', t: '\t', Z: '\x1a', b: '\b', '%': '\\%', _: '\\_' };

// 렉서가 토큰 없이 지나가는 것 가운데 ALTER 적용이 따로 보는 것 (리뷰 11회차 R11-2·Claude F5). 덤프 파서는 주지 않으므로 토큰은 그대로다
export interface LexWatch {
  // '/*!' 를 실행 주석으로 열었다: at 은 '/*!' 의 원문 자리, digits 는 뒤에 붙은 버전 숫자 ('' 이면 번호 없음)
  versioned(at: number, digits: string): void;
  // 열린 실행 주석을 닫는 '*/' 를 읽었다 (따옴표·주석 안의 것은 아니다): at 은 '*/' 의 원문 자리 (리뷰 13회차)
  closed(at: number): void;
  // 열린 실행 주석 안에서 일반 블록 주석('/* … */' — '/*!'·'/*+' 는 아니다)을 열었다: at 은 그 '/*' 의 원문 자리 (리뷰 14회차 F1)
  nested(at: number): void;
  // ASCII 가 아닌 공백(NBSP U+00A0·U+3000·U+FEFF … — JS 의 \s)을 토큰 사이 공백으로 건너뛰었다 (MySQL 은 이름의 글자로 읽는다). at 은 그 글자의 원문 자리
  space(at: number): void;
}

// 문자열 규칙. noBackslashEscapes: SQL_MODE 의 NO_BACKSLASH_ESCAPES (백슬래시를 이스케이프로 보지 않음)
// discardVersioned: 버전 번호가 붙은 버전 주석(/*!NNNNN …*/)을 그 버전보다 낮은 서버처럼 주석으로 건너뛴다 (첫 '*/' 까지 —
// 서버는 그 안의 따옴표를 보지 않는다). 번호 없는 '/*!' 는 어느 서버든 실행하므로 그대로 토큰으로 읽는다
// watch: 실행 주석의 여는 표지와 건너뛴 ASCII 밖 공백을 알린다 (LexWatch — 토큰은 바뀌지 않는다)
export interface LexMode {
  noBackslashEscapes?: boolean;
  discardVersioned?: boolean;
  watch?: LexWatch;
}

export function tokenize(src: string, mode: LexMode = {}): Token[] {
  return [...lexTokens(src, mode)];
}

// 토큰을 하나씩 만든다. mode 는 매 문자열마다 읽으므로 호출자가 도중에 바꿀 수 있다 (덤프 안의 SET SQL_MODE). start: 읽기 시작할 원문 자리 — 그 앞에서 연 주석·따옴표는
// 없는 것으로 본다 (문장 나누기가 DELIMITER 줄 끝에서 새로 읽는다, 리뷰 14회차 F3)
export function* lexTokens(src: string, mode: LexMode = {}, start = 0): Generator<Token> {
  let i = start;
  let versioned = 0; // 열려 있는 /*!NNNNN 주석 수
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { if (c.charCodeAt(0) > 0x7f) mode.watch?.space(i); i++; continue; }
    const marked = versionMarkEnd(src, i, mode);
    if (marked >= 0) {
      i = marked;
      versioned++;
      continue;
    }
    if (versioned > 0 && src.startsWith('*/', i)) { mode.watch?.closed(i); i += 2; versioned--; continue; }
    const comment = commentEnd(src, i);
    if (comment >= 0) {
      if (versioned > 0 && isPlainBlockComment(src, i)) mode.watch?.nested(i);
      i = comment;
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

// i 자리의 '/*!' 실행 주석 표지 바로 뒤 자리 — 표지는 뒤에 붙은 버전 숫자까지다. 표지가 아니거나 discardVersioned 로 주석이 되면 -1
function versionMarkEnd(src: string, i: number, mode: LexMode): number {
  if (!src.startsWith('/*!', i) || (mode.discardVersioned === true && DIGIT.test(src[i + 3] ?? ''))) return -1;
  let end = i + 3;
  while (end < src.length && DIGIT.test(src[end])) end++;
  mode.watch?.versioned(i, src.slice(i + 3, end));
  return end;
}

// i 자리의 일반 블록 주석: '/*' 이고 실행 주석('/*!')·힌트('/*+')가 아니다 — mysql 클라이언트는 이것만 주석으로 지우고(8.0 기본) 나머지 둘은 그대로 보낸다
const isPlainBlockComment = (src: string, i: number): boolean => src.startsWith('/*', i) && src[i + 2] !== '!' && src[i + 2] !== '+';

// i 자리에서 시작하는 주석(블록 '/* … */', '-- …', '# …')의 끝 바로 뒤 자리. 주석이 아니면 -1
function commentEnd(src: string, i: number): number {
  if (src.startsWith('/*', i)) {
    const end = src.indexOf('*/', i + 2);
    if (end < 0) throw new LexError(`닫히지 않은 주석 (위치 ${i})`);
    return end + 2;
  }
  if (!isDashComment(src, i) && src[i] !== '#') return -1;
  const end = src.indexOf('\n', i);
  return end < 0 ? src.length : end + 1;
}

// '--' 줄 주석: 뒤에 공백·탭·개행 같은 공백 문자나 제어 문자가 오거나 입력이 끝나야 한다 (MySQL 서버 sql_lex.cc 규칙).
// mysql 클라이언트는 제어 문자 뒤를 주석으로 보지 않으므로 최종 단일 문장 검사(statement-check)가 제어 문자 섞인 주석을 따로 거부한다
const DASH_COMMENT_NEXT = /[\x00-\x20\x7f]/;
const isDashComment = (src: string, i: number): boolean => src.startsWith('--', i) && (i + 2 >= src.length || DASH_COMMENT_NEXT.test(src[i + 2]));

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

// SELECT 본문에서 FROM/JOIN 뒤에 오는 테이블 이름 (`schema`.`table` 은 table). 토큰으로 나눌 수 없으면 undefined.
// local: 현재 스키마 이름들. 주면 다른 스키마로 한정된 참조(`ext`.`t`)는 로컬 객체가 아니므로 뺀다 (SHOW CREATE VIEW 는 현재 스키마
// 한정자를 생략하고 다른 스키마만 한정한다). 주지 않으면 한정자를 보지 않는다
export function tableReferences(src: string, local?: ReadonlySet<string>): string[] | undefined {
  const tokens = tryTokenize(src);
  return tokens && relationNames(tokens, local);
}

function relationNames(tokens: Token[], local?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  tokens.forEach((tok, i) => {
    if (tok.t !== 'word' || !TABLE_KEYWORD.test(tok.v)) return;
    let j = i + 1;
    while (tokens[j]?.v === '(' && tokens[j].t === 'op') j++;
    const first = tokens[j];
    if (first?.t !== 'ident') return;
    const qualified = isOp(tokens[j + 1], '.') && tokens[j + 2]?.t === 'ident';
    if (qualified && !isLocal(first.v, local)) return;
    out.push(qualified ? tokens[j + 2].v : first.v);
  });
  return out;
}

const isOp = (t: Token | undefined, v: string): boolean => t?.t === 'op' && t.v === v;
const isLocal = (schema: string, local?: ReadonlySet<string>): boolean => local === undefined || local.has(schema);

// '(' 앞에 오지만 함수 이름이 아닌 키워드
const NOT_CALL = /^(FROM|JOIN|STRAIGHT_JOIN|IN|ON|AS|AND|OR|NOT|XOR|EXISTS|WHERE|SELECT|USING|ANY|ALL|SOME|UNION|VALUES|OVER|WINDOW|LATERAL|WITH|INTERVAL|HAVING|BY|THEN|ELSE|WHEN|CASE|IS)$/i;

// 뷰 본문이 쓰는 객체 이름. relations: FROM/JOIN 뒤 테이블·뷰 (테이블·뷰 이름 공간), routines: `이름`( 형태의 함수 호출
// (`schema`.`fn`( 은 fn. 함수 이름 공간 — 같은 이름의 테이블과 무관하다). local 은 tableReferences 와 같다 (다른 스키마 함수도 뺀다)
export interface References {
  relations: string[];
  routines: string[];
}

// 별칭(AS 뒤)·컬럼 참조(`t`.`c`)·문자열·주석 안의 이름은 빼고, 토큰으로 나눌 수 없으면 undefined
export function viewReferences(src: string, local?: ReadonlySet<string>): References | undefined {
  const tokens = tryTokenize(src);
  if (!tokens) return undefined;
  const qualifier = (i: number) => (isOp(tokens[i - 1], '.') && (tokens[i - 2]?.t === 'ident' || tokens[i - 2]?.t === 'word') ? tokens[i - 2].v : undefined);
  const calls = tokens.filter((tok, i) => (tok.t === 'ident' || (tok.t === 'word' && !NOT_CALL.test(tok.v))) && isOp(tokens[i + 1], '(')
    && (qualifier(i) === undefined || isLocal(qualifier(i)!, local))).map((tok) => tok.v);
  return { relations: [...new Set(relationNames(tokens, local))], routines: [...new Set(calls)] };
}

// 뷰 본문이 쓰는 객체 이름 (viewReferences). 토큰으로 나눌 수 없으면 후보 중 `이름` 이 나오기만 해도 양쪽 모두로 본다 (안전 쪽).
// 뷰 생성 순서·객체 카드 복사 묶음·수동 확인 전파가 같은 판정을 쓰도록 한곳에 둔다
export function objectReferences(body: string, candidates: Iterable<string>, local?: ReadonlySet<string>): References {
  const refs = viewReferences(body, local);
  if (refs) return refs;
  const hits = [...new Set(candidates)].filter((n) => body.includes(quoteIdent(n)));
  return { relations: hits, routines: hits };
}
