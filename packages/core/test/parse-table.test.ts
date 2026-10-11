import { describe, expect, it } from 'vitest';
import { parseSqlDump } from '../src/parse-dump';
import { parseCreateTable } from '../src/parse-table';
import { printTable } from '../src/print';
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

describe('MySQL 8.4 SHOW CREATE 속성 (9회차 6·7·8·9)', () => {
  const dump = parseSqlDump(fixture('show-create-84.sql'));
  const t = dump.model.tables[0];
  const c = (name: string) => t.columns.find((x) => x.name === name)!;

  it('파싱·왕복 경고 없이 읽는다', () => {
    expect(dump.warnings).toEqual([]);
  });

  it('16진수·비트 기본값', () => {
    expect([c('bin2').default, c('flags').default, c('mask').default]).toEqual(['0x00FF', "b'101'", "b'1010'"]);
  });

  it('COLUMN_FORMAT·STORAGE 컬럼 속성', () => {
    expect(c('fixed_col')).toMatchObject({ storage: 'DISK', columnFormat: 'FIXED', default: "'1'" });
    expect(c('mem_col')).toMatchObject({ storage: 'MEMORY' });
    expect(c('dyn_col')).toMatchObject({ columnFormat: 'DYNAMIC' });
  });

  it('INVISIBLE 은 DEFAULT·ON UPDATE 뒤, COMMENT 앞', () => {
    expect(c('touched')).toMatchObject({ invisible: true, onUpdate: 'CURRENT_TIMESTAMP', comment: 't' });
  });

  it('인덱스 KEY_BLOCK_SIZE', () => {
    expect(t.indexes.find((i) => i.name === 'ix_vb')).toMatchObject({ keyBlockSize: 4, comment: 'k' });
  });

  it('td-export escapes.sql 의 INVISIBLE 컬럼도 왕복 경고가 없다', () => {
    for (const v of ['0136', '0152']) expect(parseSqlDump(fixture(`td-export-${v}/escapes.sql`)).warnings).toEqual([]);
  });
});

describe('binary 기본값의 따옴표 형식 (10회차 5)', () => {
  // 8.4 SHOW CREATE 는 UTF-8 로 유효한 바이트면 0x… 대신 따옴표 문자열을 낸다 (제어 바이트는 그대로, NUL·개행·\·' 는 이스케이프)
  const RAW = '\u0001\u0002';
  const ddl = [
    'CREATE TABLE `lit` (',
    '  `id` int NOT NULL,',
    `  \`b1\` binary(2) DEFAULT '${RAW}',`,
    "  `b2` binary(2) DEFAULT 'A\\0',",
    "  `b4` varbinary(4) DEFAULT 'A''\\n\\\\',",
    '  `b3` binary(2) DEFAULT 0x00FF,',
    '  PRIMARY KEY (`id`)',
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
  ].join('\n');

  it('파싱 → 출력이 원문과 같고 경고가 없다', () => {
    const t = parseCreateTable(ddl);
    expect(t.parseError).toBeUndefined();
    expect(t.columns.map((c) => c.default)).toEqual([undefined, `'${RAW}'`, "'A\\0'", "'A''\\n\\\\'", '0x00FF']);
    expect(printTable(t)).toBe(ddl);
    expect(parseSqlDump(`${ddl};`).warnings).toEqual([]);
  });
});
