import { diffSchemas, parseSqlDump } from '@tdm/core';
import { describe, expect, it } from 'vitest';
import { changedObjects, objectAnchor, objectEntry, opOf } from '../src/lib/object-diff';

const base = parseSqlDump('CREATE TABLE `a` (\n  `x` int\n);\nCREATE TABLE `gone` (\n  `y` int\n);').model;
const target = parseSqlDump('CREATE TABLE `a` (\n  `x` bigint\n);\nCREATE TABLE `fresh` (\n  `z` int\n);').model;
const diff = diffSchemas(base, target);

describe('changedObjects', () => {
  it('변경 객체마다 양쪽 SQL 텍스트를 만든다 (추가는 BASE 빈 문자열, 삭제는 TARGET 빈 문자열)', () => {
    const entries = changedObjects(diff);
    expect(entries.map((e) => [e.op, e.name])).toEqual([['modify', 'a'], ['drop', 'gone'], ['add', 'fresh']]);
    expect(entries[0].baseText).toContain('`x` int');
    expect(entries[0].targetText).toContain('`x` bigint');
    expect(entries[1].targetText).toBe('');
    expect(entries[2].baseText).toBe('');
  });

  it('opOf·objectEntry(변경 없는 객체는 same)·objectAnchor', () => {
    expect(opOf(diff, 'table', 'fresh')).toBe('add');
    expect(opOf(diff, 'table', 'nope')).toBeUndefined();
    const same = objectEntry('table', 'a', target, target, diffSchemas(target, target));
    expect(same).toMatchObject({ op: 'same', name: 'a' });
    expect(same!.baseText).toBe(same!.targetText);
    expect(objectAnchor('table', 'a b')).toBe('obj-table-a%20b');
  });
});
