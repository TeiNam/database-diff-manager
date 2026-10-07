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
const ESCAPES: Record<string, string> = { '0': '\0', n: '\n', r: '\r', t: '\t', Z: '\x1a', b: '\b' };

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
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
      const [v, e] = readQuoted(src, i, c);
      out.push({ t: c === '`' ? 'ident' : 'string', v, s: i, e });
      i = e;
      continue;
    }
    if (DIGIT.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: 'number', v: src.slice(i, j), s: i, e: j });
      i = j;
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i;
      while (j < src.length && WORD_CHAR.test(src[j])) j++;
      out.push({ t: 'word', v: src.slice(i, j), s: i, e: j });
      i = j;
      continue;
    }
    out.push({ t: 'op', v: c, s: i, e: i + 1 });
    i++;
  }
  return out;
}

function readQuoted(src: string, start: number, quote: string): [string, number] {
  let value = '';
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === quote) {
      if (src[i + 1] === quote) { value += quote; i += 2; continue; }
      return [value, i + 1];
    }
    if (c === '\\' && quote !== '`') {
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
