import { describe, expect, it } from 'vitest';
import { parseColumnSpec, parseConstraint, parseDefault, parsePosition, parseTableItem } from '../../src/apply/def-parser';
import { ApplyFailure, RE_EXPORT } from '../../src/apply/types';
import { Cursor } from '../../src/cursor';
import { tokenize } from '../../src/lexer';

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
    for (const src of ['g GEOMETRY SRID abc', "g GEOMETRY SRID '4326'", 'g GEOMETRY SRID 4.5', 'g GEOMETRY SRID']) expect(() => parseColumnSpec(cur(src))).toThrow();
  });

  it('1.2.3 같은 숫자는 기본값으로 쓸 수 없다', () => {
    for (const src of ['v VARCHAR(5) DEFAULT 1.2.3', 'v VARCHAR(5) DEFAULT -1.2.3', 'v VARCHAR(5) DEFAULT +0x10']) expect(() => parseColumnSpec(cur(src))).toThrow(ApplyFailure);
    expect(parseColumnSpec(cur('d DECIMAL(5,2) DEFAULT -12.50')).default).toEqual({ kind: 'number', value: '-12.50' });
  });
});
