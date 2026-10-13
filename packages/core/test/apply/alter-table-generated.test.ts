// ALTER TABLE — 생성 컬럼·AUTO_INCREMENT·TEXT 계열 컬럼의 SET DEFAULT, 생성 컬럼 MODIFY, FLOAT AUTO_INCREMENT (MySQL 8.0.46·8.4.11 실측)
import { describe, expect, it } from 'vitest';
import { applyScript } from '../../src/apply';
import type { SchemaModel, Table } from '../../src/model';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

const tbl = (r: { model: SchemaModel }, name: string): Table => r.model.tables.find((t) => t.name === name)!;
const col = (r: { model: SchemaModel }, table: string, name: string) => tbl(r, table).columns.find((c) => c.name === name)!;

// 생성 컬럼·AUTO_INCREMENT·TEXT 계열 컬럼을 가진 테이블 (SHOW CREATE 모양). 키 순서는 MySQL 이 찍은 순서: VIRTUAL 컬럼의 키가 마지막이다
const GEN_BASE = parseSqlDump(tdExport(
  'CREATE TABLE `g` (\n  `id` int unsigned NOT NULL AUTO_INCREMENT,\n  `a` int DEFAULT NULL,\n  `v` int GENERATED ALWAYS AS ((`a` + 1)) VIRTUAL,\n  `s` int GENERATED ALWAYS AS ((`a` + 2)) STORED COMMENT \'sc\',\n  `vi` int GENERATED ALWAYS AS ((`a` * 2)) VIRTUAL,\n  `gt` text GENERATED ALWAYS AS (concat(`a`,`a`)) VIRTUAL,\n  `tx` text,\n  `tx_nn` text NOT NULL,\n  `bl` blob,\n  `js` json DEFAULT NULL,\n  `js_nn` json NOT NULL,\n  `pt` point DEFAULT NULL,\n  `pt_nn` point NOT NULL,\n  `i_nn` int NOT NULL,\n  `vc` varchar(5) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix_s` (`s`),\n  KEY `ix_v` (`v`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
)).model;
const genApply = (script: string) => applyScript(GEN_BASE, script, { schemaName: 'shop' });
const genOk = (script: string) => {
  const r = genApply(script);
  if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
  return r;
};
const genRejects = (script: string, errno: string) => expect(genApply(script)).toMatchObject({ ok: false, error: { reason: expect.stringContaining(`(MySQL ${errno})`) } });

// MySQL 8.0.46·8.4.11 실측: SET DEFAULT 는 TEXT·BLOB·JSON·GEOMETRY 에 NULL 이든 리터럴이든 1101 (NOT NULL 이어도 1067 보다 먼저, 생성 컬럼이어도 1221 보다 먼저),
// 생성 컬럼(VIRTUAL·STORED)에는 1221, AUTO_INCREMENT 컬럼은 값을 검증한 뒤 받지만 SHOW CREATE 에 기본값이 찍히지 않는다 (NULL 은 NOT NULL 이라 1067)
describe('ALTER TABLE — ALTER COLUMN … SET DEFAULT 의 대상 컬럼', () => {
  it('AUTO_INCREMENT 컬럼: 값이 올바르면 받되 기본값을 저장하지 않는다', () => {
    for (const value of ['5', "'7'", 'TRUE']) {
      const c = col(genOk(`ALTER TABLE g ALTER COLUMN id SET DEFAULT ${value};`), 'g', 'id');
      expect(c, value).toMatchObject({ type: 'int unsigned', nullable: false, autoIncrement: true });
      expect('default' in c, value).toBe(false);
    }
    const dropped = col(genOk('ALTER TABLE g ALTER COLUMN id DROP DEFAULT;'), 'g', 'id');
    expect(dropped).toMatchObject({ nullable: false, autoIncrement: true });
    expect('default' in dropped).toBe(false);
  });

  it.each([
    ['ALTER TABLE g ALTER COLUMN id SET DEFAULT NULL;', '1067'], // AUTO_INCREMENT 는 NOT NULL
    ["ALTER TABLE g ALTER COLUMN id SET DEFAULT 'abc';", '1067'],
    ['ALTER TABLE g ALTER COLUMN id SET DEFAULT -1;', '1067'], // unsigned
  ])('AUTO_INCREMENT 컬럼의 잘못된 기본값: %s → %s', (script, errno) => {
    genRejects(script, errno);
  });

  it.each([
    ['ALTER TABLE g ALTER COLUMN v SET DEFAULT 5;'], // VIRTUAL
    ['ALTER TABLE g ALTER COLUMN v SET DEFAULT NULL;'],
    ['ALTER TABLE g ALTER COLUMN s SET DEFAULT 5;'], // STORED
    ['ALTER TABLE g ALTER COLUMN s SET DEFAULT NULL;'],
    ["ALTER TABLE g ALTER COLUMN vi SET DEFAULT 'x';"],
  ])('생성 컬럼에 SET DEFAULT 는 1221: %s', (script) => {
    genRejects(script, '1221');
  });

  it('생성 컬럼의 DROP DEFAULT 는 받고 컬럼은 그대로다', () => {
    const r = genOk('ALTER TABLE g ALTER COLUMN v DROP DEFAULT, ALTER COLUMN s DROP DEFAULT;');
    expect(col(r, 'g', 'v')).toEqual(col({ model: GEN_BASE }, 'g', 'v'));
    expect(col(r, 'g', 's')).toEqual(col({ model: GEN_BASE }, 'g', 's'));
  });

  it.each([
    ['tx', 'NULL'], ['tx_nn', 'NULL'], ['bl', 'NULL'], ['js', 'NULL'], ['js_nn', 'NULL'], ['pt', 'NULL'], ['pt_nn', 'NULL'], // NULL 도 1101 (NOT NULL 이어도)
    ['tx', "'x'"], ['tx_nn', "'x'"], ['js', "'x'"], ['pt', "'x'"], ['bl', '5'],
    ['gt', '5'], ['gt', 'NULL'], // 생성 컬럼이어도 TEXT 면 1101 이 먼저
  ])('TEXT·BLOB·JSON·GEOMETRY 컬럼 %s 에 SET DEFAULT %s 는 1101', (name, value) => {
    genRejects(`ALTER TABLE g ALTER COLUMN ${name} SET DEFAULT ${value};`, '1101');
  });

  it('그 밖의 컬럼은 그대로: NOT NULL 정수의 NULL 은 1067, 문자열·정수의 NULL 은 DEFAULT NULL', () => {
    genRejects('ALTER TABLE g ALTER COLUMN i_nn SET DEFAULT NULL;', '1067');
    expect(col(genOk('ALTER TABLE g ALTER COLUMN vc SET DEFAULT NULL;'), 'g', 'vc').default).toBe('NULL');
    expect(col(genOk('ALTER TABLE g ALTER COLUMN a SET DEFAULT 5;'), 'g', 'a').default).toBe("'5'");
  });
});

