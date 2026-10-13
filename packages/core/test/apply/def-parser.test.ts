import { describe, expect, it } from 'vitest';
import { parseColumnSpec, parseConstraint, parseDefault, parsePosition, parseTableItem, parseUsing } from '../../src/apply/def-parser';
import { ApplyFailure, RE_EXPORT } from '../../src/apply/types';
import { Cursor, ParseError } from '../../src/cursor';
import { tokenize } from '../../src/lexer';
import { UnsafeValueError } from '../../src/sql-safety';

const cur = (src: string) => new Cursor(tokenize(src), src);
const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('예외가 나지 않았습니다');
};

describe('parseColumnSpec', () => {
  it('백틱 없는 이름·소문자 키워드·타입 별칭·속성', () => {
    expect(parseColumnSpec(cur("price dec(12,4) not null default 0 comment '가격'"))).toEqual({
      name: 'price', type: 'decimal(12,4)', nullable: false, default: { kind: 'number', value: '0' }, comment: '가격',
      autoIncrement: false, invisible: false, primaryKey: false, unique: false,
    });
  });

  it('부호 있는 숫자·NOW()·ON UPDATE·컬럼 안 PRIMARY KEY·UNIQUE·REFERENCES(무시)·TRUE', () => {
    expect(parseColumnSpec(cur('n INT DEFAULT -1')).default).toEqual({ kind: 'number', value: '-1' });
    expect(parseColumnSpec(cur('f BOOL DEFAULT TRUE')).default).toEqual({ kind: 'number', value: '1' });
    expect(parseColumnSpec(cur('ts DATETIME(3) DEFAULT NOW(3) ON UPDATE CURRENT_TIMESTAMP(3)'))).toMatchObject({ type: 'datetime(3)', default: { kind: 'now', fsp: 3 }, onUpdate: { fsp: 3 } });
    expect(parseColumnSpec(cur('id INT AUTO_INCREMENT PRIMARY KEY'))).toMatchObject({ autoIncrement: true, primaryKey: true });
    expect(parseColumnSpec(cur('code VARCHAR(10) UNIQUE KEY'))).toMatchObject({ unique: true });
    expect(parseColumnSpec(cur('pid INT REFERENCES parent(id) ON DELETE CASCADE'))).toMatchObject({ name: 'pid', type: 'int' });
    expect(parseColumnSpec(cur('s VARCHAR(5) CHARACTER SET latin1 COLLATE latin1_bin'))).toMatchObject({ charset: 'latin1', collation: 'latin1_bin' });
  });

  it('FIRST·AFTER 앞에서 멈춘다', () => {
    const c = cur('a INT NOT NULL AFTER b');
    expect(parseColumnSpec(c).nullable).toBe(false);
    expect(parsePosition(c)).toEqual({ after: 'b' });
    expect(parsePosition(cur('FIRST'))).toEqual({ first: true });
  });

  it.each([['g INT AS (a + 1)'], ['g INT GENERATED ALWAYS AS (a) STORED'], ['c INT CHECK (c > 0)'], ['d INT DEFAULT (1 + 1)'], ['b VARCHAR(1) BINARY'], ['x INT FOO'], ['h BINARY(2) DEFAULT 0x0102']])('%s 는 거부', (src) => {
    expect(() => parseColumnSpec(cur(src))).toThrow(ApplyFailure);
  });
});

