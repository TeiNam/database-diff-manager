import { describe, expect, it } from 'vitest';
import { alignByKey } from '../src/lib/align';

const pairs = (rows: { base?: string; target?: string }[]) => rows.map((r) => [r.base ?? '-', r.target ?? '-']);

describe('alignByKey', () => {
  it('TARGET 순서를 따르고 BASE에만 있는 항목은 원래 위치에 끼운다', () => {
    expect(pairs(alignByKey(['a', 'b', 'c'], ['a', 'c', 'd'], (x) => x))).toEqual([['a', 'a'], ['b', '-'], ['c', 'c'], ['-', 'd']]);
  });

  it('rename 매핑(TARGET 이름 → BASE 이름)으로 짝을 맞춘다', () => {
    const renamed = new Map([['nickname', 'nick']]);
    expect(pairs(alignByKey(['id', 'nick'], ['id', 'nickname'], (x) => x, renamed))).toEqual([['id', 'id'], ['nick', 'nickname']]);
  });

  it('순서가 바뀐 항목도 한 번씩만 나온다', () => {
    expect(pairs(alignByKey(['a', 'b', 'c'], ['c', 'a'], (x) => x))).toEqual([['c', 'c'], ['a', 'a'], ['b', '-']]);
  });
});
