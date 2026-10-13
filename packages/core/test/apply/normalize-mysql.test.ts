import { describe, expect, it } from 'vitest';
import { columnCharset, finalizeColumn, normalizeDefault, normalizeUserType, routineReturns, tableCharset } from '../../src/apply/normalize-mysql';
import { ApplyFailure, type ColumnSpec, type DefaultSpec } from '../../src/apply/types';

const spec = (over: Partial<ColumnSpec>): ColumnSpec => ({ name: 'c', type: 'int', autoIncrement: false, invisible: false, primaryKey: false, unique: false, ...over });
const T = { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' };
const col = (type: string, nullable = true) => ({ name: 'c', type, nullable });

describe('normalizeUserType', () => {
  it.each([
    ['INT(11)', 'int'], ['INTEGER UNSIGNED', 'int unsigned'], ['tinyint(1)', 'tinyint(1)'], ['BOOLEAN', 'tinyint(1)'],
    ['DECIMAL', 'decimal(10,0)'], ['NUMERIC(8)', 'decimal(8,0)'], ['DEC(12, 4)', 'decimal(12,4)'], ['CHAR', 'char(1)'],
    ['VARCHAR (20)', 'varchar(20)'], ['DOUBLE PRECISION', 'double'], ['REAL', 'double'], ['FLOAT(30)', 'double'], ['FLOAT(7,4)', 'float(7,4)'],
    ['DATETIME(0)', 'datetime'], ['TIMESTAMP(3)', 'timestamp(3)'], ['YEAR(4)', 'year'], ['BIT', 'bit(1)'], ['BIGINT SIGNED', 'bigint'],
    ["ENUM('a' , \"b\", 'c  ')", "enum('a','b','c')"], ["SET('x','it''s')", "set('x','it''s')"], ['JSON', 'json'], ['LONGTEXT', 'longtext'],
  ])('%s → %s', (src, out) => expect(normalizeUserType(src)).toBe(out));

  it.each([['VARCHAR'], ['SERIAL'], ['INT ZEROFILL'], ['TEXT(100)'], ['NCHAR(2)'], ['FOO'], ["ENUM('a','A')"], ['VARCHAR(10) UNSIGNED'], ['YEAR(2)'], ['CHAR(1,2)']])('%s 는 거부', (src) => {
    expect(() => normalizeUserType(src)).toThrow(ApplyFailure);
  });
});

describe('normalizeDefault', () => {
  it.each([
    [{ kind: 'number', value: '0' }, 'int', "'0'"],
    [{ kind: 'number', value: '-1' }, 'int', "'-1'"],
    [{ kind: 'number', value: '0' }, 'decimal(12,4)', "'0.0000'"],
    [{ kind: 'number', value: '1.5' }, 'double', "'1.5'"],
    [{ kind: 'string', value: '5' }, 'int', "'5'"],
    [{ kind: 'number', value: '5' }, 'varchar(10)', "'5'"],
    [{ kind: 'string', value: "it's" }, 'varchar(10)', "'it''s'"],
    [{ kind: 'now' }, 'datetime', 'CURRENT_TIMESTAMP'],
    [{ kind: 'now', fsp: 3 }, 'timestamp(3)', 'CURRENT_TIMESTAMP(3)'],
    [{ kind: 'string', value: 'B' }, "enum('a','b')", "'b'"],
    [{ kind: 'string', value: 'y,x' }, "set('x','y')", "'x,y'"],
    [{ kind: 'number', value: '1' }, 'bit(1)', "b'1'"],
    [{ kind: 'null' }, 'int', 'NULL'],
  ] as const)('%j on %s → %s', (s, type, out) => expect(normalizeDefault(s as DefaultSpec, col(type))).toBe(out));

  it.each([
    [{ kind: 'null' }, col('int', false)], [{ kind: 'string', value: 'x' }, col('text')], [{ kind: 'now' }, col('date')],
    [{ kind: 'now' }, col('datetime(3)')], [{ kind: 'number', value: '1.5' }, col('int')], [{ kind: 'string', value: 'z' }, col("enum('a')")],
    [{ kind: 'number', value: '-1' }, col('int unsigned')], [{ kind: 'string', value: 'abc' }, col('int')],
  ] as const)('%j 는 거부', (s, c) => expect(() => normalizeDefault(s as DefaultSpec, c)).toThrow(ApplyFailure));
});

describe('문자셋 (SHOW CREATE 표기)', () => {
  it('테이블 기본값을 물려받으면 문자셋 기본 콜레이션이 아닐 때만 COLLATE', () => {
    expect(columnCharset('varchar(10)', {}, T)).toEqual({ collation: 'utf8mb4_general_ci' });
    expect(columnCharset('varchar(10)', {}, { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' })).toEqual({});
  });

  it('다른 콜레이션이면 CHARACTER SET, COLLATE 를 직접 쓰면 둘 다', () => {
    expect(columnCharset('varchar(10)', { charset: 'latin1' }, T)).toEqual({ charset: 'latin1' });
    expect(columnCharset('varchar(10)', { charset: 'utf8mb4' }, T)).toEqual({ charset: 'utf8mb4' }); // utf8mb4_0900_ai_ci ≠ 테이블 general_ci
    expect(columnCharset('varchar(10)', { collation: 'utf8mb4_bin' }, T)).toEqual({ charset: 'utf8mb4', collation: 'utf8mb4_bin' });
    expect(columnCharset('text', { charset: 'utf8' }, T)).toEqual({ charset: 'utf8mb3' });
  });

  it('문자열이 아닌 타입·맞지 않는 콜레이션·모르는 문자셋은 거부', () => {
    expect(() => columnCharset('int', { charset: 'utf8mb4' }, T)).toThrow(ApplyFailure);
    expect(() => columnCharset('varchar(1)', { charset: 'latin1', collation: 'utf8mb4_bin' }, T)).toThrow(/1253/);
    expect(() => columnCharset('varchar(1)', { charset: 'klingon' }, T)).toThrow(/1115/);
  });

  it('tableCharset: 옵션의 문자셋·콜레이션, 없으면 기본값', () => {
    expect(tableCharset([{ key: 'DEFAULT CHARSET', value: 'latin1' }], T)).toEqual({ charset: 'latin1', collation: 'latin1_swedish_ci' });
    expect(tableCharset([{ key: 'DEFAULT CHARSET', value: 'utf8mb4' }, { key: 'COLLATE', value: 'utf8mb4_bin' }], T)).toEqual({ charset: 'utf8mb4', collation: 'utf8mb4_bin' });
    expect(tableCharset([], T)).toEqual(T);
  });

  it('routineReturns: 문자열 반환 타입에는 CHARSET <스키마 기본> 을 붙인다', () => {
    expect(routineReturns('INT', 'utf8mb4')).toBe('int');
    expect(routineReturns('VARCHAR(20)', 'utf8mb4')).toBe('varchar(20) CHARSET utf8mb4');
    expect(() => routineReturns('VARCHAR(20) CHARSET latin1', 'utf8mb4')).toThrow(ApplyFailure);
  });
});

describe('finalizeColumn', () => {
  it('NULL 허용 컬럼은 DEFAULT NULL (TEXT·JSON 제외), NOT NULL 은 기본값 없음', () => {
    expect(finalizeColumn(spec({ type: 'int' }), T)).toEqual({ name: 'c', type: 'int', nullable: true, invisible: false, autoIncrement: false, default: 'NULL' });
    expect(finalizeColumn(spec({ type: 'text' }), T)).toEqual({ name: 'c', type: 'text', collation: 'utf8mb4_general_ci', nullable: true, invisible: false, autoIncrement: false });
    expect(finalizeColumn(spec({ type: 'int', nullable: false }), T).default).toBeUndefined();
  });

  it('컬럼 안 PRIMARY KEY 는 NOT NULL, AUTO_INCREMENT 는 DEFAULT 없음', () => {
    const c = finalizeColumn(spec({ type: 'int unsigned', primaryKey: true, autoIncrement: true }), T);
    expect(c).toMatchObject({ nullable: false, autoIncrement: true });
    expect(c.default).toBeUndefined();
  });

  it('ON UPDATE·COMMENT, 빈 COMMENT 는 없앤다', () => {
    const c = finalizeColumn(spec({ type: 'datetime', nullable: false, default: { kind: 'now' }, onUpdate: {}, comment: '' }), T);
    expect(c).toMatchObject({ default: 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' });
    expect(c.comment).toBeUndefined();
  });

  it('PRIMARY KEY NULL·문자열 AUTO_INCREMENT·AUTO_INCREMENT 기본값은 거부', () => {
    expect(() => finalizeColumn(spec({ primaryKey: true, nullable: true }), T)).toThrow(/1171/);
    expect(() => finalizeColumn(spec({ type: 'varchar(1)', autoIncrement: true }), T)).toThrow(/1063/);
    expect(() => finalizeColumn(spec({ autoIncrement: true, default: { kind: 'number', value: '1' } }), T)).toThrow(/1067/);
  });
});
