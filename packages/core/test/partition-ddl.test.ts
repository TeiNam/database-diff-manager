import { describe, expect, it } from 'vitest';
import { listPartitionStatements, partitionStatements } from '../src/partition-ddl';
import type { TableDiff } from '../src/diff';
import type { Partitioning } from '../src/model';

const P = (name: string, bound = name.slice(1)) => ({ name, def: `VALUES LESS THAN (${bound})` });
const MAX = { name: 'pmax', def: 'VALUES LESS THAN MAXVALUE' };

describe('listPartitionStatements', () => {
  it('끝에 추가만 되면 ADD PARTITION', () => {
    expect(listPartitionStatements('`t`', [P('p1'), P('p2')], [P('p1'), P('p2'), P('p3')])).toEqual([
      'ALTER TABLE `t` ADD PARTITION (\n PARTITION `p3` VALUES LESS THAN (3))',
    ]);
  });

  it('앞쪽 삭제 + MAXVALUE 앞 추가 = DROP + REORGANIZE pmax', () => {
    expect(listPartitionStatements('`t`', [P('p1'), P('p2'), MAX], [P('p2'), P('p3'), MAX])).toEqual([
      'ALTER TABLE `t` DROP PARTITION `p1`',
      'ALTER TABLE `t` REORGANIZE PARTITION `pmax` INTO (\n PARTITION `p3` VALUES LESS THAN (3),\n PARTITION `pmax` VALUES LESS THAN MAXVALUE)',
    ]);
  });

  it('앞쪽 병합은 DROP이 아니라 REORGANIZE', () => {
    expect(listPartitionStatements('`t`', [P('p1'), P('p2'), P('p3')], [P('p12', '2'), P('p3')])).toEqual([
      'ALTER TABLE `t` REORGANIZE PARTITION `p1`, `p2` INTO (\n PARTITION `p12` VALUES LESS THAN (2))',
    ]);
  });

  it('중간 삭제는 DROP PARTITION', () => {
    expect(listPartitionStatements('`t`', [P('p1'), P('p2'), P('p3')], [P('p1'), P('p3')])).toEqual([
      'ALTER TABLE `t` DROP PARTITION `p2`',
    ]);
  });

  it('중간 RANGE 파티션의 경계가 바뀌면 뒤쪽 파티션까지 묶어 REORGANIZE', () => {
    expect(listPartitionStatements('`t`', [P('p1', '10'), P('p2', '20'), P('p3', '30')], [P('p1', '10'), P('p2', '25'), P('p3', '30')])).toEqual([
      'ALTER TABLE `t` REORGANIZE PARTITION `p2`, `p3` INTO (\n PARTITION `p2` VALUES LESS THAN (25),\n PARTITION `p3` VALUES LESS THAN (30))',
    ]);
  });

  it('COMMENT만 바뀌면 안내 주석만', () => {
    const a = [{ name: 'p1', def: "VALUES LESS THAN (1) COMMENT = 'a'" }];
    const b = [{ name: 'p1', def: "VALUES LESS THAN (1) COMMENT = 'b'" }];
    expect(listPartitionStatements('`t`', a, b)).toEqual([
      '-- 파티션 COMMENT 변경(p1): MySQL은 COMMENT만 바꾸는 DDL이 없습니다. 필요하면 REORGANIZE PARTITION으로 재정의하세요',
    ]);
  });
});

describe('partitionStatements', () => {
  const hash = (count: number): Partitioning => ({ version: '50100', clause: `PARTITION BY HASH (\`id\`)\nPARTITIONS ${count}`, method: 'HASH', expr: '`id`', count, partitions: [] });
  const diff = (from?: Partitioning, to?: Partitioning) => ({ name: 't', partition: { from, to } }) as TableDiff;

  it('HASH 개수 증감', () => {
    expect(partitionStatements(diff(hash(4), hash(6)))).toEqual(['ALTER TABLE `t` ADD PARTITION PARTITIONS 2']);
    expect(partitionStatements(diff(hash(6), hash(4)))).toEqual(['ALTER TABLE `t` COALESCE PARTITION 2']);
  });

  it('방식이 바뀌면 전체 재정의, 없어지면 REMOVE PARTITIONING', () => {
    const key: Partitioning = { ...hash(4), method: 'KEY', clause: 'PARTITION BY KEY (`id`)\nPARTITIONS 4' };
    expect(partitionStatements(diff(hash(4), key))).toEqual(['ALTER TABLE `t` PARTITION BY KEY (`id`)\nPARTITIONS 4']);
    expect(partitionStatements(diff(hash(4), undefined))).toEqual(['ALTER TABLE `t` REMOVE PARTITIONING']);
  });
});