// MySQL 8.0.46·8.4.11 실측: VIRTUAL 생성 컬럼을 AS 없이 MODIFY·CHANGE 하면 3106 ('Changing the STORED status' is not supported),
// STORED 생성 컬럼은 일반 컬럼으로 바뀐다 (정의가 통째로 바뀌므로 COMMENT 도 사라진다). 이름만 바꾸거나 보이기만 바꾸는 절은 생성 컬럼을 그대로 둔다
describe('ALTER TABLE — 생성 컬럼을 MODIFY·CHANGE', () => {
  it.each([
    ['ALTER TABLE g MODIFY v INT;'],
    ['ALTER TABLE g MODIFY v INT NOT NULL;'],
    ['ALTER TABLE g MODIFY v BIGINT;'],
    ['ALTER TABLE g CHANGE v v2 INT;'],
    ['ALTER TABLE g MODIFY v INT FIRST;'],
    ['ALTER TABLE g MODIFY vi INT;'],
    ['ALTER TABLE g MODIFY v INT, MODIFY s INT;'], // 한 절이라도 걸리면 문장 전체가 실패한다
  ])('VIRTUAL 생성 컬럼은 일반 컬럼으로 바꿀 수 없다 (3106): %s', (script) => {
    genRejects(script, '3106');
  });

  it('STORED 생성 컬럼은 일반 컬럼이 된다: 새 정의 그대로 (COMMENT 는 사라지고 키는 남는다)', () => {
    const plain = col(genOk('ALTER TABLE g MODIFY s INT;'), 'g', 's');
    expect(plain).toEqual({ name: 's', type: 'int', nullable: true, invisible: false, autoIncrement: false, default: 'NULL' });
    expect(col(genOk('ALTER TABLE g MODIFY s INT NOT NULL;'), 'g', 's')).toMatchObject({ nullable: false });
    expect(col(genOk('ALTER TABLE g MODIFY s INT DEFAULT 5;'), 'g', 's').default).toBe("'5'");
    expect(col(genOk('ALTER TABLE g MODIFY s BIGINT;'), 'g', 's').type).toBe('bigint');
    const first = genOk('ALTER TABLE g MODIFY s INT FIRST;');
    expect(tbl(first, 'g').columns[0].name).toBe('s');
    const renamed = genOk('ALTER TABLE g CHANGE s s2 INT;');
    expect(col(renamed, 'g', 's2').generated).toBeUndefined();
    expect(tbl(renamed, 'g').indexes.find((i) => i.name === 'ix_s')!.parts.map((p) => p.column)).toEqual(['s2']);
  });

  it('이름 바꾸기·보이기·DROP 은 생성 컬럼을 그대로 둔다', () => {
    const renamed = genOk('ALTER TABLE g RENAME COLUMN v TO v2;');
    expect(col(renamed, 'g', 'v2').generated).toEqual({ expr: '(`a` + 1)', stored: false });
    expect(tbl(renamed, 'g').indexes.find((i) => i.name === 'ix_v')!.parts.map((p) => p.column)).toEqual(['v2']);
    expect(col(genOk('ALTER TABLE g ALTER COLUMN v SET INVISIBLE;'), 'g', 'v')).toMatchObject({ invisible: true, generated: { stored: false } });
    expect(tbl(genOk('ALTER TABLE g DROP COLUMN v;'), 'g').columns.some((c) => c.name === 'v')).toBe(false);
    genRejects('ALTER TABLE g DROP COLUMN a;', '3108'); // 생성 컬럼이 쓰는 컬럼
  });
});

