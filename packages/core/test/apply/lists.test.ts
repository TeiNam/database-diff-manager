import { describe, expect, it } from 'vitest';
import { splitList } from '../../src/apply/lists';
import { ApplyFailure } from '../../src/apply/types';
import { tokenize } from '../../src/lexer';

const items = (src: string) => splitList(tokenize(src), '테스트').map((toks) => toks.map((t) => t.v).join(' '));

describe('splitList', () => {
  it('깊이 0 쉼표로 나눈다', () => {
    expect(items('a INT, b VARCHAR(10, 2), c')).toEqual(['a INT', 'b VARCHAR ( 10 , 2 )', 'c']);
  });

  it.each([[''], ['a,'], ['a,,b'], [',a']])('%j 는 1064', (src) => {
    expect(() => items(src)).toThrow(ApplyFailure);
    expect(() => items(src)).toThrow(/1064/);
  });
});
