import { describe, expect, it } from 'vitest';
import { canonicalCharset, canonicalCollation, columnCharset, finalizeColumn, normalizeDefault, normalizeUserType, routineReturns, tableCharset } from '../../src/apply/normalize-mysql';
import { ApplyFailure, RE_EXPORT, type ColumnSpec, type DefaultSpec } from '../../src/apply/types';
import { parseCreateTable } from '../../src/parse-table';

const spec = (over: Partial<ColumnSpec>): ColumnSpec => ({ name: 'c', type: 'int', autoIncrement: false, invisible: false, primaryKey: false, unique: false, ...over });
const T = { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' };
const col = (type: string, nullable = true) => ({ name: 'c', type, nullable });
// Object.prototype 에 있는 이름: 사전(객체) 조회가 이 이름을 '있는 키'로 착각하면 안 된다
const PROTOTYPE_KEYS = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];
const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('예외가 나지 않았습니다');
};

describe('normalizeUserType', () => {
  it.each([
    ['INT(11)', 'int'], ['INTEGER UNSIGNED', 'int unsigned'], ['tinyint(1)', 'tinyint(1)'], ['BOOLEAN', 'tinyint(1)'],
    ['DECIMAL', 'decimal(10,0)'], ['NUMERIC(8)', 'decimal(8,0)'], ['DEC(12, 4)', 'decimal(12,4)'], ['CHAR', 'char(1)'],
    ['VARCHAR (20)', 'varchar(20)'], ['DOUBLE PRECISION', 'double'], ['REAL', 'double'], ['FLOAT(30)', 'double'], ['FLOAT(7,4)', 'float(7,4)'],
    ['DATETIME(0)', 'datetime'], ['TIMESTAMP(3)', 'timestamp(3)'], ['YEAR(4)', 'year'], ['BIT', 'bit(1)'], ['BIGINT SIGNED', 'bigint'],
    ["ENUM('a' , \"b\", 'c  ')", "enum('a','b','c')"], ["SET('x','it''s')", "set('x','it''s')"], ['JSON', 'json'], ['LONGTEXT', 'longtext'],
    ['CHARACTER VARYING(20)', 'varchar(20)'], ['char varying (10)', 'varchar(10)'], ['CHARACTER(3)', 'char(3)'],
  ])('%s → %s', (src, out) => expect(normalizeUserType(src)).toBe(out));

  it.each([['VARCHAR'], ['SERIAL'], ['INT ZEROFILL'], ['TEXT(100)'], ['NCHAR(2)'], ['FOO'], ["ENUM('a','A')"], ['VARCHAR(10) UNSIGNED'], ['YEAR(2)'], ['CHAR(1,2)']])('%s 는 거부', (src) => {
    expect(() => normalizeUserType(src)).toThrow(ApplyFailure);
  });

  it.each([['VARCHAR()'], ['INT()'], ['DATETIME()'], ['DECIMAL()'], ['CHAR VARYING()']])('%s: 빈 괄호는 거부', (src) => {
    expect(() => normalizeUserType(src)).toThrow(/타입 인자가 비었습니다.*\(MySQL 1064\)/);
  });

  // 쉼표 목록은 splitList 로 나눈다: splitTopLevel 은 끝 쉼표를 조용히 버려 `(10,)` 가 `(10)` 이 되었다 (MySQL 은 1064)
  it.each([
    ["ENUM('a','b',)"], ["SET('a',)"], ["ENUM(,'a')"], ["ENUM('a',,'b')"], ['ENUM()'], ['SET()'],
    ['DECIMAL(10,)'], ['DECIMAL(,2)'], ['DECIMAL(10,,2)'], ['VARCHAR(20,)'], ['FLOAT(7,)'], ['DATETIME(3,)'],
  ])('%s: 끝 쉼표·빈 항목·빈 목록은 1064', (src) => {
    expect(() => normalizeUserType(src)).toThrow(ApplyFailure);
    expect(() => normalizeUserType(src)).toThrow(/\(MySQL 1064\)/);
  });

  it.each([['CHARACTER VARYING'], ['CHAR VARYING'], ['CHAR VARYING(5) UNSIGNED']])('%s: VARCHAR 와 같게 길이가 없거나 UNSIGNED 면 거부', (src) => {
    expect(() => normalizeUserType(src)).toThrow(ApplyFailure);
  });

  it.each(PROTOTYPE_KEYS)('%s: Object.prototype 의 이름도 모르는 타입으로 거부', (src) => {
    expect(() => normalizeUserType(src)).toThrow(/지원하지 않는 타입입니다/);
  });
});

