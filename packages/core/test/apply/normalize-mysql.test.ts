import { describe, expect, it } from 'vitest';
import { canonicalCharset, canonicalCollation, columnCharset, finalizeColumn, normalizeDefault, normalizeUserType, routineReturns, tableCharset, trimTrailingSpaces } from '../../src/apply/normalize-mysql';
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

  // FLOAT·DOUBLE(M,D) 의 크기 한도 (MySQL 8.0.46·8.4.11 실측, 검사 순서도 같다): D > 30 은 1425, D > M 은 1427, M 이 0 이나 255 를 넘으면 1439 (리뷰 1회차 F4)
  it.each([
    ['DOUBLE(255,10000000)', '1425'], ['DOUBLE(256,300)', '1425'], ['FLOAT(10,31)', '1425'], ['DOUBLE(5,10)', '1427'], ['DOUBLE(0,5)', '1427'],
    ['DOUBLE(0,0)', '1439'], ['DOUBLE(256,2)', '1439'], ['FLOAT(256,1)', '1439'], ['REAL(99999999999,1)', '1439'],
  ])('%s 는 거부 (MySQL %s)', (src, errno) => {
    expect(messageOf(() => normalizeUserType(src))).toContain(`(MySQL ${errno})`);
  });

  it.each([['DOUBLE(255,30)', 'double(255,30)'], ['FLOAT(255,30)', 'float(255,30)'], ['DOUBLE(1,1)', 'double(1,1)']])('%s → %s (한도 안)', (src, out) => {
    expect(normalizeUserType(src)).toBe(out);
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
    // CHAR 기본값의 끝 공백(U+0020)은 MySQL 이 떼고 찍는다 — 앞 공백·탭·VARCHAR 는 그대로 (8.0.46·8.4.11 실측)
    [{ kind: 'string', value: 'ab  ' }, 'char(5)', "'ab'"],
    [{ kind: 'string', value: ' ' }, 'char(1)', "''"],
    [{ kind: 'string', value: '  ab' }, 'char(5)', "'  ab'"],
    [{ kind: 'string', value: 'a\tb\t ' }, 'char(5)', "'a\tb\t'"],
    [{ kind: 'string', value: 'ab  ' }, 'varchar(5)', "'ab  '"],
    // BIT 값의 앞쪽 0 은 MySQL 이 떼고 찍는다 (8.0.46·8.4.11 실측: b'00000101' → b'101', b'00000000' → b'0')
    [{ kind: 'bit', value: "b'00000101'" }, 'bit(8)', "b'101'"],
    [{ kind: 'bit', value: "b'00000000'" }, 'bit(8)', "b'0'"],
    [{ kind: 'bit', value: "b'0'" }, 'bit(8)', "b'0'"],
    [{ kind: 'number', value: '0' }, 'bit(8)', "b'0'"],
    [{ kind: 'null' }, 'int', 'NULL'],
    [{ kind: 'null' }, 'json', 'NULL'],
    [{ kind: 'null' }, 'point', 'NULL'],
  ] as const)('%j on %s → %s', (s, type, out) => expect(normalizeDefault(s as DefaultSpec, col(type), T)).toBe(out));

  it.each([
    [{ kind: 'null' }, col('int', false)], [{ kind: 'string', value: 'x' }, col('text')], [{ kind: 'now' }, col('date')],
    [{ kind: 'now' }, col('datetime(3)')], [{ kind: 'number', value: '1.5' }, col('int')], [{ kind: 'string', value: 'z' }, col("enum('a')")],
    [{ kind: 'number', value: '-1' }, col('int unsigned')], [{ kind: 'string', value: 'abc' }, col('int')],
  ] as const)('%j 는 거부', (s, c) => expect(() => normalizeDefault(s as DefaultSpec, c, T)).toThrow(ApplyFailure));

  it('TEXT·BLOB 계열의 명시한 DEFAULT NULL 은 저장되는 기본값이 없다 (SHOW CREATE 에 보이지 않는다)', () => {
    for (const type of ['text', 'tinytext', 'mediumtext', 'longtext', 'blob', 'tinyblob', 'mediumblob', 'longblob']) {
      expect(normalizeDefault({ kind: 'null' }, col(type), T), type).toBeUndefined();
    }
  });

  it('NOT NULL 인 TEXT 에 DEFAULT NULL 은 여전히 거부 (1067)', () => {
    expect(() => normalizeDefault({ kind: 'null' }, col('text', false), T)).toThrow(/1067/);
  });

  it.each([
    [{ kind: 'string', value: 'x' }, col('text')], [{ kind: 'string', value: 'x' }, col('blob')], [{ kind: 'string', value: 'x' }, col('json')],
    [{ kind: 'number', value: '1' }, col('point')], [{ kind: 'string', value: 'x' }, col('geometry')], [{ kind: 'now' }, col('json')],
  ] as const)('%j 는 리터럴 기본값이라 거부 (1101)', (s, c) => expect(() => normalizeDefault(s as DefaultSpec, c, T)).toThrow(/1101/));

  // 숫자 판정 정규식은 선형이어야 한다: 앞쪽 \d+ 와 \d* 가 같은 자리를 나눠 갖는 모양은 숫자 아닌 긴 문자열에서 O(n^2) (20만 자 ≈ 30 초)
  it('숫자 판정이 선형이다: 숫자가 아닌 긴 문자열 기본값도 바로 거부한다', () => {
    const started = performance.now();
    expect(() => normalizeDefault({ kind: 'string', value: `${'1'.repeat(200000)}x` }, col('int'), T)).toThrow(ApplyFailure);
    expect(() => normalizeDefault({ kind: 'string', value: `${'1'.repeat(100000)}.${'1'.repeat(100000)}x` }, col('double'), T)).toThrow(ApplyFailure);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it.each([['5', 'int', "'5'"], ['+5', 'int', "'5'"], ['-0', 'int unsigned', "'0'"], ['1.', 'double', "'1'"], ['.5', 'double', "'0.5'"], ['1e2', 'double', "'100'"], ['1.5E+1', 'double', "'15'"], [' 7 ', 'int', "'7'"]])(
    '숫자 모양 문자열 %j (%s) → %s', (value, type, out) => expect(normalizeDefault({ kind: 'string', value }, col(type), T)).toBe(out));

  it.each([[''], ['.'], ['+'], ['e5'], ['1e'], ['1e+'], ['1..2'], ['1.2.3'], ['0x10'], ['1 2']])('숫자가 아닌 문자열 %j 은 거부 (1067)', (value) => {
    expect(() => normalizeDefault({ kind: 'string', value }, col('double'), T)).toThrow(/\(MySQL 1067\)/);
  });

  // 문자열 컬럼에 쓴 숫자 리터럴은 MySQL 이 수로 읽은 뒤 글자로 바꿔 저장한다 (8.0.46·8.4.11 실측): 정수부 앞 0 을 떼고 소수부는 쓴 그대로 두며,
  // 빈 소수부는 점까지 떼고, 값이 0 이면 부호를 뗀다. 쓴 글자를 그대로 저장하면 다른 DB 에 다른 기본값을 만든다 (리뷰 1회차 F3)
  it.each([
    ['001', 'varchar(10)', "'1'"], ['-0', 'varchar(10)', "'0'"], ['-001', 'varchar(10)', "'-1'"], ['1.50', 'varchar(10)', "'1.50'"],
    ['001.50', 'varchar(10)', "'1.50'"], ['1.', 'varchar(10)', "'1'"], ['-0.0', 'varchar(10)', "'0.0'"], ['-0.5', 'varchar(10)', "'-0.5'"],
    ['00.00', 'varchar(10)', "'0.00'"], ['0001.000100', 'varchar(20)', "'1.000100'"], ['007', 'char(10)', "'7'"], ['1.0', 'char(10)', "'1.0'"],
    ['007', 'varbinary(10)', "'7'"], ['123456789012345678901234567890', 'varchar(40)', "'123456789012345678901234567890'"],
  ])('숫자 리터럴 %s 을 %s 기본값으로 쓰면 MySQL 이 찍는 글자 %s', (value, type, out) => {
    expect(normalizeDefault({ kind: 'number', value }, col(type), T)).toBe(out);
  });

  // ENUM·SET 에 쓴 숫자는 값이 아니라 순번·비트로 읽는다 (8.0.46·8.4.11 실측: ENUM('2','1') DEFAULT 1 → '2', SET('2','a') DEFAULT 2 → 'a'). 1차에서는 받지 않는다
  it.each([[{ value: '1' }, "enum('2','1')"], [{ value: '2' }, "set('2','a')"], [{ value: '0' }, "enum('a')"], [{ value: '1.5' }, "set('a')"]])('숫자 %j 를 %s 기본값으로 쓰면 RE_EXPORT 로 거부한다', ({ value }, type) => {
    expect(messageOf(() => normalizeDefault({ kind: 'number', value }, col(type), T))).toMatch(new RegExp(`순번.*${RE_EXPORT}$`));
  });

  // ENUM·SET 기본값의 멤버는 컬럼 콜레이션으로 찾는다 (리뷰 2회차 R2-02, 8.0.46·8.4.11 실측): _bin·_cs 는 대소문자까지 같은 멤버만 맞고
  // (ENUM('a','A') COLLATE utf8mb4_bin DEFAULT 'A' → 'A', ENUM('a','b') COLLATE utf8mb4_bin DEFAULT 'A' → 1067), _ci 는 대소문자를 무시한다
  const withCollation = (type: string, collation: string) => ({ ...col(type), charset: collation.split('_')[0], collation });
  it.each([
    ["enum('a','A')", 'utf8mb4_bin', 'A', "'A'"], ["enum('a','A')", 'utf8mb4_bin', 'a', "'a'"], ["set('a','A')", 'utf8mb4_bin', 'A', "'A'"],
    ["set('a','A')", 'utf8mb4_bin', 'A,a', "'a,A'"], ["set('a','b')", 'utf8mb4_0900_as_cs', 'b,a', "'a,b'"], ["enum('a','b')", 'utf8mb4_bin', 'b  ', "'b'"],
    ["enum('a','b')", 'utf8mb4_0900_as_ci', 'B', "'b'"], ["enum('a','b')", 'latin1_general_ci', 'B  ', "'b'"], ["set('x','y')", 'utf8mb4_general_ci', 'Y,X', "'x,y'"],
  ])('%s COLLATE %s DEFAULT %j → %s', (type, collation, value, out) => {
    expect(normalizeDefault({ kind: 'string', value }, withCollation(type, collation), T)).toBe(out);
  });

  it.each([
    ["enum('a','b')", 'utf8mb4_bin', 'A'], ["enum('a','b')", 'utf8mb4_0900_as_cs', 'B'], ["set('a','b')", 'latin1_general_cs', 'A'], ["set('a','b')", 'utf8mb4_bin', 'a,B'],
  ])('%s COLLATE %s DEFAULT %j 는 대소문자가 다른 멤버라 거부한다 (1067)', (type, collation, value) => {
    expect(() => normalizeDefault({ kind: 'string', value }, withCollation(type, collation), T)).toThrow(/\(MySQL 1067\)/);
  });

  // 멤버 비교는 재현할 수 있는 콜레이션 규칙으로만 한다 (리뷰 3회차 R3-02·M-3, 8.0.46·8.4.11 실측): MySQL 은 실제 콜레이션으로 멤버를 하나씩 견주어 처음 같은 멤버를 쓴다.
  // 표준 _ci 는 ASCII 끼리 대소문자만 무시하고, binary·_bin·표준 _cs 는 글자가 같아야 한다. 언어별 콜레이션(utf8mb4_turkish_ci 의 'I' 는 'ı', utf8mb4_roman_ci 의 'J' 는 'i',
  // big5_chinese_ci 의 '`' 는 'E')과 ASCII 가 아닌 글자(utf8mb4_0900_ai_ci 의 'cafe' 는 'café')는 글자까지 같은 멤버만 받고 나머지는 RE_EXPORT 로 거부한다
  it.each([
    ["enum('i','ı')", 'utf8mb4_turkish_ci', 'ı', "'ı'"], ["enum('i','ı')", 'utf8mb4_turkish_ci', 'i', "'i'"], ["set('i','ı')", 'utf8mb4_tr_0900_ai_ci', 'ı,i', "'i,ı'"],
    ["enum('남','여')", 'utf8mb4_0900_ai_ci', '여', "'여'"], ["enum('aa','b')", 'utf8mb4_danish_ci', 'aa', "'aa'"],
    // 대소문자만 다른 멤버(엄격하지 않은 세션에서 만든 기준 컬럼)는 처음 맞는 멤버다 (8.0.46·8.4.11 실측: ENUM('a','A') utf8mb4_general_ci 의 SET DEFAULT 'A' → 'a')
    ["enum('a','A')", 'utf8mb4_general_ci', 'A', "'a'"],
    ["enum('a','b')", 'utf8_general_ci', 'B', "'b'"], ["enum('x','y')", 'euckr_korean_ci', 'Y', "'y'"], ["enum('x','y')", 'latin1_swedish_ci', 'Y', "'y'"],
  ])('%s COLLATE %s DEFAULT %j → %s (콜레이션 규칙)', (type, collation, value, out) => {
    expect(normalizeDefault({ kind: 'string', value }, withCollation(type, collation), T)).toBe(out);
  });

  it.each([
    ["enum('i','ı')", 'utf8mb4_turkish_ci', 'I'], ["set('i','ı')", 'utf8mb4_turkish_ci', 'I'], ["enum('i','ı')", 'utf8mb4_tr_0900_ai_ci', 'I'],
    ["enum('i','x')", 'utf8mb4_roman_ci', 'J'], ["enum('aa','b')", 'utf8mb4_danish_ci', 'AA'], ["enum('E','x')", 'big5_chinese_ci', '`'],
    ["enum('café','b')", 'utf8mb4_0900_ai_ci', 'cafe'], ["enum('Ä','b')", 'utf8mb4_general_ci', 'ä'], ["enum('é','b')", 'utf8mb4_0900_as_cs', 'É'],
    ["enum('a','b')", 'utf8mb4_0900_ai_ci', 'a\u0001'],
  ])('%s COLLATE %s DEFAULT %j 는 그 콜레이션의 비교를 재현하지 않아 RE_EXPORT 로 거부한다', (type, collation, value) => {
    expect(messageOf(() => normalizeDefault({ kind: 'string', value }, withCollation(type, collation), T))).toMatch(new RegExp(`콜레이션 ${collation}.*${RE_EXPORT}$`));
  });

  it('binary 문자셋 테이블의 컬럼은 콜레이션이 찍히지 않아도 글자가 같은 멤버만 맞는다 (리뷰 3회차 M-3)', () => {
    const binaryTable = { charset: 'binary', collation: 'binary' };
    expect(normalizeDefault({ kind: 'string', value: 'A' }, col("enum('a','A')"), binaryTable)).toBe("'A'");
    expect(normalizeDefault({ kind: 'string', value: 'A,a' }, col("set('a','A')"), binaryTable)).toBe("'a,A'");
    expect(() => normalizeDefault({ kind: 'string', value: 'A' }, col("enum('a','b')"), binaryTable)).toThrow(/\(MySQL 1067\)/);
    expect(() => normalizeDefault({ kind: 'string', value: 'É' }, withCollation("enum('é','b')", 'utf8mb4_bin'), T)).toThrow(/\(MySQL 1067\)/);
  });

  // BIT 에 쓴 문자열은 수가 아니라 글자의 바이트로 저장된다 (8.0.46·8.4.11 실측: BIT(8) DEFAULT '1' → b'110001', BIT(1) DEFAULT '0' → 1067).
  // 바이트 규칙은 재현하지 않고 받지 않는다 — 숫자와 b'…' 는 그대로 받는다 (리뷰 2회차 M-5)
  it.each([['1', 'bit(8)'], ['0', 'bit(1)'], ['ab', 'bit(16)'], ['', 'bit(8)'], ["b'1'", 'bit(8)']])('BIT 의 문자열 기본값 %j (%s) 는 RE_EXPORT 로 거부한다', (value, type) => {
    expect(messageOf(() => normalizeDefault({ kind: 'string', value }, col(type), T))).toMatch(new RegExp(`문자열.*${RE_EXPORT}$`));
  });

  it('BIT 의 숫자·b 리터럴 기본값은 그대로 받는다', () => {
    expect(normalizeDefault({ kind: 'number', value: '5' }, col('bit(8)'), T)).toBe("b'101'");
    expect(normalizeDefault({ kind: 'bit', value: "b'110001'" }, col('bit(8)'), T)).toBe("b'110001'");
  });

  it('DEFAULT CURRENT_TIMESTAMP 가 잘못되면 1067', () => {
    expect(() => normalizeDefault({ kind: 'now' }, col('date'), T)).toThrow(/1067/);
    expect(() => normalizeDefault({ kind: 'now' }, col('datetime(3)'), T)).toThrow(/1067/);
  });
});

