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

// MySQL 8.0.46 실측: 모든 이름을 거꾸로 써서 SET 한 뒤 @@sql_mode 가 낸 순서 (SHOW CREATE 의 sql_mode 도 이 순서다)
const SQL_MODE_NAMES = [
  'REAL_AS_FLOAT', 'PIPES_AS_CONCAT', 'ANSI_QUOTES', 'IGNORE_SPACE', 'NOT_USED', 'ONLY_FULL_GROUP_BY', 'NO_UNSIGNED_SUBTRACTION', 'NO_DIR_IN_CREATE', 'ANSI',
  'NO_AUTO_VALUE_ON_ZERO', 'NO_BACKSLASH_ESCAPES', 'STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES', 'NO_ZERO_IN_DATE', 'NO_ZERO_DATE', 'ALLOW_INVALID_DATES',
  'ERROR_FOR_DIVISION_BY_ZERO', 'TRADITIONAL', 'HIGH_NOT_PRECEDENCE', 'NO_ENGINE_SUBSTITUTION', 'PAD_CHAR_TO_FULL_LENGTH', 'TIME_TRUNCATE_FRACTIONAL',
];
// 다른 모드 여럿을 묶은 이름: MySQL 은 풀어 쓴 값을 내는데 그걸 재현하지 않고 거부한다
const COMBINATION_MODES = ['ANSI', 'TRADITIONAL'];
const SINGLE_MODES = SQL_MODE_NAMES.filter((name) => !COMBINATION_MODES.includes(name));

describe('SET SQL_MODE 값', () => {
  it.each(SINGLE_MODES)('%s 는 소문자로 써도 받는다', (name) => {
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

// 루틴은 만들 때의 sql_mode 를 기억하고 SHOW CREATE 는 MySQL 순서로 한 번씩만 낸다 (8.0.46 실측: 'NO_ENGINE_SUBSTITUTION,STRICT_TRANS_TABLES,ONLY_FULL_GROUP_BY,
// strict_trans_tables,NO_ZERO_DATE' → 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION'). 쓴 순서를 그대로 두면 같은 모드가 다른 값으로 보인다
describe('SET SQL_MODE 순서', () => {
  it('쓴 순서와 상관없이 MySQL 순서로 저장하고 같은 이름(대소문자 무시)은 한 번만 쓴다', () => {
    const st = freshState();
    setIn(st, "SET SQL_MODE = 'NO_ENGINE_SUBSTITUTION,STRICT_TRANS_TABLES,ONLY_FULL_GROUP_BY,strict_trans_tables,NO_ZERO_DATE'");
    expect(st.sqlMode).toBe('ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION');
  });

  it('묶음이 아닌 모든 이름을 거꾸로 써도 MySQL 순서로 돌아온다', () => {
    const st = freshState();
    setIn(st, `SET SQL_MODE = '${[...SINGLE_MODES].reverse().join(',')}'`);
    expect(st.sqlMode).toBe(SINGLE_MODES.join(','));
  });

  it('기본 모드를 거꾸로 써도 DEFAULT 와 같은 값이다', () => {
    const st = freshState();
    setIn(st, `SET SQL_MODE = '${DEFAULT_SQL_MODE.split(',').reverse().join(',')}'`);
    expect(st.sqlMode).toBe(DEFAULT_SQL_MODE);
  });

  it('@@SQL_MODE 로 저장했다 되돌려도 같은 값이다', () => {
    const st = freshState();
    setIn(st, "SET @OLD_MODE = @@SQL_MODE, SQL_MODE = 'NO_BACKSLASH_ESCAPES,ANSI_QUOTES'");
    expect(st.sqlMode).toBe('ANSI_QUOTES,NO_BACKSLASH_ESCAPES');
    setIn(st, 'SET @CUR_MODE = @@SQL_MODE, SQL_MODE = @OLD_MODE');
    expect(st.sqlMode).toBe(DEFAULT_SQL_MODE);
    setIn(st, 'SET SQL_MODE = @CUR_MODE');
    expect(st.sqlMode).toBe('ANSI_QUOTES,NO_BACKSLASH_ESCAPES');
  });
});

// ANSI·TRADITIONAL 은 다른 모드 여럿을 묶은 이름이라 MySQL 이 풀어 쓴 값(자기 이름도 남긴다)을 낸다. 그 규칙은 재현하지 않고 다시 뽑아 올리라고 안내한다.
// 8.0 에서 없어진 묶음(ORACLE·DB2·MAXDB 등)은 MySQL 도 1231 로 거부한다
describe('SET SQL_MODE 묶음 모드', () => {
  it.each(COMBINATION_MODES)('묶음 모드 %s: 소문자·다른 모드와 함께 써도 거부하고 값을 바꾸지 않는다', (name) => {
    for (const value of [name, name.toLowerCase(), `STRICT_TRANS_TABLES,${name}`, `${name},NO_ENGINE_SUBSTITUTION`]) {
      const st = freshState();
      const message = messageOf(() => setIn(st, `SET SQL_MODE = '${value}'`));
      expect(message, value).toContain(name);
      expect(message.endsWith(RE_EXPORT), value).toBe(true);
      expect(st.sqlMode).toBe(DEFAULT_SQL_MODE);
    }
  });

  it.each([['ORACLE'], ['DB2'], ['MSSQL'], ['POSTGRESQL']])('%s 는 8.0 에 없는 이름이라 1231 이다', (name) => {
    expect(messageOf(() => setIn(freshState(), `SET SQL_MODE = '${name}'`))).toContain('(MySQL 1231)');
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
