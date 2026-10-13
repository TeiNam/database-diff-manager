import { describe, expect, it } from 'vitest';
import { applySet } from '../../src/apply/session';
import { initialState, type State } from '../../src/apply/state';
import { ApplyFailure, DEFAULT_SQL_MODE, MYSQL_DEFAULTS, RE_EXPORT } from '../../src/apply/types';
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

const freshState = () => initialState(empty, 'shop', MYSQL_DEFAULTS, DEFAULT_SQL_MODE);
const setIn = (st: State, sql: string) => applySet(st, new Cursor(tokenize(sql), sql));
const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('예외가 나지 않았습니다');
};

// MySQL 8.0.46 실측: 값으로 쓴 단어 ON·OFF·TRUE·FALSE(대소문자 무관)와 숫자 0·1 을 받고, 따옴표를 친 'TRUE'·'FALSE'·'0'·'1' 은 1231 로 거부한다.
// 따옴표 친 형태는 받아도 해가 없어 함께 받는다. 2·NULL·그 밖의 값은 1231
describe('SET FOREIGN_KEY_CHECKS 값', () => {
  it.each([['FALSE'], ['false'], ["'FALSE'"], ['0'], ['OFF'], ['off'], ["'Off'"]])('= %s 는 검사를 끈다', (value) => {
    const st = freshState();
    setIn(st, `SET FOREIGN_KEY_CHECKS = ${value}`);
    expect(st.fkChecks).toBe(false);
  });

  it.each([['TRUE'], ['true'], ["'TRUE'"], ['1'], ['ON'], ['on'], ["'On'"]])('= %s 는 검사를 켠다', (value) => {
    const st = freshState();
    setIn(st, 'SET FOREIGN_KEY_CHECKS = 0');
    setIn(st, `SET FOREIGN_KEY_CHECKS = ${value}`);
    expect(st.fkChecks).toBe(true);
  });

  it('SESSION·@@session.·@변수 형태도 같다', () => {
    const st = freshState();
    setIn(st, 'SET SESSION foreign_key_checks = FALSE');
    expect(st.fkChecks).toBe(false);
    setIn(st, 'SET @@session.foreign_key_checks = TRUE');
    expect(st.fkChecks).toBe(true);
    setIn(st, 'SET @fk = FALSE, FOREIGN_KEY_CHECKS = @fk');
    expect(st.fkChecks).toBe(false);
  });

  it.each([['2'], ['NULL'], ["'x'"], ["''"], ['maybe']])('= %s 는 거부하고 값을 바꾸지 않는다 (MySQL 1231)', (value) => {
    const st = freshState();
    expect(messageOf(() => setIn(st, `SET FOREIGN_KEY_CHECKS = ${value}`))).toContain('(MySQL 1231)');
    expect(st.fkChecks).toBe(true);
  });

  // MySQL 8.0.46 은 foreign_key_checks 에 DEFAULT 를 주면 0(꺼짐)으로 만든다 — 켜진 기본값을 따르는 값이 아니고 버전마다 달라질 수 있어 받지 않는다
  it('= DEFAULT 는 거부한다', () => {
    const st = freshState();
    expect(() => setIn(st, 'SET FOREIGN_KEY_CHECKS = DEFAULT')).toThrow(ApplyFailure);
    expect(st.fkChecks).toBe(true);
  });
});

const SQL_MODE_NAMES = [
  'REAL_AS_FLOAT', 'PIPES_AS_CONCAT', 'ANSI_QUOTES', 'IGNORE_SPACE', 'NOT_USED', 'ONLY_FULL_GROUP_BY', 'NO_UNSIGNED_SUBTRACTION', 'NO_DIR_IN_CREATE', 'ANSI',
  'NO_AUTO_VALUE_ON_ZERO', 'NO_BACKSLASH_ESCAPES', 'STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES', 'NO_ZERO_IN_DATE', 'NO_ZERO_DATE', 'ALLOW_INVALID_DATES',
  'ERROR_FOR_DIVISION_BY_ZERO', 'TRADITIONAL', 'HIGH_NOT_PRECEDENCE', 'NO_ENGINE_SUBSTITUTION', 'PAD_CHAR_TO_FULL_LENGTH', 'TIME_TRUNCATE_FRACTIONAL',
];

