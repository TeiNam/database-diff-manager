import { describe, expect, it } from 'vitest';
import { applyScript, MYSQL_DEFAULTS, resolveDefaults } from '../../src/apply';
import { ApplyFailure, RE_EXPORT } from '../../src/apply/types';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

const base = parseSqlDump(tdExport('CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\n')).model;
const run = (script: string) => applyScript(base, script, { schemaName: 'shop' });

describe('applyScript — 문장 처리', () => {
  it('SET·USE·주석만 있으면 적용할 문장이 없다', () => {
    expect(run('SET NAMES utf8mb4; SET FOREIGN_KEY_CHECKS = 0; USE shop; -- 주석\n')).toEqual({ ok: false, error: { index: 0, line: 1, statement: '', reason: '적용할 DDL 문장이 없습니다' } });
  });

  it('지원하지 않는 문장·다른 스키마 USE·VIEW 는 그 문장 번호·줄과 함께 실패한다', () => {
    expect(run('SET NAMES utf8mb4;\nINSERT INTO t VALUES (1);')).toMatchObject({ ok: false, error: { index: 2, line: 2, statement: 'INSERT INTO t VALUES (1)' } });
    expect(run('USE other;')).toMatchObject({ ok: false, error: { index: 1 } });
    expect(run('CREATE OR REPLACE VIEW v AS SELECT 1;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('VIEW') } });
  });

  it('닫히지 않은 따옴표는 문장으로 나누지 못한다', () => {
    expect(run("ALTER TABLE t COMMENT 'x;")).toMatchObject({ ok: false, error: { index: 0, reason: expect.stringContaining('나누지 못했습니다') } });
  });

  it('입력 모델을 바꾸지 않고, 맞지 않는 스키마 기본값은 거부한다', () => {
    const before = JSON.stringify(base);
    run('INSERT INTO t VALUES (1);');
    expect(JSON.stringify(base)).toBe(before);
    expect(applyScript(base, 'SET NAMES utf8mb4;', { schemaName: 'shop', defaults: { charset: 'latin1', collation: 'utf8mb4_bin' } })).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1253') } });
  });
});

// mysqldump 머리·꼬리의 '/*!40101 SET … */;' 꼴: 문장 나누기가 여는 표지(/*!40101)만 떼고 닫는 '*/' 를 문장 끝에 남긴다. 실행 주석 안의 문장은 MySQL 이 그대로 실행하므로
// 닫는 '*/' 를 떼고 읽는다 (SET 이면 무시/세션 값, 그 밖의 문장이면 그 문장)
describe('applyScript — 실행 주석(/*!NNNNN … */)으로 감싼 문장', () => {
  it('mysqldump 의 SET 머리·꼬리는 SET 처럼 읽고, FOREIGN_KEY_CHECKS 는 따라간다', () => {
    const script = [
      '/*!40101 SET @saved_cs_client     = @@character_set_client */;', '/*!50503 SET character_set_client = utf8mb4 */;',
      '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;',
      'CREATE TABLE u (id INT, ref INT, FOREIGN KEY (ref) REFERENCES missing (id));', // FOREIGN_KEY_CHECKS=0 이라 부모가 없어도 된다
      '/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;', '/*!40101 SET character_set_client = @saved_cs_client */;',
    ].join('\n');
    const r = run(script);
    expect(r).toMatchObject({ ok: true, applied: 1 });
    if (r.ok) expect(r.model.tables.map((t) => t.name)).toEqual(['t', 'u']);
    expect(run('/*!40014 SET FOREIGN_KEY_CHECKS=0 */;\n/*!40014 SET FOREIGN_KEY_CHECKS=1 */;\nCREATE TABLE v (id INT, ref INT, FOREIGN KEY (ref) REFERENCES missing (id));')).toMatchObject({ ok: false, error: { index: 3 } });
  });

  it('SET 이 아닌 문장도 실행 주석 안이면 그 문장으로 적용한다 (번호가 없는 /*! 도 같다)', () => {
    const r = run('/*!40000 ALTER TABLE t ADD COLUMN x INT */;\n/*! ALTER TABLE t ADD COLUMN y INT */;');
    expect(r).toMatchObject({ ok: true, applied: 2 });
    if (r.ok) expect(r.model.tables[0].columns.map((c) => c.name)).toEqual(['id', 'x', 'y']);
  });

  it('문장 끝의 일반 주석 */ 는 건드리지 않는다', () => {
    expect(run('ALTER TABLE t ADD COLUMN x INT /* note */;')).toMatchObject({ ok: true, applied: 1 });
    expect(run('ALTER TABLE t ADD COLUMN x INT COMMENT \'a */\';')).toMatchObject({ ok: true, applied: 1 });
  });
});

// 4바이트 문자(이모지 등, U+10000 이상): MySQL 8.0.46·8.4.11 의 SHOW CREATE 는 COMMENT·ENUM·SET 값의 그 문자를 '?' 로, 문자열 DEFAULT 는 통째로 16진수(0xF09F9880)로 바꿔 찍는다.
// 그대로 저장하면 재추출한 덤프와 달라지므로 RE_EXPORT 로 거부한다. 루틴 본문은 쓴 그대로 찍히니 상관없고, 루틴 COMMENT 는 '?' 로 찍힌다
describe('applyScript — 4바이트 문자', () => {
  it.each([
    ["ALTER TABLE t ADD COLUMN c VARCHAR(10) DEFAULT '😀';"],
    ["ALTER TABLE t ADD COLUMN c VARCHAR(10) DEFAULT '한글😀';"],
    ["ALTER TABLE t ADD COLUMN c INT COMMENT '😀 상태';"],
    ["ALTER TABLE t COMMENT = '😀';"],
    ["ALTER TABLE t ADD COLUMN c ENUM('a','😀');"],
    ["ALTER TABLE t ADD INDEX ix (id) COMMENT '😀';"],
    ["CREATE TABLE u (id INT) COMMENT='😀';"],
    ["CREATE TABLE u (id INT COMMENT '😀');"],
    ["CREATE FUNCTION f() RETURNS INT DETERMINISTIC COMMENT '😀' RETURN 1;"],
  ])('%s 는 RE_EXPORT 로 끝나는 안내로 거부', (script) => {
    const r = run(script);
    expect(r).toMatchObject({ ok: false, error: { index: 1 } });
    if (!r.ok) {
      expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
      expect(r.error.reason).toContain('4바이트');
    }
  });

  it('BMP 문자(한글·유럽 문자·€·U+FFFF)와 루틴 본문 속 이모지는 받는다', () => {
    expect(run("ALTER TABLE t ADD COLUMN c VARCHAR(10) DEFAULT 'é한€\uffff' COMMENT 'ǆ 설명';")).toMatchObject({ ok: true, applied: 1 });
    const r = run("CREATE FUNCTION g() RETURNS VARCHAR(5) DETERMINISTIC RETURN '😀';");
    expect(r).toMatchObject({ ok: true, applied: 1 });
    if (r.ok) expect(r.model.routines[0].body).toBe("RETURN '😀'");
  });
});

const NO_STATEMENT = { ok: false, error: { index: 0, line: 1, statement: '', reason: '적용할 DDL 문장이 없습니다' } };

describe('resolveDefaults — 스키마 기본 문자셋·콜레이션', () => {
  it('안 준 값(undefined 포함)은 MySQL 기본값이다', () => {
    expect(resolveDefaults(undefined)).toEqual(MYSQL_DEFAULTS);
    expect(resolveDefaults({})).toEqual(MYSQL_DEFAULTS);
    expect(resolveDefaults({ charset: undefined })).toEqual(MYSQL_DEFAULTS);
    expect(resolveDefaults({ charset: undefined, collation: undefined })).toEqual(MYSQL_DEFAULTS);
  });

  it('문자셋만 주면 그 문자셋의 기본 콜레이션, 콜레이션만 주면 그 콜레이션의 문자셋을 쓴다', () => {
    expect(resolveDefaults({ charset: 'latin1' })).toEqual({ charset: 'latin1', collation: 'latin1_swedish_ci' });
    expect(resolveDefaults({ charset: 'UTF8' })).toEqual({ charset: 'utf8mb3', collation: 'utf8mb3_general_ci' });
    expect(resolveDefaults({ charset: 'utf8mb4', collation: undefined })).toEqual({ charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' });
    expect(resolveDefaults({ collation: 'latin1_bin' })).toEqual({ charset: 'latin1', collation: 'latin1_bin' });
    expect(resolveDefaults({ charset: undefined, collation: 'utf8_general_ci' })).toEqual({ charset: 'utf8mb3', collation: 'utf8mb3_general_ci' });
  });

  it('둘 다 주면 이름을 MySQL 표기로 맞추고 서로 맞는지 본다', () => {
    expect(resolveDefaults({ charset: 'LATIN1', collation: 'Latin1_Bin' })).toEqual({ charset: 'latin1', collation: 'latin1_bin' });
    expect(() => resolveDefaults({ charset: 'latin1', collation: 'utf8mb4_bin' })).toThrow(/\(MySQL 1253\)/);
    expect(() => resolveDefaults({ charset: 'nope' })).toThrow(/\(MySQL 1115\)/);
    expect(() => resolveDefaults({ collation: 'nope_ci' })).toThrow(/\(MySQL 1273\)/);
    expect(() => resolveDefaults({ charset: 'latin1', collation: 'nope_ci' })).toThrow(ApplyFailure);
  });

  it('applyScript 는 undefined 가 든 defaults 로도 던지지 않고, 문자셋만 줘도 맞는 콜레이션을 쓴다', () => {
    expect(applyScript(base, 'SET NAMES utf8mb4;', { schemaName: 'shop', defaults: { charset: undefined } })).toEqual(NO_STATEMENT);
    expect(applyScript(base, 'SET NAMES utf8mb4;', { schemaName: 'shop', defaults: { charset: 'latin1' } })).toEqual(NO_STATEMENT);
    expect(applyScript(base, 'SET NAMES utf8mb4;', { schemaName: 'shop', defaults: { collation: 'latin1_bin' } })).toEqual(NO_STATEMENT);
  });
});
