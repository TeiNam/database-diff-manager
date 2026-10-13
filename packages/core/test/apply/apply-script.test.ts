import { describe, expect, it } from 'vitest';
import { applyScript, MYSQL_DEFAULTS, resolveDefaults } from '../../src/apply';
import { ApplyFailure } from '../../src/apply/types';
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
