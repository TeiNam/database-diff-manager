import { describe, expect, it } from 'vitest';
import { applySet } from '../../src/apply/session';
import { initialState } from '../../src/apply/state';
import { ApplyFailure, DEFAULT_SQL_MODE, MYSQL_DEFAULTS } from '../../src/apply/types';
import { Cursor } from '../../src/cursor';
import { tokenize } from '../../src/lexer';

const empty = { name: 'shop', tables: [], views: [], routines: [] };

describe('SET 문', () => {
  it('FOREIGN_KEY_CHECKS 의 @OLD_ 저장·복원과 SQL_MODE (DEFAULT 포함)를 따른다', () => {
    const st = initialState(empty, 'shop', MYSQL_DEFAULTS, DEFAULT_SQL_MODE);
    const set = (sql: string) => applySet(st, new Cursor(tokenize(sql), sql));
    set('SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0');
    expect(st.fkChecks).toBe(false);
    set('SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS');
    expect(st.fkChecks).toBe(true);
    set("SET SESSION sql_mode = 'ansi_quotes,strict_trans_tables'");
    expect(st.sqlMode).toBe('ANSI_QUOTES,STRICT_TRANS_TABLES');
    set('SET @@session.sql_mode = DEFAULT');
    expect(st.sqlMode).toBe(DEFAULT_SQL_MODE);
    set("SET NAMES utf8mb4, time_zone = '+00:00'");
    expect(st.fkChecks).toBe(true);
  });

  it('GLOBAL·식 값·저장하지 않은 변수는 거부한다', () => {
    const st = initialState(empty, 'shop', MYSQL_DEFAULTS, DEFAULT_SQL_MODE);
    const set = (sql: string) => () => applySet(st, new Cursor(tokenize(sql), sql));
    expect(set('SET GLOBAL foreign_key_checks = 0')).toThrow(ApplyFailure);
    expect(set("SET sql_mode = CONCAT(@@sql_mode, ',X')")).toThrow(ApplyFailure);
    expect(set('SET FOREIGN_KEY_CHECKS = @never_saved')).toThrow(ApplyFailure);
  });
});
