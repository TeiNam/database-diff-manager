import { describe, expect, it } from 'vitest';
import { buildRows, countChanges, hunkHeader, toBlocks, toUnified } from '../src/lib/hunks';

const text = (rows: ReturnType<typeof buildRows>, side: 'left' | 'right') =>
  rows.map((r) => r[side]?.segments.map((s) => s.text).join('') ?? null);

describe('buildRows', () => {
  it('같은 줄·바뀐 줄·추가 줄을 짝지어 Split 행으로 만든다', () => {
    const rows = buildRows('a\nstatus varchar(20)\nc\n', 'a\nstatus varchar(32)\nc\nd\n');
    expect(rows.map((r) => r.kind)).toEqual(['same', 'change', 'same', 'add']);
    expect(text(rows, 'left')).toEqual(['a', 'status varchar(20)', 'c', null]);
    expect(text(rows, 'right')).toEqual(['a', 'status varchar(32)', 'c', 'd']);
    expect(rows[1].left!.segments.filter((s) => s.changed).map((s) => s.text)).toEqual(['varchar(20)']);
    expect(rows[1].right!.segments.filter((s) => s.changed).map((s) => s.text)).toEqual(['varchar(32)']);
    expect(rows.map((r) => [r.left?.no, r.right?.no])).toEqual([[1, 1], [2, 2], [3, 3], [undefined, 4]]);
  });

  it('삭제 줄이 추가 줄보다 많으면 남는 줄은 del', () => {
    const rows = buildRows('x\ny\nz', 'x\nY');
    expect(rows.map((r) => r.kind)).toEqual(['same', 'change', 'del']);
  });

  it('빈 쪽은 전부 add 또는 del', () => {
    expect(buildRows('', 'a\nb').map((r) => r.kind)).toEqual(['add', 'add']);
    expect(buildRows('a\nb', '').map((r) => r.kind)).toEqual(['del', 'del']);
  });
});

describe('toBlocks', () => {
  it('변경 주변 context 줄만 남기고 나머지는 접는다', () => {
    const a = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n');
    const b = a.replace('l6', 'L6');
    const blocks = toBlocks(buildRows(a, b), 2);
    expect(blocks.map((x) => [x.type, x.rows.length])).toEqual([['fold', 4], ['hunk', 5], ['fold', 3]]);
    expect(hunkHeader(blocks[1].rows)).toBe('@@ -5,5 +5,5 @@');
  });

  it('변경이 없으면 전부 fold', () => {
    expect(toBlocks(buildRows('a\nb', 'a\nb')).map((x) => x.type)).toEqual(['fold']);
  });
});

describe('countChanges·toUnified', () => {
  it('추가·삭제 줄 수와 GitHub식 Unified 순서(삭제 묶음 다음 추가 묶음)', () => {
    const rows = buildRows('a\nb\nc', 'a\nB\nC\nd');
    expect(countChanges(rows)).toEqual({ added: 3, removed: 2 });
    expect(toUnified(rows).map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['same', 1, 1], ['del', 2, undefined], ['del', 3, undefined], ['add', undefined, 2], ['add', undefined, 3], ['add', undefined, 4],
    ]);
  });
});
