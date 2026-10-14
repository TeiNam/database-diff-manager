import { describe, expect, it } from 'vitest';
import { containsWithin, DelimiterSearch } from '../src/delimiter-search';

// 결정적 난수 — 테스트가 늘 같은 입력을 본다
function random(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return Math.floor((state / 2147483648) * n);
  };
}

const ALPHABET = 'ab;';
const word = (pick: (n: number) => number, max: number): string => Array.from({ length: 1 + pick(max) }, () => ALPHABET[pick(ALPHABET.length)]).join('');

// 리뷰 15회차 R15-2: 문장 나누기가 토큰마다 원문을 바로 견주던 것(startsWith·indexOf)과 같은 자리를 원문을 한 번만 훑어 찾는다 — 덤프 업로드와 ALTER 적용의 문장이 그대로다
describe('DelimiterSearch', () => {
  it('앞으로만 가는 토큰 자리마다 원문을 바로 견준 것과 같은 자리를 찾는다 (구분자가 겹쳐 나와도)', () => {
    const pick = random(15);
    for (let round = 0; round < 2000; round++) {
      const text = word(pick, 60);
      const delimiter = word(pick, 4);
      const find = new DelimiterSearch(text, delimiter, 0);
      for (let s = pick(3); s < text.length; ) {
        const e = Math.min(text.length, s + 1 + pick(6));
        const op = pick(2) === 0; // 연산자 토큰은 그 자리에서 시작하는 것만, 단어 토큰은 안에 든 것도 본다
        const reach = s + delimiter.length;
        const inside = text.slice(s, e).indexOf(delimiter);
        const expected = text.startsWith(delimiter, s) ? s : op || inside < 0 ? -1 : s + inside;
        expect(find.within(s, op ? reach : Math.max(e, reach)), JSON.stringify({ text, delimiter, s, e, op })).toBe(expected);
        s = e + pick(3);
      }
    }
  });

  it('훑기 시작한 자리 앞에서 시작하는 구분자는 찾지 않는다 (DELIMITER 줄 뒤에서 새로 찾는다)', () => {
    const find = new DelimiterSearch(';; x ;;', ';;', 1);
    expect(find.within(1, 3)).toBe(-1);
    expect(find.within(5, 7)).toBe(5);
  });

  it('containsWithin 은 구간 안에 든 것만 본다', () => {
    const pick = random(77);
    for (let round = 0; round < 2000; round++) {
      const text = word(pick, 40);
      const pattern = word(pick, 3);
      const from = pick(text.length + 1);
      const to = from + pick(text.length - from + 1);
      expect(containsWithin(text, pattern, from, to), JSON.stringify({ text, pattern, from, to })).toBe(text.slice(from, to).includes(pattern));
    }
  });
});