// 순서 바로잡기·ANSI/TRADITIONAL 풀어쓰기는 하지 않는다 (MySQL 과 비교하는 Task 9 에서 정한다)
describe('SET SQL_MODE 값', () => {
  it.each(SQL_MODE_NAMES)('%s 는 소문자로 써도 받는다', (name) => {
    const st = freshState();
    setIn(st, `SET SQL_MODE = '${name.toLowerCase()}'`);
    expect(st.sqlMode).toBe(name);
  });

  it('td-export 헤더·트레일러의 저장·복원이 그대로 된다', () => {
    const st = freshState();
    setIn(st, "SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO'");
    expect(st.sqlMode).toBe('NO_AUTO_VALUE_ON_ZERO');
    setIn(st, 'SET SQL_MODE = @OLD_SQL_MODE');
    expect(st.sqlMode).toBe(DEFAULT_SQL_MODE);
  });

  // MySQL 8.0.46 실측: '' · ',' 는 모드 없음, 'A,' · ',A' · 'A,,B' 의 빈 항목은 건너뛴다
  it('빈 값과 빈 항목은 MySQL 처럼 건너뛴다', () => {
    const st = freshState();
    setIn(st, "SET SQL_MODE = ''");
    expect(st.sqlMode).toBe('');
    setIn(st, "SET SQL_MODE = 'STRICT_TRANS_TABLES,'");
    expect(st.sqlMode).toBe('STRICT_TRANS_TABLES');
    setIn(st, "SET SQL_MODE = ',,'");
    expect(st.sqlMode).toBe('');
  });

  it.each([["'FOO'"], ["'STRICT_TRANS_TABLES,FOO'"], ['NULL'], ["'MAXDB'"], ["'NO_AUTO_CREATE_USER'"], ["'STRICT_TRANS_TABLES, ANSI_QUOTES'"], ["' ANSI_QUOTES'"], ['ON']])(
    '= %s 는 거부하고 값을 바꾸지 않는다 (MySQL 1231)', (value) => {
      const st = freshState();
      expect(messageOf(() => setIn(st, `SET SQL_MODE = ${value}`))).toContain('(MySQL 1231)');
      expect(st.sqlMode).toBe(DEFAULT_SQL_MODE);
    });
});

// 이 변수를 바꾸면 이후 CREATE TABLE 의 결과나 허용 여부가 달라진다 — 무시하면 MySQL 과 다른 모델이 나온다
const SCHEMA_VARIABLES = [
  'default_storage_engine', 'storage_engine', 'explicit_defaults_for_timestamp', 'sql_require_primary_key', 'sql_generate_invisible_primary_key',
  'restrict_fk_on_non_standard_key', 'default_collation_for_utf8mb4', 'character_set_database', 'collation_database', 'innodb_strict_mode',
];

describe('이후 테이블 정의를 바꾸는 세션 변수', () => {
  it.each(SCHEMA_VARIABLES)('SET %s 는 조용히 넘기지 않고 다시 뽑아 올리라고 안내한다', (name) => {
    const message = messageOf(() => setIn(freshState(), `SET ${name} = 1`));
    expect(message).toContain(name);
    expect(message.endsWith(RE_EXPORT)).toBe(true);
  });

  it('SESSION·LOCAL·@@·@@session.·@@local. 형태, 대문자, 목록 가운데에 있어도 거부한다', () => {
    for (const sql of [
      'SET SESSION default_storage_engine = MyISAM', 'SET LOCAL default_storage_engine = MyISAM', 'SET @@default_storage_engine = MyISAM',
      'SET @@session.default_storage_engine = MyISAM', 'SET @@local.default_storage_engine = MyISAM', 'SET Default_Storage_Engine = MyISAM',
      "SET NAMES utf8mb4, time_zone = '+00:00', sql_require_primary_key = ON", 'SET @@session.innodb_strict_mode = OFF',
    ]) {
      expect(messageOf(() => setIn(freshState(), sql)), sql).toContain(RE_EXPORT);
    }
  });

  it('스키마에 영향이 없는 다른 변수는 그대로 무시한다', () => {
    const st = freshState();
    setIn(st, "SET time_zone = '+00:00', unique_checks = 0, autocommit = 1, @@session.sql_notes = 0, default_tmp_storage_engine = InnoDB, lc_time_names = 'ko_KR'");
    expect(st.fkChecks).toBe(true);
    expect(st.sqlMode).toBe(DEFAULT_SQL_MODE);
  });
});

// GLOBAL·PERSIST 는 세션 값이 아니라 서버 값을 바꾼다 — 세션 상태(FOREIGN_KEY_CHECKS·SQL_MODE)에 반영하면 MySQL 과 달라진다
describe('SET 범위', () => {
  it.each([
    ['SET GLOBAL foreign_key_checks = 0'], ['SET PERSIST foreign_key_checks = 0'], ['SET PERSIST_ONLY foreign_key_checks = 0'],
    ['SET @@global.foreign_key_checks = 0'], ['SET @@persist.foreign_key_checks = 0'], ["SET @@persist_only.sql_mode = 'ANSI_QUOTES'"],
  ])('%s 는 받지 않는다', (sql) => {
    const st = freshState();
    expect(() => setIn(st, sql)).toThrow(ApplyFailure);
    expect(st.fkChecks).toBe(true);
    expect(st.sqlMode).toBe(DEFAULT_SQL_MODE);
  });
});