describe('문자셋 (SHOW CREATE 표기)', () => {
  it('테이블 기본값을 물려받으면 문자셋 기본 콜레이션이 아닐 때만 COLLATE', () => {
    expect(columnCharset('varchar(10)', {}, T)).toEqual({ collation: 'utf8mb4_general_ci' });
    expect(columnCharset('varchar(10)', {}, { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' })).toEqual({});
  });

  // MySQL 8.0.46·8.4.11 실측: CHARACTER SET·COLLATE 를 하나라도 쓴 컬럼은 테이블 기본과 같아도 둘 다 찍는다 (문자셋만 써도 그 문자셋의 기본 콜레이션이 붙는다)
  it('CHARACTER SET·COLLATE 를 직접 쓰면 둘 다 남는다', () => {
    expect(columnCharset('varchar(10)', { charset: 'latin1' }, T)).toEqual({ charset: 'latin1', collation: 'latin1_swedish_ci' });
    expect(columnCharset('varchar(10)', { charset: 'utf8mb4' }, T)).toEqual({ charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }); // 테이블 콜레이션(general_ci)이 아니라 문자셋의 기본 콜레이션
    expect(columnCharset('varchar(10)', { collation: 'utf8mb4_bin' }, T)).toEqual({ charset: 'utf8mb4', collation: 'utf8mb4_bin' });
    expect(columnCharset('varchar(10)', { collation: 'utf8mb4_general_ci' }, T)).toEqual({ charset: 'utf8mb4', collation: 'utf8mb4_general_ci' }); // 테이블 기본과 같아도
    expect(columnCharset('text', { charset: 'utf8' }, T)).toEqual({ charset: 'utf8mb3', collation: 'utf8mb3_general_ci' });
  });

  // SHOW CREATE 가 컬럼 줄에 찍는 모양 (실측): 쓰지 않으면 테이블 기본을 물려받아 그 콜레이션이 문자셋 기본이 아닐 때만 `COLLATE x`, 쓰면 `CHARACTER SET a COLLATE b`.
  // 기대값은 MySQL 이 찍은 컬럼 줄을 덤프 파서(parseCreateTable)로 읽은 모델이다 — 적용 결과가 재추출한 덤프와 같아야 한다
  const T1 = { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' };
  const T2 = { charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' };
  const T3 = { charset: 'latin1', collation: 'latin1_swedish_ci' };
  const T4 = { charset: 'latin1', collation: 'latin1_bin' };
  const T5 = { charset: 'utf8mb4', collation: 'utf8mb4_bin' };
  const dumped = (table: { charset: string; collation: string }, printed: string) => {
    const c = parseCreateTable(`CREATE TABLE \`t\` (\n  \`c\` varchar(10) ${printed}DEFAULT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=${table.charset} COLLATE=${table.collation}`).columns[0];
    return { ...(c.charset === undefined ? {} : { charset: c.charset }), ...(c.collation === undefined ? {} : { collation: c.collation }) };
  };
  it.each([
    // 테이블 이름 | 컬럼에 쓴 것 | 테이블 | MySQL 이 찍은 줄 (타입과 DEFAULT NULL 사이)
    ['T1', {}, T1, ''],
    ['T2', {}, T2, 'COLLATE utf8mb4_unicode_ci '],
    ['T3', {}, T3, ''],
    ['T4', {}, T4, 'COLLATE latin1_bin '],
    ['T5', {}, T5, 'COLLATE utf8mb4_bin '],
    ['T1', { charset: 'utf8mb4' }, T1, 'CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci '], // E.2: 테이블과 같은 문자셋
    ['T3', { charset: 'latin1' }, T3, 'CHARACTER SET latin1 COLLATE latin1_swedish_ci '],
    ['T1', { charset: 'latin1' }, T1, 'CHARACTER SET latin1 COLLATE latin1_swedish_ci '], // E.1: 테이블과 다른 문자셋, COLLATE 없음
    ['T2', { charset: 'latin1' }, T2, 'CHARACTER SET latin1 COLLATE latin1_swedish_ci '],
    ['T4', { charset: 'latin1' }, T4, 'CHARACTER SET latin1 COLLATE latin1_swedish_ci '], // 문자셋만 쓰면 테이블 콜레이션(latin1_bin)이 아니라 문자셋의 기본
    ['T2', { charset: 'utf8mb4' }, T2, 'CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci '], // E.4: 테이블 콜레이션이 unicode_ci 인 테이블 + CHARACTER SET utf8mb4
    ['T5', { charset: 'utf8mb4' }, T5, 'CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci '],
    ['T1', { collation: 'utf8mb4_0900_ai_ci' }, T1, 'CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci '], // E.3: 문자셋의 기본 콜레이션을 직접 쓴 경우, 테이블 콜레이션과 같을 때
    ['T2', { collation: 'utf8mb4_0900_ai_ci' }, T2, 'CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci '], // E.3: 테이블 콜레이션과 다를 때
    ['T3', { collation: 'latin1_swedish_ci' }, T3, 'CHARACTER SET latin1 COLLATE latin1_swedish_ci '],
    ['T2', { collation: 'utf8mb4_unicode_ci' }, T2, 'CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci '], // 테이블 콜레이션을 직접 쓴 경우도 둘 다
    ['T4', { collation: 'latin1_bin' }, T4, 'CHARACTER SET latin1 COLLATE latin1_bin '],
    ['T1', { charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' }, T1, 'CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci '],
    ['T1', { charset: 'latin1', collation: 'latin1_bin' }, T1, 'CHARACTER SET latin1 COLLATE latin1_bin '],
    ['T1', { collation: 'latin1_swedish_ci' }, T1, 'CHARACTER SET latin1 COLLATE latin1_swedish_ci '], // COLLATE 만 써도 문자셋이 붙는다
    ['T1', { charset: 'ascii' }, T1, 'CHARACTER SET ascii COLLATE ascii_general_ci '],
    ['T1', { collation: 'utf8_general_ci' }, T1, 'CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci '],
  ])('실측 모양: 테이블 %s, 컬럼에 쓴 것 %j', (_name, written, table, printed) => {
    const expected = dumped(table, printed);
    expect(columnCharset('varchar(10)', written, table)).toEqual(expected);
    expect(columnCharset('text', written, table)).toEqual(expected); // TEXT·ENUM·CHAR 도 같다
    expect(columnCharset("enum('a','b')", written, table)).toEqual(expected);
    expect(columnCharset('char(3)', written, table)).toEqual(expected);
  });

  // MySQL 은 CHARACTER SET binary 를 VARBINARY·BLOB 타입으로 바꾼다 (varchar(10) → varbinary(10), text → blob) — 타입이 바뀌므로 1차 범위 밖
  it('CHARACTER SET binary·COLLATE binary 는 거부 (타입이 바뀐다)', () => {
    expect(() => columnCharset('varchar(10)', { charset: 'binary' }, T1)).toThrow(RE_EXPORT);
    expect(() => columnCharset('varchar(10)', { collation: 'binary' }, T1)).toThrow(RE_EXPORT);
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

  // MySQL 8.0.46·8.4.11 실측 (스키마 기본 문자셋·콜레이션별 SHOW CREATE FUNCTION): 스키마 기본 콜레이션이 문자셋의 기본(primary) 콜레이션이 아니면 COLLATE 도 찍힌다.
  // 테이블 옵션과 달리 utf8mb4_0900_ai_ci 는 찍지 않는다 (VARCHAR·TEXT·ENUM·CHAR 모두 같다)
  it.each([
    ['utf8mb4', 'utf8mb4_0900_ai_ci', 'CHARSET utf8mb4'],
    ['utf8mb4', 'utf8mb4_unicode_ci', 'CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci'],
    ['utf8mb4', 'utf8mb4_general_ci', 'CHARSET utf8mb4 COLLATE utf8mb4_general_ci'],
    ['utf8mb4', 'utf8mb4_bin', 'CHARSET utf8mb4 COLLATE utf8mb4_bin'],
    ['utf8mb3', 'utf8mb3_general_ci', 'CHARSET utf8mb3'],
    ['utf8mb3', 'utf8mb3_unicode_ci', 'CHARSET utf8mb3 COLLATE utf8mb3_unicode_ci'],
    ['latin1', 'latin1_swedish_ci', 'CHARSET latin1'],
    ['latin1', 'latin1_bin', 'CHARSET latin1 COLLATE latin1_bin'],
    ['ascii', 'ascii_general_ci', 'CHARSET ascii'],
  ])('routineReturns: 스키마 기본 %s / %s → %s', (charset, collation, suffix) => {
    for (const [type, normalized] of [['VARCHAR(5)', 'varchar(5)'], ['TEXT', 'text'], ["ENUM('a','b')", "enum('a','b')"], ['CHAR(2)', 'char(2)']]) {
      expect(routineReturns(type, charset, collation)).toBe(`${normalized} ${suffix}`);
    }
    expect(routineReturns('INT', charset, collation)).toBe('int'); // 문자열이 아니면 붙이지 않는다
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

  // MySQL 8.0.46·8.4.11 실측: AUTO_INCREMENT 컬럼은 NULL 을 써도 NOT NULL 이고 DEFAULT NULL 은 조용히 없어진다 (NOT NULL DEFAULT NULL 도 받는다).
  // 다른 기본값은 1067. 컬럼 안 PRIMARY KEY 와 NULL 은 1171
  it('AUTO_INCREMENT 컬럼은 NULL·DEFAULT NULL 을 써도 NOT NULL 이고 기본값이 없다', () => {
    const plain = { type: 'int', autoIncrement: true };
    expect(finalizeColumn(spec(plain), T)).toEqual({ name: 'c', type: 'int', nullable: false, invisible: false, autoIncrement: true });
    expect(finalizeColumn(spec({ ...plain, nullable: true }), T)).toMatchObject({ nullable: false });
    expect(finalizeColumn(spec({ ...plain, default: { kind: 'null' } }), T)).toEqual({ name: 'c', type: 'int', nullable: false, invisible: false, autoIncrement: true });
    expect(finalizeColumn(spec({ ...plain, nullable: false, default: { kind: 'null' } }), T).default).toBeUndefined();
    expect(finalizeColumn(spec({ ...plain, nullable: true, default: { kind: 'null' } }), T)).toMatchObject({ nullable: false });
  });

  // MySQL 실측: FLOAT·DOUBLE AUTO_INCREMENT 는 8.0.46 이 받고 8.4.11 은 1063 이다 (DECIMAL·문자열은 둘 다 1063). 스펙은 8.4 를 따르므로 둘 다 거부한다
  it.each(['float', 'double', 'float(7,4)', 'double unsigned'])('%s AUTO_INCREMENT 는 8.4 규칙대로 거부 (MySQL 8.4 1063)', (type) => {
    expect(() => finalizeColumn(spec({ type, autoIncrement: true }), T)).toThrow(/\(MySQL 8\.4 1063 — 8\.0 은 받지만 1차에서는 8\.4 규칙을 따릅니다\)/);
    expect(() => finalizeColumn(spec({ type, autoIncrement: true, nullable: false }), T)).toThrow(/8\.4 1063/);
    expect(finalizeColumn(spec({ type }), T).type).toBe(type); // AUTO_INCREMENT 가 아니면 상관없다
  });

  it.each(['tinyint', 'smallint', 'mediumint', 'int', 'bigint unsigned'])('%s AUTO_INCREMENT 는 받고, DECIMAL·문자열은 1063', (type) => {
    expect(finalizeColumn(spec({ type, autoIncrement: true }), T)).toMatchObject({ autoIncrement: true, nullable: false });
    expect(() => finalizeColumn(spec({ type: 'decimal(10,0)', autoIncrement: true }), T)).toThrow(/\(MySQL 1063\)/);
  });

  it('PRIMARY KEY NULL·문자열 AUTO_INCREMENT·AUTO_INCREMENT 기본값은 거부', () => {
    expect(() => finalizeColumn(spec({ primaryKey: true, nullable: true }), T)).toThrow(/1171/);
    expect(() => finalizeColumn(spec({ type: 'varchar(1)', autoIncrement: true }), T)).toThrow(/1063/);
    expect(() => finalizeColumn(spec({ autoIncrement: true, default: { kind: 'number', value: '1' } }), T)).toThrow(/1067/);
  });
});

// MySQL 은 ENUM·SET 값 끝의 공백(U+0020)만 지운다. `/ +$/` 는 값 가운데 공백이 길면 시작 위치마다 끝까지 훑어 O(n^2) (10만 칸 ≈ 5 초)
describe('ENUM·SET 값 끝 공백', () => {
  it.each([
    ['', ''], ['a', 'a'], ['a  ', 'a'], ['   ', ''], [' a ', ' a'], ['a b  ', 'a b'],
    ['a\t', 'a\t'], ['a \t ', 'a \t'], ['a\n ', 'a\n'], ['a\u00a0', 'a\u00a0'], ['a\u3000 ', 'a\u3000'],
  ])('trimTrailingSpaces(%j) → %j: U+0020 만 지운다', (input, out) => {
    expect(trimTrailingSpaces(input)).toBe(out);
  });

  it('긴 공백이 값 가운데 있어도 선형이다 (ENUM 타입)', () => {
    const gap = ' '.repeat(200000);
    const started = performance.now();
    expect(normalizeUserType(`ENUM('a${gap}b')`)).toBe(`enum('a${gap}b')`);
    expect(normalizeUserType(`SET('a${gap}b ')`)).toBe(`set('a${gap}b')`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('긴 공백이 값 가운데 있어도 선형이다 (ENUM 기본값)', () => {
    const started = performance.now();
    expect(() => normalizeDefault({ kind: 'string', value: `a${' '.repeat(200000)}b` }, col("enum('a','b')"), T)).toThrow(ApplyFailure);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('ENUM 기본값의 끝 공백은 지우고 비교한다', () => {
    expect(normalizeDefault({ kind: 'string', value: 'B   ' }, col("enum('a','b')"), T)).toBe("'b'");
    expect(() => normalizeDefault({ kind: 'string', value: 'b\t' }, col("enum('a','b')"), T)).toThrow(/ENUM 값이 아닙니다/);
  });
});