describe('parseConstraint / parseTableItem', () => {
  it('이름 없는 인덱스·USING 앞자리·CONSTRAINT UNIQUE·PRIMARY KEY 이름 무시', () => {
    expect(parseConstraint(cur('INDEX (a, b DESC)'))).toEqual({ kind: 'index', named: false, index: { name: '', kind: 'INDEX', parts: [{ column: 'a', desc: false }, { column: 'b', desc: true }], invisible: false } });
    expect(parseConstraint(cur('KEY ix USING BTREE (a)'))).toMatchObject({ named: true, index: { name: 'ix', using: 'BTREE' } });
    expect(parseConstraint(cur('CONSTRAINT uq UNIQUE (code)'))).toMatchObject({ named: true, index: { name: 'uq', kind: 'UNIQUE' } });
    expect(parseConstraint(cur('PRIMARY KEY pk (id)'))).toMatchObject({ named: true, index: { name: 'PRIMARY', kind: 'PRIMARY' } });
    expect(parseConstraint(cur("FULLTEXT KEY ft (title) WITH PARSER ngram COMMENT 'x'"))).toMatchObject({ index: { kind: 'FULLTEXT', parser: 'ngram', comment: 'x' } });
  });

  it('FOREIGN KEY: CONSTRAINT 이름·인덱스 이름', () => {
    expect(parseConstraint(cur('CONSTRAINT fk_p FOREIGN KEY ix_p (pid) REFERENCES parent (id) ON DELETE CASCADE'))).toEqual({
      kind: 'fk', named: true, indexName: 'ix_p', fk: { name: 'fk_p', columns: ['pid'], refTable: 'parent', refColumns: ['id'], onDelete: 'CASCADE' },
    });
    expect(parseConstraint(cur('FOREIGN KEY (pid) REFERENCES parent(id)'))).toMatchObject({ kind: 'fk', named: false, fk: { name: '' } });
  });

  it('FOREIGN KEY 뒤 인덱스 이름만 있고 CONSTRAINT 가 없으면 named=false, indexName 은 남는다', () => {
    expect(parseConstraint(cur('FOREIGN KEY ix_p (pid) REFERENCES parent (id)'))).toEqual({
      kind: 'fk', named: false, indexName: 'ix_p', fk: { name: '', columns: ['pid'], refTable: 'parent', refColumns: ['id'] },
    });
  });

  it('CONSTRAINT 이름과 UNIQUE KEY 이름이 둘 다 있으면 인덱스 이름이 이긴다 (MySQL 8.0.46 실측)', () => {
    expect(parseConstraint(cur('CONSTRAINT uq UNIQUE KEY ux (code)'))).toMatchObject({ named: true, index: { name: 'ux', kind: 'UNIQUE' } });
  });

  it('PRIMARY KEY 바로 뒤의 USING', () => {
    expect(parseConstraint(cur('PRIMARY KEY USING BTREE (id)'))).toEqual({
      kind: 'index', named: true, index: { name: 'PRIMARY', kind: 'PRIMARY', parts: [{ column: 'id', desc: false }], invisible: false, using: 'BTREE' },
    });
  });

  it('컬럼과 제약을 가른다, 함수 인덱스·CHECK·끝에 남은 내용은 거부', () => {
    expect(parseTableItem(cur('`key` INT')).kind).toBe('column');
    expect(parseTableItem(cur('UNIQUE KEY (a)')).kind).toBe('index');
    expect(() => parseConstraint(cur('INDEX ((a + 1))'))).toThrow(ApplyFailure);
    expect(() => parseConstraint(cur('CONSTRAINT c CHECK (a > 0)'))).toThrow(ApplyFailure);
    expect(() => parseTableItem(cur('a INT FIRST'))).toThrow(ApplyFailure);
  });
});

