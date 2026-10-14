// 따옴표·주석 밖의 ASCII 가 아닌 공백 (리뷰 11회차 Claude F5, 8.0.46·8.4.11 실측). 렉서는 JS 의 \s 인 NBSP(U+00A0)·U+3000·U+FEFF … 를 토큰 사이에서는 공백으로 건너뛰고
// 단어 안에서는 단어의 글자로 읽는데, MySQL(utf8mb4)은 ASCII 밖 글자를 늘 이름의 글자로 읽는다: 'ADD <NBSP>nick INT' 의 컬럼 이름은 NBSP 로 시작하고, 문장 맨 앞이나
// '(' 앞에서는 1064 다. 웹·위키에서 복사한 스크립트에 흔하다. 문자열·백틱·주석 안의 것은 MySQL 도 그 글자로 읽어 받는다. 덤프 파서와 함께 쓰는 렉서는 그대로 두고
// 적용 쪽에서 문장을 거부한다
import type { Token } from '../lexer';
import type { ApplyStatement } from '../parse-dump';
import { fail, RE_EXPORT } from './types';
import type { Region } from './version-comment';

const UNICODE_SPACE = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

// s 의 덩어리에서 렉서가 공백으로 건너뛴 것(건너뛰는 실행 주석 skipped 안은 빼고 — MySQL 에는 주석이다)과 실행하는 글의 단어 토큰(toks) 안의 것을 거부한다.
// script: 문장을 나눈 원문
export function assertAsciiSpaces(script: string, s: ApplyStatement, skipped: readonly Region[], toks: readonly Token[]): void {
  const between = firstOutside(s.spaces, skipped);
  const char = between !== undefined ? script[between] : UNICODE_SPACE.exec(toks.find((t) => t.t === 'word' && UNICODE_SPACE.test(t.v))?.v ?? '')?.[0];
  if (char === undefined) return;
  const code = char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
  fail(`따옴표·주석 밖에 ASCII 가 아닌 공백(U+${code})이 있습니다 — MySQL 은 이 글자를 공백으로 보지 않고 이름의 글자로 읽어, 이름이 그 글자로 시작하거나 끝나는 `
    + `컬럼·테이블을 만들거나 문장을 거부합니다 (실행한 스크립트가 보통 공백이었다면 그 글로 바꿔 넣어 주세요) — ${RE_EXPORT}`);
}

// regions(건너뛰는 실행 주석) 밖의 첫 공백 자리 (없으면 undefined). 두 배열은 원문 자리 순서이고 regions 는 겹치지 않아 한 번에 훑는다 (리뷰 12회차 Claude F2 — 공백마다
// 주석을 모두 훑으면 NBSP 50만 개·건너뛰는 주석 5만 개인 1,000,000자 문장 하나가 28 초였다)
function firstOutside(spaces: readonly number[], regions: readonly Region[]): number | undefined {
  let k = 0;
  for (const at of spaces) {
    while (k < regions.length && regions[k].end <= at) k++;
    if (k === regions.length || at < regions[k].start) return at;
  }
  return undefined;
}
