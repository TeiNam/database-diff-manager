// 토큰 배열 위를 움직이는 파서 도우미
import type { Token } from './lexer';

export class ParseError extends Error {}
// 따옴표 없는 숫자 시작 이름(2024_sales)을 읽지 못했다 — MySQL 은 받는 이름이라 MySQL 오류 번호를 붙이지 않는다 (Cursor.ident)
export class DigitLeadingNameError extends ParseError {}

export function lineOf(src: string, pos: number): number {
  return src.slice(0, pos).split('\n').length;
}

// toks[from] 부터 공백 없이 이어진 단어·숫자 토큰의 마지막 (렉서는 따옴표 없는 2024_sales 를 숫자 2024 와 단어 _sales 로 나눈다)
function adjacentEnd(toks: readonly Token[], from: number): Token {
  let end = toks[from];
  for (let k = from + 1; k < toks.length && toks[k].s === end.e && (toks[k].t === 'word' || toks[k].t === 'number'); k++) end = toks[k];
  return end;
}

export class Cursor {
  i = 0;

  constructor(readonly toks: Token[], readonly src: string) {}

  get done(): boolean {
    return this.i >= this.toks.length;
  }

  peek(offset = 0): Token | undefined {
    return this.toks[this.i + offset];
  }

  next(): Token {
    const t = this.toks[this.i];
    if (!t) throw this.error('예상치 못한 끝');
    this.i++;
    return t;
  }

  // 연속된 단어가 모두 일치하는지 (대소문자 무시)
  isWord(...words: string[]): boolean {
    return words.every((w, k) => {
      const t = this.peek(k);
      return t?.t === 'word' && t.v.toUpperCase() === w;
    });
  }

  acceptWord(...words: string[]): boolean {
    if (!this.isWord(...words)) return false;
    this.i += words.length;
    return true;
  }

  expectWord(...words: string[]): void {
    if (!this.acceptWord(...words)) throw this.error(`${words.join(' ')} 필요`);
  }

  isOp(v: string): boolean {
    const t = this.peek();
    return t?.t === 'op' && t.v === v;
  }

  acceptOp(v: string): boolean {
    if (!this.isOp(v)) return false;
    this.i++;
    return true;
  }

  expectOp(v: string): void {
    if (!this.acceptOp(v)) throw this.error(`'${v}' 필요`);
  }

  // 이름 (백틱 식별자·단어). 숫자로 시작하는 이름(2024_sales·4x)은 렉서가 숫자와 단어로 나누므로 읽지 못한다 — MySQL 은 숫자로만 되지 않은 이름이면 식별자로 읽으니
  // 백틱으로 감싸라고 안내한다 (리뷰 9회차 Claude 참고 3. 렉서는 바꾸지 않는다)
  ident(): string {
    const t = this.next();
    if (t.t === 'ident' || t.t === 'word') return t.v;
    if (t.t !== 'number' || !/^[0-9]/.test(t.v)) throw this.error('식별자 필요', t);
    const name = this.src.slice(t.s, adjacentEnd(this.toks, this.i - 1).e);
    throw new DigitLeadingNameError(this.located(`식별자 필요 — 숫자로 시작하는 이름(${name})은 백틱(\`)으로 감싸 주세요`, t));
  }

  string(): string {
    const t = this.next();
    if (t.t !== 'string') throw this.error('문자열 필요', t);
    return t.v;
  }

  // '(' 를 이미 소비한 상태에서 짝이 맞는 ')' 까지 소비하고 그 토큰을 반환
  closeParen(): Token {
    let depth = 1;
    for (;;) {
      const t = this.next();
      if (t.t !== 'op') continue;
      if (t.v === '(') depth++;
      else if (t.v === ')' && --depth === 0) return t;
    }
  }

  // 괄호 블록을 소비하고 안쪽 토큰을 반환
  parenTokens(): Token[] {
    this.expectOp('(');
    const start = this.i;
    this.closeParen();
    return this.toks.slice(start, this.i - 1);
  }

  // 괄호 블록을 소비하고 안쪽 원문을 반환
  parenRaw(): string {
    const open = this.peek();
    this.expectOp('(');
    const close = this.closeParen();
    return this.src.slice(open!.e, close.s).trim();
  }

  // 값 하나의 원문: 리터럴, 단어, 괄호식, CURRENT_TIMESTAMP(3), b'0'
  valueRaw(): string {
    const first = this.next();
    let last = first;
    if (first.t === 'op' && first.v === '(') {
      last = this.closeParen();
    } else {
      const n = this.peek();
      const adjacent = n !== undefined && n.s === first.e;
      if (adjacent && n.t === 'string') last = this.next();
      else if (adjacent && n.t === 'op' && n.v === '(') { this.i++; last = this.closeParen(); }
    }
    return this.src.slice(first.s, last.e);
  }

  error(message: string, at: Token | undefined = this.peek()): ParseError {
    return new ParseError(this.located(message, at));
  }

  private located(message: string, at: Token | undefined): string {
    return `${message} (줄 ${at ? lineOf(this.src, at.s) : '끝'})`;
  }
}

// 괄호 깊이 0의 쉼표로 토큰을 나눈다
export function splitTopLevel(toks: Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.t === 'op') {
      if (t.v === '(') depth++;
      else if (t.v === ')') depth--;
      else if (t.v === ',' && depth === 0) {
        out.push(cur);
        cur = [];
        continue;
      }
    }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}
