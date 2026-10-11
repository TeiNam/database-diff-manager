import { describe, expect, it } from 'vitest';
import { listPartitionBodies, listPartitionStatements, partitionStatements } from '../src/partition-ddl';
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

  it('RANGE 마지막 상한이 줄면(MAXVALUE → 유한, 30 → 15) REORGANIZE 대신 수동 확인 문장 (error 1520)', () => {
    for (const [a, b] of [[[P('p1'), P('p2'), MAX], [P('p1'), P('p2'), P('p3', '30')]], [[P('p1'), P('p3', '30')], [P('p1'), P('p4', '15')]]]) {
      const bodies = listPartitionBodies('`t`', a, b);
      expect(bodies).toHaveLength(1);
      expect(bodies[0].sql.split('\n').every((l) => l.startsWith('--'))).toBe(true);
      expect(bodies[0].sql).toMatch(/^-- \[수동 확인 필요\] `t`: RANGE 마지막 파티션 상한이 줄어/);
      expect(bodies[0].sql).toContain('-- ALTER TABLE `t` REORGANIZE PARTITION');
    }
  });

  it('RANGE 마지막 상한이 늘면 그대로 REORGANIZE', () => {
    expect(listPartitionStatements('`t`', [P('p1'), P('p2', '20')], [P('p1'), P('p3', '30')])).toEqual([
      'ALTER TABLE `t` REORGANIZE PARTITION `p2` INTO (\n PARTITION `p3` VALUES LESS THAN (30))',
    ]);
  });

  it('앞쪽 병합은 DROP이 아니라 REORGANIZE', () => {
    expect(listPartitionStatements('`t`', [P('p1'), P('p2'), P('p3')], [P('p12', '2'), P('p3')])).toEqual([
      'ALTER TABLE `t` REORGANIZE PARTITION `p1`, `p2` INTO (\n PARTITION `p12` VALUES LESS THAN (2))',
    ]);
  });

  it('RANGE 중간 삭제는 다음 파티션과 합쳐(REORGANIZE) 데이터를 보존한다', () => {
    expect(listPartitionStatements('`t`', [P('p1'), P('p2'), P('p3'), P('p4')], [P('p1'), P('p4')])).toEqual([
      'ALTER TABLE `t` REORGANIZE PARTITION `p2`, `p3`, `p4` INTO (\n PARTITION `p4` VALUES LESS THAN (4))',
    ]);
  });

  it('앞쪽 보관기간 정리·뒤쪽·LIST 삭제는 모두 데이터 확인 안내를 붙인 DROP', () => {
    const [lead] = listPartitionBodies('`t`', [P('p1'), P('p2'), P('p3')], [P('p2'), P('p3')]);
    expect(lead.sql).toBe('ALTER TABLE `t` DROP PARTITION `p1`');
    expect(lead.notes?.[0]).toMatch(/^\[데이터 확인\] p1: 보관 기간/);
    const [tail] = listPartitionBodies('`t`', [P('p1'), P('p2'), P('p3')], [P('p1'), P('p2')]);
    expect(tail.sql).toBe('ALTER TABLE `t` DROP PARTITION `p3`');
    expect(tail.notes?.[0]).toMatch(/^\[데이터 확인\] p3/);
    const L = (name: string) => ({ name, def: `VALUES IN (${name.slice(1)})` });
    const [list] = listPartitionBodies('`t`', [L('p1'), L('p2'), L('p3')], [L('p1'), L('p3')], false);
    expect(list.sql).toBe('ALTER TABLE `t` DROP PARTITION `p2`');
    expect(list.notes?.[0]).toMatch(/^\[데이터 확인\] p2/);
  });

  const L = (name: string, values = name.slice(1)) => ({ name, def: `VALUES IN (${values}) ENGINE = InnoDB` });

  it('LIST 병합: 값이 TARGET 에 남으면 DROP 하지 않고 함께 REORGANIZE 한다', () => {
    expect(listPartitionBodies('`t`', [L('p1'), L('p2'), L('p3')], [L('p2', '1,2'), L('p3')], false)).toEqual([
      { sql: 'ALTER TABLE `t` REORGANIZE PARTITION `p1`, `p2` INTO (\n PARTITION `p2` VALUES IN (1,2) ENGINE = InnoDB)' },
    ]);
  });

  it('LIST 첫 파티션 삭제: 값이 TARGET 어디에도 없으면 데이터 확인 안내를 붙인 DROP', () => {
    const [st, ...rest] = listPartitionBodies('`t`', [L('p1'), L('p2'), L('p3')], [L('p2'), L('p3')], false);
    expect(rest).toEqual([]);
    expect(st.sql).toBe('ALTER TABLE `t` DROP PARTITION `p1`');
    expect(st.notes?.[0]).toMatch(/^\[데이터 확인\] p1/);
  });

  it('LIST COLUMNS 튜플 값도 공백 차이 없이 비교한다', () => {
    const [st] = listPartitionBodies('`t`', [L('p1', "('x',1)"), L('p2', "('y',2)")], [L('p2', "('x', 1),('y',2)")], false);
    expect(st.sql).toContain('REORGANIZE PARTITION `p1`, `p2`');
    expect(st.notes).toBeUndefined();
  });

  it('LIST REORGANIZE 에서 사라지는 값은 그 행이 삭제된다고 안내한다', () => {
    const [st] = listPartitionBodies('`t`', [L('p1', '1,5'), L('p2')], [L('p2', '1,2')], false);
    expect(st.sql).toBe('ALTER TABLE `t` REORGANIZE PARTITION `p1`, `p2` INTO (\n PARTITION `p2` VALUES IN (1,2) ENGINE = InnoDB)');
    expect(st.notes).toEqual(['[데이터 확인] 값 5: TARGET 파티션에 없어 REORGANIZE 하면 그 값의 행이 삭제됩니다']);
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

  const named = (...ps: string[]): Partitioning => ({
    version: '50100', method: 'HASH', expr: '`id`', partitions: ps.map((name) => ({ name, def: 'ENGINE = InnoDB' })),
    clause: `PARTITION BY HASH (\`id\`)\n(${ps.map((n) => `PARTITION ${n} ENGINE = InnoDB`).join(',\n ')})`,
  });

  it('이름 있는 HASH 파티션: 뒤쪽 감소는 COALESCE, 뒤쪽 증가는 ADD PARTITION, 그 외는 전체 재정의', () => {
    expect(partitionStatements(diff(named('a', 'b', 'c'), named('a')))).toEqual(['ALTER TABLE `t` COALESCE PARTITION 2']);
    expect(partitionStatements(diff(named('a'), named('a', 'b')))).toEqual(['ALTER TABLE `t` ADD PARTITION (\n PARTITION `b` ENGINE = InnoDB)']);
    expect(partitionStatements(diff(named('a', 'b'), named('x', 'b')))).toEqual(['ALTER TABLE `t` PARTITION BY HASH (`id`)\n(PARTITION x ENGINE = InnoDB,\n PARTITION b ENGINE = InnoDB)']);
    expect(partitionStatements(diff(hash(2), named('a', 'b')))).toEqual(['ALTER TABLE `t` PARTITION BY HASH (`id`)\n(PARTITION a ENGINE = InnoDB,\n PARTITION b ENGINE = InnoDB)']);
  });

  it('방식이 바뀌면 전체 재정의, 없어지면 REMOVE PARTITIONING', () => {
    const key: Partitioning = { ...hash(4), method: 'KEY', clause: 'PARTITION BY KEY (`id`)\nPARTITIONS 4' };
    expect(partitionStatements(diff(hash(4), key))).toEqual(['ALTER TABLE `t` PARTITION BY KEY (`id`)\nPARTITIONS 4']);
    expect(partitionStatements(diff(hash(4), undefined))).toEqual(['ALTER TABLE `t` REMOVE PARTITIONING']);
  });
});