describe('1차 지원 범위 밖 안내', () => {
  it('RE_EXPORT 문구', () => {
    expect(RE_EXPORT).toBe('td-export 로 다시 뽑아 올려 주세요');
  });

  it.each([['NCHAR(2)'], ['NATIONAL VARCHAR(10)'], ['SERIAL'], ['INT ZEROFILL'], ['TEXT(100)'], ['LONG']])('%s: 메시지가 다시 뽑아 올리라는 안내로 끝난다', (src) => {
    const message = messageOf(() => normalizeUserType(src));
    expect(message).toContain('1차 지원 범위가 아닙니다');
    expect(message.endsWith(` — ${RE_EXPORT}`), message).toBe(true);
  });

  it('RETURNS 안의 CHARSET·COLLATE 도 같은 안내로 끝난다', () => {
    for (const raw of ['VARCHAR(20) CHARSET latin1', 'TEXT COLLATE utf8mb4_bin', 'CHAR(3) CHARACTER SET ascii']) {
      const message = messageOf(() => routineReturns(raw, 'utf8mb4'));
      expect(message.endsWith(` — ${RE_EXPORT}`), message).toBe(true);
    }
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
    [{ kind: 'null' }, 'json', 'NULL'],
    [{ kind: 'null' }, 'point', 'NULL'],
  ] as const)('%j on %s → %s', (s, type, out) => expect(normalizeDefault(s as DefaultSpec, col(type))).toBe(out));

  it.each([
    [{ kind: 'null' }, col('int', false)], [{ kind: 'string', value: 'x' }, col('text')], [{ kind: 'now' }, col('date')],
    [{ kind: 'now' }, col('datetime(3)')], [{ kind: 'number', value: '1.5' }, col('int')], [{ kind: 'string', value: 'z' }, col("enum('a')")],
    [{ kind: 'number', value: '-1' }, col('int unsigned')], [{ kind: 'string', value: 'abc' }, col('int')],
  ] as const)('%j 는 거부', (s, c) => expect(() => normalizeDefault(s as DefaultSpec, c)).toThrow(ApplyFailure));

  it('TEXT·BLOB 계열의 명시한 DEFAULT NULL 은 저장되는 기본값이 없다 (SHOW CREATE 에 보이지 않는다)', () => {
    for (const type of ['text', 'tinytext', 'mediumtext', 'longtext', 'blob', 'tinyblob', 'mediumblob', 'longblob']) {
      expect(normalizeDefault({ kind: 'null' }, col(type)), type).toBeUndefined();
    }
  });

  it('NOT NULL 인 TEXT 에 DEFAULT NULL 은 여전히 거부 (1067)', () => {
    expect(() => normalizeDefault({ kind: 'null' }, col('text', false))).toThrow(/1067/);
  });

  it.each([
    [{ kind: 'string', value: 'x' }, col('text')], [{ kind: 'string', value: 'x' }, col('blob')], [{ kind: 'string', value: 'x' }, col('json')],
    [{ kind: 'number', value: '1' }, col('point')], [{ kind: 'string', value: 'x' }, col('geometry')], [{ kind: 'now' }, col('json')],
  ] as const)('%j 는 리터럴 기본값이라 거부 (1101)', (s, c) => expect(() => normalizeDefault(s as DefaultSpec, c)).toThrow(/1101/));

  // 숫자 판정 정규식은 선형이어야 한다: 앞쪽 \d+ 와 \d* 가 같은 자리를 나눠 갖는 모양은 숫자 아닌 긴 문자열에서 O(n^2) (20만 자 ≈ 30 초)
  it('숫자 판정이 선형이다: 숫자가 아닌 긴 문자열 기본값도 바로 거부한다', () => {
    const started = performance.now();
    expect(() => normalizeDefault({ kind: 'string', value: `${'1'.repeat(200000)}x` }, col('int'))).toThrow(ApplyFailure);
    expect(() => normalizeDefault({ kind: 'string', value: `${'1'.repeat(100000)}.${'1'.repeat(100000)}x` }, col('double'))).toThrow(ApplyFailure);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it.each([['5', 'int', "'5'"], ['+5', 'int', "'5'"], ['-0', 'int unsigned', "'0'"], ['1.', 'double', "'1'"], ['.5', 'double', "'0.5'"], ['1e2', 'double', "'100'"], ['1.5E+1', 'double', "'15'"], [' 7 ', 'int', "'7'"]])(
    '숫자 모양 문자열 %j (%s) → %s', (value, type, out) => expect(normalizeDefault({ kind: 'string', value }, col(type))).toBe(out));

  it.each([[''], ['.'], ['+'], ['e5'], ['1e'], ['1e+'], ['1..2'], ['1.2.3'], ['0x10'], ['1 2']])('숫자가 아닌 문자열 %j 은 거부 (1067)', (value) => {
    expect(() => normalizeDefault({ kind: 'string', value }, col('double'))).toThrow(/\(MySQL 1067\)/);
  });

  it('DEFAULT CURRENT_TIMESTAMP 가 잘못되면 1067', () => {
    expect(() => normalizeDefault({ kind: 'now' }, col('date'))).toThrow(/1067/);
    expect(() => normalizeDefault({ kind: 'now' }, col('datetime(3)'))).toThrow(/1067/);
  });
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

  it.each(PROTOTYPE_KEYS)('%s: Object.prototype 의 이름은 모르는 문자셋·콜레이션으로 거부 (TypeError 가 아니다)', (name) => {
    expect(() => canonicalCharset(name)).toThrow(ApplyFailure);
    expect(() => canonicalCollation(name)).toThrow(ApplyFailure);
    expect(() => columnCharset('varchar(10)', { charset: name }, T)).toThrow(ApplyFailure);
    expect(() => columnCharset('varchar(10)', { collation: name }, T)).toThrow(ApplyFailure);
    expect(() => tableCharset([{ key: 'DEFAULT CHARSET', value: name }], T)).toThrow(ApplyFailure);
    expect(() => tableCharset([{ key: 'COLLATE', value: name }], T)).toThrow(ApplyFailure);
  });

  // 콜레이션 이름은 SHOW CREATE 에 따옴표 없이 찍힌다. 접두어(문자셋)만 보면 'utf8mb4_bin, DROP COLUMN b' 가 DDL 로 새어 나간다 (MySQL 8.0.46: 1273)
  it.each([['utf8mb4_bin, DROP COLUMN b'], ['utf8mb4_bin;'], ['utf8mb4_bin '], ['utf8mb4 bin'], ['utf8mb4_`bin`'], ["utf8mb4_bin'"]])('콜레이션 이름 전체가 \\w+ 가 아니면 거부 (1273): %s', (name) => {
    expect(() => canonicalCollation(name)).toThrow(/\(MySQL 1273\)/);
    expect(() => columnCharset('varchar(10)', { collation: name }, T)).toThrow(/\(MySQL 1273\)/);
    expect(() => tableCharset([{ key: 'COLLATE', value: name }], T)).toThrow(/\(MySQL 1273\)/);
  });

  it('canonicalCollation: 올바른 이름은 소문자로, utf8_ 는 utf8mb3_ 로', () => {
    expect(canonicalCollation('UTF8MB4_0900_AI_CI')).toBe('utf8mb4_0900_ai_ci');
    expect(canonicalCollation('utf8_general_ci')).toBe('utf8mb3_general_ci');
    expect(canonicalCollation('latin1_bin')).toBe('latin1_bin');
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
  it('NULL 허용 컬럼은 DEFAULT NULL (TEXT·BLOB 제외), NOT NULL 은 기본값 없음', () => {
    expect(finalizeColumn(spec({ type: 'int' }), T)).toEqual({ name: 'c', type: 'int', nullable: true, invisible: false, autoIncrement: false, default: 'NULL' });
    expect(finalizeColumn(spec({ type: 'text' }), T)).toEqual({ name: 'c', type: 'text', collation: 'utf8mb4_general_ci', nullable: true, invisible: false, autoIncrement: false });
    expect(finalizeColumn(spec({ type: 'int', nullable: false }), T).default).toBeUndefined();
  });

  it('기본값을 쓰지 않은 NULL 허용 컬럼: JSON·GEOMETRY 는 DEFAULT NULL 을 붙이고 TEXT·BLOB 은 붙이지 않는다', () => {
    expect(finalizeColumn(spec({ type: 'json' }), T).default).toBe('NULL');
    expect(finalizeColumn(spec({ type: 'point' }), T).default).toBe('NULL');
    expect(finalizeColumn(spec({ type: 'geometry' }), T).default).toBe('NULL');
    for (const type of ['text', 'longtext', 'blob', 'longblob']) expect(finalizeColumn(spec({ type }), T).default, type).toBeUndefined();
    expect(finalizeColumn(spec({ type: 'json', nullable: false }), T).default).toBeUndefined();
  });

  it('SHOW CREATE 를 읽은 모델과 같다 (td-export 실출력: json 은 DEFAULT NULL, text 는 DEFAULT 없음)', () => {
    const showCreate = [
      'CREATE TABLE `t` (',
      '  `n` int DEFAULT NULL,',
      '  `j` json DEFAULT NULL,',
      '  `x` text COLLATE utf8mb4_general_ci',
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci',
    ].join('\n');
    const made = [spec({ name: 'n', type: 'int' }), spec({ name: 'j', type: 'json' }), spec({ name: 'x', type: 'text' })].map((s) => finalizeColumn(s, T));
    expect(made).toEqual(parseCreateTable(showCreate).columns);
  });

  it('명시한 DEFAULT NULL: TEXT·BLOB 은 기본값이 저장되지 않고 JSON·GEOMETRY 는 NULL', () => {
    const explicit = (type: string) => finalizeColumn(spec({ type, default: { kind: 'null' } }), T);
    expect(explicit('text')).not.toHaveProperty('default');
    expect(explicit('blob')).not.toHaveProperty('default');
    expect(explicit('json').default).toBe('NULL');
    expect(explicit('point').default).toBe('NULL');
    expect(explicit('int').default).toBe('NULL');
  });

  it('TEXT·BLOB·JSON·GEOMETRY 의 리터럴 기본값은 거부 (1101)', () => {
    for (const type of ['text', 'blob', 'json', 'point']) {
      expect(() => finalizeColumn(spec({ type, default: { kind: 'string', value: 'x' } }), T), type).toThrow(/1101/);
    }
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

  it('ON UPDATE 가 잘못되면 1294, DEFAULT CURRENT_TIMESTAMP 가 잘못되면 1067', () => {
    expect(() => finalizeColumn(spec({ type: 'int', onUpdate: {} }), T)).toThrow(/ON UPDATE.*\(MySQL 1294\)/);
    expect(() => finalizeColumn(spec({ type: 'datetime(3)', onUpdate: {} }), T)).toThrow(/ON UPDATE.*\(MySQL 1294\)/);
    expect(() => finalizeColumn(spec({ type: 'int', default: { kind: 'now' } }), T)).toThrow(/\(MySQL 1067\)/);
    expect(() => finalizeColumn(spec({ type: 'datetime(3)', default: { kind: 'now' } }), T)).toThrow(/\(MySQL 1067\)/);
  });

  it('PRIMARY KEY NULL·문자열 AUTO_INCREMENT·AUTO_INCREMENT 기본값은 거부', () => {
    expect(() => finalizeColumn(spec({ primaryKey: true, nullable: true }), T)).toThrow(/1171/);
    expect(() => finalizeColumn(spec({ type: 'varchar(1)', autoIncrement: true }), T)).toThrow(/1063/);
    expect(() => finalizeColumn(spec({ autoIncrement: true, default: { kind: 'number', value: '1' } }), T)).toThrow(/1067/);
  });
});