// MySQL 실측: FLOAT·DOUBLE AUTO_INCREMENT 는 8.0.46 이 받고 8.4.11 은 1063 (생성·ADD·MODIFY·CHANGE 모두). 스펙은 8.4 호환이라 문장이 쓰면 거부하고,
// 8.0 덤프라서 이미 있는 FLOAT AUTO_INCREMENT 컬럼은 문장이 다시 정의하지 않는 한 다시 검사하지 않는다
describe('ALTER TABLE — FLOAT·DOUBLE AUTO_INCREMENT (8.4 규칙)', () => {
  const FLOAT_BASE = parseSqlDump(tdExport(
    'CREATE TABLE `fl` (\n  `f` float NOT NULL AUTO_INCREMENT,\n  `k` int DEFAULT NULL,\n  `n` int DEFAULT NULL,\n  KEY `f` (`f`),\n  KEY `k` (`k`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  )).model;
  const runFl = (script: string) => applyScript(FLOAT_BASE, script, { schemaName: 'shop' });
  const okFl = (script: string) => {
    const r = runFl(script);
    if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
    return r;
  };
  const SUFFIX = '(MySQL 8.4 1063 — 8.0 은 받지만 1차에서는 8.4 규칙을 따릅니다)';

  it.each([
    ['ALTER TABLE fl ADD COLUMN z float AUTO_INCREMENT, ADD KEY (z);'],
    ['ALTER TABLE fl ADD COLUMN z double AUTO_INCREMENT, ADD KEY (z);'],
    ['ALTER TABLE fl MODIFY k float AUTO_INCREMENT;'], // 기존 정수 컬럼에 AUTO_INCREMENT 와 실수 타입을 함께
    ['ALTER TABLE fl MODIFY f float NOT NULL AUTO_INCREMENT;'], // 이미 있는 컬럼을 다시 정의하면 검사한다
    ['ALTER TABLE fl CHANGE k k2 double AUTO_INCREMENT;'],
  ])('문장이 쓴 FLOAT·DOUBLE AUTO_INCREMENT 는 거부: %s', (script) => {
    expect(runFl(script)).toMatchObject({ ok: false, error: { reason: expect.stringContaining(SUFFIX) } });
  });

  it('AUTO_INCREMENT 가 아니면 FLOAT 로 바꿀 수 있고, 정수 AUTO_INCREMENT 와 DECIMAL 의 1063 은 그대로다', () => {
    expect(col(okFl('ALTER TABLE fl MODIFY k float;'), 'fl', 'k')).toMatchObject({ type: 'float', autoIncrement: false });
    expect(col(okFl('ALTER TABLE fl MODIFY f double;'), 'fl', 'f')).toMatchObject({ type: 'double', autoIncrement: false, nullable: true, default: 'NULL' }); // AUTO_INCREMENT 를 쓰지 않으니 사라진다
    expect(col(okFl('ALTER TABLE fl MODIFY f bigint unsigned AUTO_INCREMENT;'), 'fl', 'f')).toMatchObject({ type: 'bigint unsigned', autoIncrement: true, nullable: false });
    expect(runFl('ALTER TABLE fl MODIFY f decimal(10,0) AUTO_INCREMENT;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('(MySQL 1063)') } });
  });

  it('덤프에 이미 있는 FLOAT AUTO_INCREMENT 컬럼은 건드리지 않는 문장에서 다시 검사하지 않는다', () => {
    for (const script of [
      "ALTER TABLE fl COMMENT = 'x';",
      'ALTER TABLE fl ADD COLUMN z INT;',
      'ALTER TABLE fl RENAME COLUMN f TO g;',
      'ALTER TABLE fl ALTER COLUMN f SET INVISIBLE;',
      'ALTER TABLE fl ADD INDEX (n);',
      'ALTER TABLE fl MODIFY n bigint;',
    ]) {
      expect(col(okFl(script), 'fl', script.includes('RENAME COLUMN') ? 'g' : 'f'), script).toMatchObject({ type: 'float', autoIncrement: true, nullable: false });
    }
  });
});
