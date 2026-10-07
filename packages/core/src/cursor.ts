// 토큰 배열 위를 움직이는 파서 도우미
import type { Token } from './lexer';

export class ParseError extends Error {}

export function lineOf(src: string, pos: number): number {
  return src.slice(0, pos).split('\n').length;
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

  ident(): string {
    const t = this.next();
    if (t.t !== 'ident' && t.t !== 'word') throw this.error('식별자 필요', t);
    return t.v;
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
    return new ParseError(`${message} (줄 ${at ? lineOf(this.src, at.s) : '끝'})`);
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
