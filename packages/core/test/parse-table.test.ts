import { describe, expect, it } from 'vitest';
import { parseCreateTable } from '../src/parse-table';
import { fixture } from './helpers';

const table = parseCreateTable(fixture('parse-table.sql'));
const col = (name: string) => table.columns.find((c) => c.name === name)!;
const idx = (name: string) => table.indexes.find((i) => i.name === name)!;

describe('parseCreateTable: 컬럼', () => {
  it('이름과 순서를 유지한다', () => {
    expect(table.name).toBe('chat_history');
    expect(table.columns.map((c) => c.name)).toEqual(['id', 'conv', 'n', 'flag', 'kind', 'b', 'create_at', 'update_at']);
  });

  it('속성을 해석한다', () => {
    expect(col('id')).toMatchObject({ type: 'int unsigned', nullable: false, autoIncrement: true, comment: 'PK' });
    expect(col('conv')).toMatchObject({ type: 'char(18)', charset: 'utf8mb4', collation: 'utf8mb4_general_ci', comment: '대화, 세션' });
    expect(col('flag')).toMatchObject({ type: 'tinyint(1)', default: "'0'" });
    expect(col('kind').type).toBe("enum('a','b,c')");
    expect(col('b').generated).toEqual({ expr: '(`n` * 2)', stored: false });
    expect(col('update_at')).toMatchObject({ type: 'datetime(3)', default: 'CURRENT_TIMESTAMP(3)', onUpdate: 'CURRENT_TIMESTAMP(3)' });
  });

  it('정수 표시 폭은 제거한다 (tinyint(1) 제외)', () => {
    expect(col('n')).toMatchObject({ type: 'int', nullable: true, default: 'NULL' });
  });
});

describe('parseCreateTable: 인덱스·제약', () => {
  it('인덱스 종류와 순서', () => {
    expect(table.indexes.map((i) => [i.kind, i.name])).toEqual([
      ['PRIMARY', 'PRIMARY'],
      ['UNIQUE', 'uk_conv'],
      ['INDEX', 'ix_user'],
      ['INDEX', 'ix_fn'],
      ['FULLTEXT', 'ft'],
    ]);
  });

  it('키 파트: prefix, DESC, 함수형, 옵션', () => {
    expect(idx('PRIMARY').parts).toEqual([{ column: 'id', desc: false }, { column: 'create_at', desc: false }]);
    expect(idx('uk_conv').parts).toEqual([{ column: 'conv', length: 10, desc: false }]);
    expect(idx('ix_user')).toMatchObject({ parts: [{ column: 'n', desc: false }, { column: 'create_at', desc: true }], comment: 'idx' });
    expect(idx('ix_fn')).toMatchObject({ parts: [{ expr: 'lower(`conv`)', desc: false }], invisible: true });
    expect(idx('ft').parser).toBe('ngram');
  });

  it('FK와 CHECK', () => {
    expect(table.foreignKeys).toEqual([
      { name: 'fk_u', columns: ['n'], refSchema: 'other', refTable: 'users', refColumns: ['id'], onDelete: 'CASCADE' },
    ]);
    expect(table.checks).toEqual([{ name: 'chk_n', expr: '(`n` > 0)', enforced: false }]);
  });
});

describe('parseCreateTable: 옵션·파티션', () => {
  it('AUTO_INCREMENT를 뺀 옵션을 순서대로 보존한다', () => {
    expect(table.options).toEqual([
      { key: 'ENGINE', value: 'InnoDB' },
      { key: 'DEFAULT CHARSET', value: 'utf8mb4' },
      { key: 'COLLATE', value: 'utf8mb4_general_ci' },
      { key: 'COMMENT', value: "'AI 챗봇'" },
    ]);
  });

  it('파티션을 구조화한다', () => {
    expect(table.partition).toMatchObject({
      version: '50100',
      method: 'RANGE',
      expr: '((year(`create_at`) * 100) + month(`create_at`))',
      partitions: [
        { name: 'p202510', def: "VALUES LESS THAN (202511) COMMENT = '2025년 10월' ENGINE = InnoDB" },
        { name: 'pmax', def: 'VALUES LESS THAN MAXVALUE ENGINE = InnoDB' },
      ],
    });
    expect(table.partition!.clause.startsWith('PARTITION BY RANGE')).toBe(true);
    expect(table.partition!.clause.endsWith('ENGINE = InnoDB)')).toBe(true);
  });
});

describe('parseCreateTable: 오류', () => {
  it('알 수 없는 컬럼 속성은 줄 번호와 함께 실패한다', () => {
    expect(() => parseCreateTable('CREATE TABLE `x` (\n  `a` int NOT NULL FOO\n)')).toThrow("알 수 없는 컬럼 속성 'FOO' (줄 2)");
  });
});