describe('parseDefault', () => {
  it.each([
    ['NULL', { kind: 'null' }], ["'a''b'", { kind: 'string', value: "a'b" }], ['-1.5', { kind: 'number', value: '-1.5' }], ['+5', { kind: 'number', value: '5' }],
    ['false', { kind: 'number', value: '0' }], ["b'101'", { kind: 'bit', value: "b'101'" }], ["B'1'", { kind: 'bit', value: "b'1'" }],
    ['CURRENT_TIMESTAMP', { kind: 'now' }], ['current_timestamp()', { kind: 'now' }], ['NOW(6)', { kind: 'now', fsp: 6 }],
    ['localtimestamp(2)', { kind: 'now', fsp: 2 }], ['LOCALTIME', { kind: 'now' }],
  ])('%s', (src, expected) => expect(parseDefault(cur(src))).toEqual(expected));

  it.each([['NOW'], ['CURRENT_DATE'], ["-'x'"], ['(1)'], ['0b101'], ["x'0A'"], ['CURRENT_TIMESTAMP(7)']])('%s 는 거부', (src) => {
    expect(() => parseDefault(cur(src))).toThrow(ApplyFailure);
  });

  // MySQL 8.0.46 실측: DEFAULT CURRENT_TIMESTAMP(7) → 1067, ON UPDATE CURRENT_TIMESTAMP(10) → 1294, CURRENT_TIMESTAMP(x) → 1064 (번호 없음)
  it('소수 초 자릿수가 6 을 넘으면 MySQL 이 내는 번호로 안내한다 (DEFAULT 1067, ON UPDATE 1294)', () => {
    expect(messageOf(() => parseDefault(cur('NOW(7)')))).toContain('(MySQL 1067)');
    expect(messageOf(() => parseColumnSpec(cur('t DATETIME ON UPDATE CURRENT_TIMESTAMP(10)')))).toContain('(MySQL 1294)');
    expect(messageOf(() => parseDefault(cur('NOW(x)')))).not.toContain('(MySQL');
  });
});

describe('1차 지원 범위 밖 안내', () => {
  it.each([
    ['g INT AS (a + 1)'], ['g INT GENERATED ALWAYS AS (a) STORED'], ['c INT CHECK (c > 0)'], ['d INT DEFAULT (1 + 1)'], ['b VARCHAR(1) BINARY'],
    ['h BINARY(2) DEFAULT 0x0102'], ['id BIGINT UNSIGNED SERIAL DEFAULT VALUE'],
  ])('컬럼 %s: 메시지가 다시 뽑아 올리라는 안내로 끝난다', (src) => {
    const message = messageOf(() => parseColumnSpec(cur(src)));
    expect(message).toContain('1차 지원 범위가 아닙니다');
    expect(message.endsWith(` — ${RE_EXPORT}`), message).toBe(true);
    expect(message, '조사는 앞말에 붙여 쓴다').not.toContain(' 은(는)');
  });

  it.each([['CHECK (a > 0)'], ['CONSTRAINT c CHECK (a > 0)'], ['INDEX ((a + 1))'], ['UNIQUE KEY ux (a, (b + 1))']])('제약 %s: 메시지가 다시 뽑아 올리라는 안내로 끝난다', (src) => {
    const message = messageOf(() => parseConstraint(cur(src)));
    expect(message).toContain('1차 지원 범위가 아닙니다');
    expect(message.endsWith(` — ${RE_EXPORT}`), message).toBe(true);
    expect(message, '조사는 앞말에 붙여 쓴다').not.toContain(' 은(는)');
  });
});

describe('parseColumnSpec — 입력 검사', () => {
  it("CHARACTER SET·COLLATE 이름은 문자열('latin1')로 써도 받는다 (MySQL Workbench 출력)", () => {
    expect(parseColumnSpec(cur("s VARCHAR(5) CHARACTER SET 'latin1' COLLATE 'latin1_bin' NULL"))).toMatchObject({ charset: 'latin1', collation: 'latin1_bin', nullable: true });
    expect(parseColumnSpec(cur("s VARCHAR(5) CHARSET 'utf8mb4'"))).toMatchObject({ charset: 'utf8mb4' });
  });

  it('SRID 는 정수만', () => {
    expect(parseColumnSpec(cur('g GEOMETRY SRID 4326 NOT NULL'))).toMatchObject({ srid: 4326, nullable: false });
    for (const src of ['g GEOMETRY SRID abc', "g GEOMETRY SRID '4326'", 'g GEOMETRY SRID 4.5']) expect(() => parseColumnSpec(cur(src))).toThrow(ApplyFailure);
    expect(() => parseColumnSpec(cur('g GEOMETRY SRID'))).toThrow(ParseError); // 값 없이 끝남은 Cursor 의 오류
  });

  it('1.2.3 같은 숫자는 기본값으로 쓸 수 없다', () => {
    for (const src of ['v VARCHAR(5) DEFAULT 1.2.3', 'v VARCHAR(5) DEFAULT -1.2.3', 'v VARCHAR(5) DEFAULT +0x10']) expect(() => parseColumnSpec(cur(src))).toThrow(ApplyFailure);
    expect(parseColumnSpec(cur('d DECIMAL(5,2) DEFAULT -12.50')).default).toEqual({ kind: 'number', value: '-12.50' });
  });
});

// 출력 DDL 에 따옴표 없이 찍는 값(USING·CHARACTER SET·COLLATE)은 \w+ 화이트리스트를 입력 경계에서 지킨다 (모델의 불변식)
describe('그대로 찍는 이름의 화이트리스트', () => {
  it.each([
    ['KEY ix USING `BTREE, DROP COLUMN b` (a)'], ['KEY ix USING FOO (a)'], ["UNIQUE KEY ux USING 'HASH; DROP TABLE t' (a)"],
    ['PRIMARY KEY USING `BTREE, DROP COLUMN b` (id)'], ['KEY ix (a) USING FOO'],
  ])('%s: 인덱스 타입이 BTREE·HASH·RTREE 가 아니면 거부 (MySQL 1064)', (src) => {
    const message = messageOf(() => parseConstraint(cur(src)));
    expect(message).toContain('(MySQL 1064)');
    expect(() => parseConstraint(cur(src))).toThrow(ApplyFailure);
  });

  it('뒤쪽 USING 에 쉼표·따옴표가 든 값은 parse-table 의 \\w+ 검사가 막는다', () => {
    expect(() => parseConstraint(cur('KEY ix (a) USING `BTREE, DROP COLUMN b`'))).toThrow(UnsafeValueError);
  });

  // CREATE INDEX 의 이름 뒤 USING 도 같은 함수로 읽는다 (Task 4)
  it('parseUsing: 없으면 소비하지 않고, 있으면 대문자 타입을 돌려주며, 따옴표 친 것은 거부', () => {
    const none = cur('(a)');
    expect(parseUsing(none)).toBeUndefined();
    expect(none.i).toBe(0);
    const some = cur('using btree ON t');
    expect(parseUsing(some)).toBe('BTREE');
    expect(some.i).toBe(2);
    for (const src of ['USING `BTREE`', "USING 'BTREE'", 'USING `BTREE, DROP COLUMN b`', 'USING BTREE_X']) expect(() => parseUsing(cur(src))).toThrow(ApplyFailure);
    expect(() => parseUsing(cur('USING'))).toThrow(ParseError);
  });

  it.each([['HASH', 'HASH'], ['RTREE', 'RTREE'], ['btree', 'BTREE'], ['Hash', 'HASH']])('USING %s 는 %s 로 받는다 (앞·뒤 어느 자리든)', (written, stored) => {
    expect(parseConstraint(cur(`KEY ix USING ${written} (a)`))).toMatchObject({ index: { using: stored } });
    expect(parseConstraint(cur(`KEY ix (a) USING ${written}`))).toMatchObject({ index: { using: stored } });
  });

  it.each([
    ["s VARCHAR(5) COLLATE 'utf8mb4_bin, DROP COLUMN b'"], ['s VARCHAR(5) COLLATE `utf8mb4_bin, DROP COLUMN b`'], ["s VARCHAR(5) COLLATE 'a b'"], ["s VARCHAR(5) COLLATE ''"],
  ])('%s: 콜레이션 이름이 \\w+ 가 아니면 거부 (MySQL 1273)', (src) => {
    expect(messageOf(() => parseColumnSpec(cur(src)))).toContain('(MySQL 1273)');
    expect(() => parseColumnSpec(cur(src))).toThrow(ApplyFailure);
  });

  it.each([
    ["s VARCHAR(5) CHARACTER SET 'utf8mb4, DROP COLUMN b'"], ['s VARCHAR(5) CHARACTER SET `utf8mb4, DROP COLUMN b`'], ['s VARCHAR(5) CHARSET `a b`'], ["s VARCHAR(5) CHARSET ''"],
  ])('%s: 문자셋 이름이 \\w+ 가 아니면 거부 (MySQL 1115)', (src) => {
    expect(messageOf(() => parseColumnSpec(cur(src)))).toContain('(MySQL 1115)');
    expect(() => parseColumnSpec(cur(src))).toThrow(ApplyFailure);
  });
});

describe('정규식 역추적', () => {
  it('긴 숫자 뒤에 점이 이어진 기본값도 빠르게 거부한다 (선형 시간)', () => {
    const src = `v VARCHAR(5) DEFAULT ${'1'.repeat(200_000)}.1.`;
    const started = performance.now();
    expect(() => parseColumnSpec(cur(src))).toThrow(ApplyFailure);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

// splitTopLevel 은 끝 쉼표를 조용히 버리고 빈 괄호는 항목 0개로 읽는다. MySQL 은 둘 다 1064
describe('빈 목록·끝 쉼표·정수가 아닌 KEY_BLOCK_SIZE', () => {
  it.each([
    ['INDEX ix ()'], ['PRIMARY KEY ()'], ['UNIQUE KEY ux ()'],
    ['INDEX ix (a,)'], ['PRIMARY KEY (id,)'], ['UNIQUE KEY (a, b,)'], ['KEY ix (a(10) DESC,)'],
    ['FOREIGN KEY () REFERENCES p (id)'], ['FOREIGN KEY (a) REFERENCES p ()'],
    ['FOREIGN KEY (a,) REFERENCES p (id)'], ['FOREIGN KEY (a) REFERENCES p (id,)'], ['CONSTRAINT fk FOREIGN KEY ix (a, b,) REFERENCES db.p (x, y)'],
    ['INDEX ix (a) KEY_BLOCK_SIZE=abc'], ['INDEX ix (a) KEY_BLOCK_SIZE = 1.5'],
  ])('%s 는 거부 (MySQL 1064)', (src) => {
    expect(messageOf(() => parseConstraint(cur(src)))).toContain('(MySQL 1064)');
    expect(() => parseTableItem(cur(src))).toThrow(ApplyFailure);
  });

  // MySQL 8.0.46 실측: 컬럼 안 REFERENCES p () · REFERENCES p (id,) 는 1064, REFERENCES p · REFERENCES p (id, id) 는 받는다 (내용은 버려진다)
  it.each([['a INT REFERENCES p ()'], ['a INT REFERENCES p (id,)']])('컬럼 안 %s 도 거부 (MySQL 1064)', (src) => {
    expect(messageOf(() => parseColumnSpec(cur(src)))).toContain('(MySQL 1064)');
    expect(() => parseColumnSpec(cur(src))).toThrow(ApplyFailure);
  });

  it.each([['a INT REFERENCES p'], ['a INT REFERENCES db.p (id, id) MATCH FULL ON DELETE SET NULL']])('컬럼 안 %s 는 읽고 버린다', (src) => {
    expect(parseColumnSpec(cur(src))).toMatchObject({ name: 'a', type: 'int' });
  });

  it('올바른 목록·옵션은 그대로 받는다', () => {
    expect(parseConstraint(cur('INDEX ix (a, b(5) DESC) KEY_BLOCK_SIZE=8'))).toMatchObject({ index: { parts: [{ column: 'a' }, { column: 'b', length: 5, desc: true }], keyBlockSize: 8 } });
    expect(parseConstraint(cur('FOREIGN KEY (a, b) REFERENCES db.p (x, y) ON DELETE CASCADE'))).toMatchObject({ fk: { columns: ['a', 'b'], refSchema: 'db', refColumns: ['x', 'y'], onDelete: 'CASCADE' } });
  });
});
