import { describe, expect, it } from 'vitest';
import { applyScript, type ApplyResult } from '../../src/apply';
import { applySet, resolveSqlMode } from '../../src/apply/session';
import { initialState, type State } from '../../src/apply/state';
import { ApplyFailure, DEFAULT_SQL_MODE, MYSQL_DEFAULTS, RE_EXPORT } from '../../src/apply/types';
import { Cursor } from '../../src/cursor';
import { tokenize } from '../../src/lexer';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

const empty = { name: 'shop', tables: [], views: [], routines: [] };

describe('SET 문', () => {
  it('FOREIGN_KEY_CHECKS 의 @OLD_ 저장·복원과 SQL_MODE (DEFAULT 포함)를 따른다', () => {
    const st = initialState(empty, 'shop', MYSQL_DEFAULTS, DEFAULT_SQL_MODE);
    const set = (sql: string) => applySet(st, new Cursor(tokenize(sql), sql));
    set('SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0');
    expect(st.fkChecks).toBe(false);
    set('SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS');
    expect(st.fkChecks).toBe(true);
    set("SET SESSION sql_mode = 'no_zero_date,strict_trans_tables'");
    expect(st.sqlMode).toBe('STRICT_TRANS_TABLES,NO_ZERO_DATE');
    set('SET @@session.sql_mode = DEFAULT');
    expect(st.sqlMode).toBe(DEFAULT_SQL_MODE);
    set("SET NAMES utf8mb4, time_zone = '+00:00'");
    expect(st.fkChecks).toBe(true);
  });

  it('세션 변수의 식 값은 거부하고, 저장하지 않은 변수에서 정한 값은 그 까닭과 함께 모르는 값으로 둔다 (리뷰 10회차)', () => {
    const st = initialState(empty, 'shop', MYSQL_DEFAULTS, DEFAULT_SQL_MODE);
    const set = (sql: string) => () => applySet(st, new Cursor(tokenize(sql), sql));
    expect(set("SET sql_mode = CONCAT(@@sql_mode, ',X')")).toThrow(ApplyFailure);
    expect(set("SET sql_mode = REPLACE(@@sql_mode, 'NO_ZERO_DATE', '')")).toThrow(ApplyFailure);
    expect(set('SET FOREIGN_KEY_CHECKS = @never_saved')).not.toThrow();
    expect(st.fkChecksUnknown).toBe('앞의 `SET FOREIGN_KEY_CHECKS = @never_saved` 문장이 세션 FOREIGN_KEY_CHECKS 를 알 수 없는 값으로 정했습니다 — 값을 저장하지 않은 변수입니다: @never_saved');
    set('SET FOREIGN_KEY_CHECKS = 0')();
    expect(st).toMatchObject({ fkChecks: false, fkChecksUnknown: undefined });
  });
});

const freshState = () => initialState(empty, 'shop', MYSQL_DEFAULTS, DEFAULT_SQL_MODE);
const setIn = (st: State, sql: string) => applySet(st, new Cursor(tokenize(sql), sql));

// 리뷰 6회차 M-2: 세션 sql_mode 에 DEFAULT 를 주면 MySQL 은 전역 값, 곧 서버 sql_mode 로 되돌린다. 이 도구에서는 처음 세션 SQL_MODE(ApplyOptions.sqlMode —
// 서버가 기준 버전 루틴에서 짐작한 서버 sql_mode)가 그 값이다. 컴파일 기본값(DEFAULT_SQL_MODE)은 처음 값을 주지 않았을 때만이다
describe('SET sql_mode = DEFAULT', () => {
  const RELAXED = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
  const changed = () => {
    const st = initialState(empty, 'shop', MYSQL_DEFAULTS, RELAXED);
    setIn(st, "SET sql_mode = 'NO_ENGINE_SUBSTITUTION'");
    return st;
  };

  it.each([
    ['SET sql_mode = DEFAULT'], ['SET SESSION sql_mode = DEFAULT'], ['SET LOCAL sql_mode = default'], ['SET @@sql_mode = DEFAULT'],
    ['SET @@SESSION.sql_mode = DEFAULT'], ['SET @@local.SQL_MODE = DEFAULT'], ['SET NAMES utf8mb4, sql_mode = DEFAULT'],
  ])('%s 는 MySQL 기본 모드가 아니라 처음 세션 SQL_MODE 로 되돌린다', (sql) => {
    const st = changed();
    setIn(st, sql);
    expect(st.sqlMode).toBe(RELAXED);
  });

  it('SET GLOBAL sql_mode = DEFAULT 는 서버 값만 바꿔 세션 값은 그대로다', () => {
    const st = changed();
    setIn(st, 'SET GLOBAL sql_mode = DEFAULT');
    expect(st.sqlMode).toBe('NO_ENGINE_SUBSTITUTION');
  });

  it('처음 세션 SQL_MODE 가 MySQL 기본 모드면(ApplyOptions.sqlMode 를 주지 않음) 지금처럼 MySQL 기본 모드다', () => {
    const st = freshState();
    setIn(st, "SET sql_mode = 'NO_ENGINE_SUBSTITUTION'");
    setIn(st, 'SET SESSION sql_mode = DEFAULT');
    expect(st.sqlMode).toBe(DEFAULT_SQL_MODE);
  });
});
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
    setIn(st, 'SET @fk = FALSE');
    setIn(st, 'SET FOREIGN_KEY_CHECKS = @fk');
    expect(st.fkChecks).toBe(false);
    // 한 문장 안의 앞 대입은 뒤 대입이 읽는 값을 바꾸지 않는다 (리뷰 11회차 Claude F2 — 8.0.46·8.4.11 실측: 문장 전 @fk 가 1 이면 1 이다)
    setIn(st, 'SET @fk = 1');
    setIn(st, 'SET @fk = FALSE, FOREIGN_KEY_CHECKS = @fk');
    expect([st.fkChecks, st.saved.get('@fk')]).toEqual([true, 'FALSE']);
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
// 이후 테이블 정의를 다르게 읽게 하는 모드: REAL_AS_FLOAT 는 REAL 을 FLOAT 로, ANSI_QUOTES 는 "…" 를 식별자로 읽는다. 모델에 반영하지 않으므로 거부한다
const DDL_MODES = ['REAL_AS_FLOAT', 'ANSI_QUOTES'];
const SINGLE_MODES = SQL_MODE_NAMES.filter((name) => !COMBINATION_MODES.includes(name) && !DDL_MODES.includes(name));

describe('SET SQL_MODE 값', () => {
  it.each(DDL_MODES)('%s 는 이후 테이블 정의를 다르게 읽게 해 RE_EXPORT 로 거부한다 (다른 모드와 섞어 써도, 소문자여도)', (name) => {
    for (const value of [name, `STRICT_TRANS_TABLES,${name.toLowerCase()}`]) {
      const st = freshState();
      const message = messageOf(() => setIn(st, `SET SQL_MODE = '${value}'`));
      expect(message).toContain(name);
      expect(message.endsWith(RE_EXPORT), message).toBe(true);
      expect(st.sqlMode).toBe(DEFAULT_SQL_MODE);
    }
  });

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
    setIn(st, "SET @OLD_MODE = @@SQL_MODE, SQL_MODE = 'NO_BACKSLASH_ESCAPES,PIPES_AS_CONCAT'");
    expect(st.sqlMode).toBe('PIPES_AS_CONCAT,NO_BACKSLASH_ESCAPES');
    setIn(st, 'SET @CUR_MODE = @@SQL_MODE, SQL_MODE = @OLD_MODE');
    expect(st.sqlMode).toBe(DEFAULT_SQL_MODE);
    setIn(st, 'SET SQL_MODE = @CUR_MODE');
    expect(st.sqlMode).toBe('PIPES_AS_CONCAT,NO_BACKSLASH_ESCAPES');
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

// 처음 세션 SQL_MODE(ApplyOptions.sqlMode — 리뷰 5회차 M-1)와 서버의 기준 버전 루틴 SQL_MODE 짐작도 SET SQL_MODE = '…' 와 같은 검사·순서를 쓴다
describe('resolveSqlMode', () => {
  it('SET SQL_MODE 처럼 대문자·MySQL 순서로 맞추고 중복·빈 항목을 지운다', () => {
    expect(resolveSqlMode('no_zero_date,,strict_trans_tables,NO_ZERO_DATE')).toBe('STRICT_TRANS_TABLES,NO_ZERO_DATE');
    expect(resolveSqlMode('')).toBe('');
    expect(resolveSqlMode(DEFAULT_SQL_MODE)).toBe(DEFAULT_SQL_MODE);
  });

  it.each([['NO_SUCH_MODE'], ['ANSI'], ['TRADITIONAL'], ['REAL_AS_FLOAT'], ['ANSI_QUOTES']])('%s 는 SET SQL_MODE 와 같이 ApplyFailure 다', (mode) => {
    expect(() => resolveSqlMode(mode)).toThrow(ApplyFailure);
    expect(messageOf(() => resolveSqlMode(mode))).toBe(messageOf(() => setIn(freshState(), `SET SQL_MODE = '${mode}'`)));
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

// GLOBAL·PERSIST 는 세션 값이 아니라 서버 값을 바꾼다 — 이 스크립트의 세션(FOREIGN_KEY_CHECKS·SQL_MODE)은 그대로라 무시한다. 값이 식이거나
// 스키마에 영향을 주는 변수여도 세션에는 상관없다. 앞에 쓴 GLOBAL·PERSIST·SESSION 은 수식어 없는 뒤 대입에도 이어진다 (MySQL: 가장 최근 수식어를 따른다)
describe('SET 범위', () => {
  it.each([
    ['SET GLOBAL foreign_key_checks = 0'], ['SET PERSIST foreign_key_checks = 0'], ['SET PERSIST_ONLY foreign_key_checks = 0'],
    ['SET @@global.foreign_key_checks = 0'], ['SET @@persist.foreign_key_checks = 0'], ["SET @@persist_only.sql_mode = 'ANSI_QUOTES'"],
    ['SET GLOBAL log_bin_trust_function_creators = 1'], ["SET GLOBAL sql_mode = REPLACE(@@sql_mode, 'NO_ZERO_DATE', '')"], ['SET GLOBAL default_storage_engine = MyISAM'],
    ["SET GLOBAL foreign_key_checks = 0, sql_mode = ''"], ["SET PERSIST max_connections = 10, @@session.foreign_key_checks = 0, GLOBAL sql_mode = ''"],
  ])('%s 는 세션을 바꾸지 않아 무시한다', (sql) => {
    const st = freshState();
    setIn(st, sql);
    expect(st.sqlMode).toBe(DEFAULT_SQL_MODE);
    expect(st.fkChecks).toBe(!sql.includes('@@session.foreign_key_checks'));
  });

  it('SESSION 수식어 뒤의 대입은 다시 세션 값이다', () => {
    const st = freshState();
    setIn(st, "SET GLOBAL max_connections = 10, SESSION foreign_key_checks = 0, sql_mode = ''");
    expect(st.fkChecks).toBe(false);
    expect(st.sqlMode).toBe('');
  });
});

// 리뷰 7회차 R7-1: GLOBAL·PERSIST 로 서버 sql_mode 를 바꾸면 세션 값은 그대로지만, 그 뒤의 세션 sql_mode = DEFAULT 는 바뀐 서버 값을 읽는다. 이 도구가 아는 DEFAULT 값은
// 처음 세션 SQL_MODE(짐작한 서버 값)뿐이라 바뀐 값을 알 수 없으므로 세션 SQL_MODE 를 모르는 값으로 둔다 (리뷰 10회차 — 뒤의 루틴 등 그 값에 기대는 문장을 거부한다).
// 서버 sql_mode 를 바꾸기 전의 DEFAULT 와 세션 값을 직접 정하는 대입은 그대로 안다
describe('서버 sql_mode 를 바꾼 뒤의 SET sql_mode = DEFAULT', () => {
  const RELAXED = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
  const SERVER_CHANGES = [
    "SET GLOBAL sql_mode = 'NO_ENGINE_SUBSTITUTION'", 'SET GLOBAL sql_mode = DEFAULT', "SET PERSIST sql_mode = ''", "SET PERSIST_ONLY sql_mode = 'STRICT_TRANS_TABLES'",
    "SET @@global.sql_mode = 'NO_ENGINE_SUBSTITUTION'", "SET @@PERSIST.sql_mode = ''", "SET GLOBAL max_connections = 10, sql_mode = 'NO_ZERO_DATE'",
    "SET GLOBAL sql_mode = REPLACE(@@sql_mode, 'NO_ZERO_DATE', '')",
  ];
  const SESSION_DEFAULTS = [
    'SET sql_mode = DEFAULT', 'SET SESSION sql_mode = DEFAULT', 'SET LOCAL sql_mode = default', 'SET @@sql_mode = DEFAULT', 'SET @@SESSION.sql_mode = DEFAULT',
    'SET NAMES utf8mb4, sql_mode = DEFAULT',
  ];
  const stateWith = (sql: string): State => {
    const st = initialState(empty, 'shop', MYSQL_DEFAULTS, RELAXED);
    setIn(st, sql);
    return st;
  };

  const CHANGED = 'DEFAULT 는 세션 값을 전역 sql_mode 로 되돌리는데, 이 스크립트가 그 앞에서 전역(GLOBAL·PERSIST) sql_mode 를 바꿔 그 값을 알 수 없습니다';

  it.each(SERVER_CHANGES)('%s 뒤의 세션 DEFAULT 는 받고, 전역 값을 바꿨음을 밝혀 세션 SQL_MODE 를 모르는 값으로 둔다', (change) => {
    for (const sql of SESSION_DEFAULTS) {
      const st = stateWith(change);
      setIn(st, sql);
      expect(st.sqlModeUnknown, sql).toContain(CHANGED);
      expect(st.sqlModeUnknown, sql).toContain('앞의 `SET ');
    }
  });

  it.each([
    ["SET GLOBAL sql_mode = 'NO_ENGINE_SUBSTITUTION', SESSION sql_mode = DEFAULT"], ["SET PERSIST sql_mode = '', @@session.sql_mode = DEFAULT"],
    ["SET @@global.sql_mode = '', SESSION sql_mode = DEFAULT"],
  ])('한 문장 안에서도 서버 값을 바꾼 뒤(%s)의 세션 DEFAULT 는 세션 SQL_MODE 를 모르는 값으로 둔다', (sql) => {
    const st = initialState(empty, 'shop', MYSQL_DEFAULTS, RELAXED);
    setIn(st, sql);
    expect(st.sqlModeUnknown).toContain(CHANGED);
  });

  it('여러 문장에 걸쳐 간 뒤에도 같다 (서버 값을 바꾼 사실을 기억한다)', () => {
    const st = stateWith("SET GLOBAL sql_mode = 'NO_ENGINE_SUBSTITUTION'");
    setIn(st, "SET sql_mode = 'NO_ZERO_DATE'");
    setIn(st, 'SET GLOBAL max_connections = 10');
    setIn(st, 'SET SESSION sql_mode = DEFAULT');
    expect(st.sqlModeUnknown).toContain(CHANGED);
    setIn(st, "SET sql_mode = 'NO_ZERO_DATE'");
    expect(st).toMatchObject({ sqlMode: 'NO_ZERO_DATE', sqlModeUnknown: undefined });
  });

  it('서버 sql_mode 를 바꾸기 전의 DEFAULT 는 처음 세션 SQL_MODE 로 되돌린다', () => {
    const st = initialState(empty, 'shop', MYSQL_DEFAULTS, RELAXED);
    setIn(st, "SET sql_mode = 'NO_ZERO_DATE'");
    setIn(st, 'SET SESSION sql_mode = DEFAULT');
    expect(st.sqlMode).toBe(RELAXED);
    setIn(st, "SET GLOBAL sql_mode = 'NO_ENGINE_SUBSTITUTION'");
    expect(st.sqlMode).toBe(RELAXED);
  });

  it('서버 sql_mode 를 바꾼 뒤에도 세션 값을 직접 정하는 대입·@OLD_ 복원·SET GLOBAL sql_mode = DEFAULT 는 받는다', () => {
    const st = stateWith("SET @OLD_MODE = @@SQL_MODE, GLOBAL sql_mode = 'NO_ENGINE_SUBSTITUTION'");
    setIn(st, "SET SESSION sql_mode = 'NO_ZERO_DATE'");
    expect(st.sqlMode).toBe('NO_ZERO_DATE');
    setIn(st, 'SET sql_mode = @OLD_MODE');
    expect(st.sqlMode).toBe(RELAXED);
    setIn(st, 'SET GLOBAL sql_mode = DEFAULT');
    expect(st.sqlMode).toBe(RELAXED);
  });

  it.each([
    ['SET GLOBAL max_connections = 10'], ['SET PERSIST foreign_key_checks = 0'], ['SET @@global.default_storage_engine = MyISAM'], ["SET GLOBAL time_zone = '+00:00'"],
    ["SET SESSION sql_mode = 'NO_ZERO_DATE'"], ['SET GLOBAL max_connections = 10, SESSION sql_mode = DEFAULT'],
  ])('서버 sql_mode 를 바꾸지 않은 %s 뒤의 세션 DEFAULT 는 그대로 받는다', (change) => {
    const st = stateWith(change);
    setIn(st, 'SET SESSION sql_mode = DEFAULT');
    expect(st.sqlMode).toBe(RELAXED);
  });
});

// 세션 time_zone 과 TIMESTAMP 리터럴 기본값 (리뷰 3회차 M-1·4회차 M-1, 8.0.46·8.4.11 실측): MySQL 은 TIMESTAMP 리터럴 기본값을 쓰는 세션의 시간대에서 UTC 로 바꿔 저장하고,
// SHOW CREATE 는 읽는 세션의 시간대로 다시 바꿔 찍는다 ('+09:00' 세션의 DEFAULT '2020-01-01 09:00:00' 을 UTC 세션에서 읽으면 '2020-01-01 00:00:00'). td-export 는 UTC 세션
// (sqlx 기본값 time_zone='+00:00')에서 읽으므로 기준 버전의 값은 UTC 글자다. 스크립트가 앞에서 세션 time_zone 을 UTC 로 정한 뒤의 값은 쓴 그대로 받고, 그 밖(정하지 않아 서버
// 시간대인 세션, 다른 시간대, 변수로 되돌린 시간대)은 서버가 저장한 값을 알 수 없어 RE_EXPORT 로 거부한다
describe('세션 time_zone 과 TIMESTAMP 리터럴 기본값', () => {
  const base = parseSqlDump(tdExport('CREATE TABLE `ev` (\n  `id` int NOT NULL,\n  `ts` timestamp NULL DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;')).model;
  const run = (script: string) => applyScript(base, script, { schemaName: 'shop' });
  const UTC_ZONES = [
    "/*!40103 SET TIME_ZONE='+00:00' */;", "SET time_zone = '+00:00';", "SET time_zone = '+0:00';", "SET time_zone = '-00:00';", 'SET time_zone = "+00:00";',
    "SET @@session.time_zone = 'UTC';", "SET LOCAL time_zone = 'gmt';", 'SET time_zone = UTC;', "SET NAMES utf8mb4, time_zone = '+00:00';", "SET time_zone = '+09:00'; SET time_zone = '+00:00';",
  ];
  const OTHER_ZONES = [
    "SET time_zone = '+09:00';", "SET @@session.time_zone = 'SYSTEM';", "SET LOCAL TIME_ZONE = 'Asia/Seoul';", "SET time_zone = '+00:30';",
    "SET GLOBAL time_zone = '+00:00';", "SET time_zone = '+00:00'; SET time_zone = DEFAULT;", "SET @tz = '+00:00'; SET time_zone = @tz;",
  ];
  // @@time_zone 으로 되돌린 시간대: 이 도구는 time_zone 의 값을 따라가지 않아 @@time_zone 은 모르는 값이고, 안내는 그 값으로 정한 SET 을 밝힌다 (리뷰 11회차 R11-3) — [시간대 문장, 정한 SET]
  const UNKNOWN_ZONES: [string, string][] = [
    ['SET @@time_zone = @@time_zone;', 'SET @@time_zone = @@time_zone'],
    ["/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */; /*!40103 SET TIME_ZONE='+00:00' */; /*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;", 'SET TIME_ZONE=@OLD_TIME_ZONE'],
  ];
  // [문장, 테이블, 컬럼, 모델에 남는 기본값]
  const LITERALS: [string, string, string, string][] = [
    ["CREATE TABLE ev2 (id INT PRIMARY KEY, starts_at TIMESTAMP NOT NULL DEFAULT '2020-01-01 09:00:00');", 'ev2', 'starts_at', "'2020-01-01 09:00:00'"],
    ["ALTER TABLE ev ADD starts_at TIMESTAMP NOT NULL DEFAULT '2020-01-01 09:00:00';", 'ev', 'starts_at', "'2020-01-01 09:00:00'"],
    ["ALTER TABLE ev MODIFY ts TIMESTAMP NULL DEFAULT '2020-01-01 09:00';", 'ev', 'ts', "'2020-01-01 09:00:00'"],
    ["ALTER TABLE ev CHANGE ts starts_at TIMESTAMP(3) NULL DEFAULT '2020-01-01 09:00:00';", 'ev', 'starts_at', "'2020-01-01 09:00:00.000'"],
    ["ALTER TABLE ev ALTER COLUMN ts SET DEFAULT '2020-01-01 09:00:00';", 'ev', 'ts', "'2020-01-01 09:00:00'"],
  ];
  const statementCount = (zone: string) => zone.split(';').length - 1; // 시간대 문장들 (값에 ';' 가 없다)
  const defaultOf = (r: ApplyResult, table: string, column: string) => (r.ok ? r.model.tables.find((t) => t.name === table)?.columns.find((c) => c.name === column)?.default : undefined);
  const expectUnknownZone = (r: ApplyResult, index: number) => {
    expect(r).toMatchObject({ ok: false, error: { index, reason: expect.stringContaining('서버의 시간대를 알 수 없어') } });
    if (!r.ok) expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
  };

  it.each(UTC_ZONES.flatMap((zone) => LITERALS.map((l) => [zone, ...l])))('%s 뒤의 %s 는 쓴 값을 UTC 그대로 받는다', (zone, stmt, table, column, expected) => {
    const r = run(`${zone}\n${stmt}`);
    expect(r).toMatchObject({ ok: true, applied: 1 });
    expect(defaultOf(r, table, column)).toBe(expected);
  });

  it.each(LITERALS)('time_zone 을 정하지 않은 스크립트(서버 시간대 세션)의 %s 는 RE_EXPORT 로 거부한다', (stmt) => {
    expectUnknownZone(run(stmt), 1);
  });

  it.each(OTHER_ZONES.flatMap((zone) => LITERALS.map(([stmt]) => [zone, stmt])))('%s 뒤의 %s 는 RE_EXPORT 로 거부한다', (zone, stmt) => {
    expectUnknownZone(run(`${zone}\n${stmt}`), statementCount(zone) + 1);
  });

  it.each(UNKNOWN_ZONES.flatMap(([zone, set]) => LITERALS.map(([stmt]) => [zone, set, stmt])))('%s 뒤의 %s 문장이 정한 시간대에서 %s 는 RE_EXPORT 로 거부한다', (zone, set, stmt) => {
    const r = run(`${zone}\n${stmt}`);
    expect(r).toMatchObject({ ok: false, error: { index: statementCount(zone) + 1, reason: expect.stringContaining(`앞의 \`${set}\` 문장이 세션 시간대를 알 수 없는 값으로 정해`) } });
    if (!r.ok) expect(r.error.reason).toContain('시스템 변수 @@time_zone 의 값은 이 도구가 따라가지 않아 알 수 없습니다');
    if (!r.ok) expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
  });

  it('거부 안내는 스크립트를 고치라고 하지 않는다 — 스크립트는 이미 서버 시간대로 실행됐다', () => {
    const r = run(LITERALS[1][0]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).not.toContain('time_zone');
  });

  it('CURRENT_TIMESTAMP·NULL 기본값과 DATETIME 리터럴은 시간대를 타지 않아 받는다', () => {
    const stmt = "ALTER TABLE ev ADD a TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, ADD b TIMESTAMP NULL DEFAULT NULL, ADD c DATETIME NOT NULL DEFAULT '2020-01-01 00:00:00', ALTER COLUMN ts SET DEFAULT NULL;";
    expect(run(stmt)).toMatchObject({ ok: true, applied: 1 });
    expect(run(`SET time_zone = '+09:00';\n${stmt}`)).toMatchObject({ ok: true, applied: 1 });
  });

  it('없는 날짜는 시간대와 상관없이 1067 이다', () => {
    expect(run("ALTER TABLE ev ALTER COLUMN ts SET DEFAULT '2020-02-30 00:00:00';")).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining('(MySQL 1067)') } });
  });
});

// 리뷰 9회차 (Claude 참고 2)·10회차 (참고 3·4): 트랜잭션 특성(SET [GLOBAL|SESSION|LOCAL|PERSIST|PERSIST_ONLY] TRANSACTION … — PERSIST 꼴도 MySQL 이 받는다, 8.0.46·8.4.11 실측)·
// 활성 역할(SET ROLE …)·계정의 기본 역할(SET DEFAULT ROLE … TO …)·스레드의 자원 그룹(SET RESOURCE GROUP rg [FOR id …])은 스키마와 이 도구가 따라가는 세션 값을 바꾸지 않아
// 무시한다. 키워드 뒤에 아무것도 없으면 MySQL 처럼 1064 다. 그 밖에 '변수 = 값' 꼴이 아닌 SET 은 ':' 필요 대신 알아보기 쉬운 안내로 거부한다
describe('스키마와 상관없는 SET', () => {
  it.each([
    'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'SET GLOBAL TRANSACTION READ ONLY',
    'SET LOCAL TRANSACTION READ WRITE, ISOLATION LEVEL REPEATABLE READ', 'set transaction isolation level read uncommitted', 'SET PERSIST TRANSACTION ISOLATION LEVEL READ COMMITTED',
    'SET PERSIST_ONLY TRANSACTION READ ONLY', 'SET ROLE ALL', 'SET ROLE NONE', 'SET ROLE DEFAULT',
    "SET ROLE 'r1', `r2`@'%'", "SET ROLE ALL EXCEPT 'r1'@'localhost'", "SET DEFAULT ROLE ALL TO 'u'@'%'", 'SET DEFAULT ROLE NONE TO u, v@localhost', 'SET DEFAULT ROLE r1, r2 TO CURRENT_USER()',
    'SET RESOURCE GROUP rg', 'SET RESOURCE GROUP rg FOR 1, 2', 'set resource group USR_default',
  ])('%s 는 무시한다', (sql) => {
    const st = freshState();
    setIn(st, sql);
    expect(st).toEqual(freshState());
  });

  it('스크립트 안에서도 적용한 문장 수에 세지 않고 넘어간다', () => {
    const r = applyScript(empty, "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;\nSET ROLE ALL;\nSET DEFAULT ROLE ALL TO 'u'@'%';\nSET RESOURCE GROUP rg;\nCREATE TABLE t (id INT PRIMARY KEY);", { schemaName: 'shop' });
    expect(r).toMatchObject({ ok: true, applied: 1 });
  });

  // PERSIST·PERSIST_ONLY 꼴도 트랜잭션 특성으로 가른다 — 서버 변수 대입(SET PERSIST x = …)으로 읽어 넘기지 않는다 (리뷰 10회차 Claude 참고 2)
  it.each([
    'SET TRANSACTION', 'SET GLOBAL TRANSACTION', 'SET SESSION TRANSACTION', 'set local transaction', 'SET PERSIST TRANSACTION', 'SET PERSIST_ONLY TRANSACTION',
    'SET ROLE', 'SET DEFAULT ROLE', 'SET RESOURCE GROUP',
  ])('키워드 뒤에 아무것도 없는 %s 는 MySQL 처럼 1064 로 거부한다 (8.0.46·8.4.11 실측)', (sql) => {
    const message = messageOf(() => setIn(freshState(), sql));
    expect(message).toContain('(MySQL 1064)');
    expect(message).toContain(`${sql.toUpperCase()} 뒤에`);
  });

  it.each(['SET autocommit 1', 'SET @x 1'])("'변수 = 값' 꼴이 아닌 %s 는 알아보기 쉬운 안내로 RE_EXPORT 와 함께 거부한다", (sql) => {
    const message = messageOf(() => setIn(freshState(), sql));
    expect(message).toContain("'변수 = 값' 꼴이 아닌 SET 은 받지 않습니다");
    expect(message).not.toContain("':' 필요");
    expect(message.endsWith(RE_EXPORT), message).toBe(true);
  });
});

// 리뷰 11회차 Claude F2 (MySQL set_var.cc sql_set_variables — 값 검사·계산(check)을 모두 마친 뒤 대입(update)한다, 8.0.46·8.4.11 실측): 한 SET 문의 대입은 값을 모두 먼저
// 계산한 뒤 차례로 대입한다. 뒤 대입이 앞 대입이 바꾼 변수를 읽어도 문장 전의 값이다. 값 계산 중에 부른 저장 함수는 그 뒤에 계산하는 값만 바꿀 수 있고, 대입은 그 뒤에 한다
describe('한 SET 문은 값을 모두 계산한 뒤 차례로 대입한다', () => {
  const T = 'CREATE TABLE t (id INT PRIMARY KEY);';
  const modesOf = (r: ApplyResult) => (r.ok ? r.model.routines.filter((x) => x.kind === 'procedure').map((x) => `${x.name}:${x.sqlMode}`) : r.error.reason);

  it("설정을 앞에 쓴 'SET SQL_MODE = …, @OLD_SQL_MODE = @@SQL_MODE' 의 @OLD_SQL_MODE 는 문장 전의 SQL_MODE 다 (리뷰 재현)", () => {
    const r = applyScript(empty, `${T}\nSET SQL_MODE='NO_AUTO_VALUE_ON_ZERO', @OLD_SQL_MODE=@@SQL_MODE;\nALTER TABLE t ADD c INT;\nSET SQL_MODE=@OLD_SQL_MODE;\nCREATE PROCEDURE p() SELECT 1;`, { schemaName: 'shop' });
    expect(modesOf(r)).toEqual([`p:${DEFAULT_SQL_MODE}`]);
  });

  it('앞 대입이 바꾼 사용자 변수를 뒤 대입이 읽어도 문장 전의 값이다 (리뷰 재현)', () => {
    const r = applyScript(empty, `${T}\nSET @m = 'STRICT_TRANS_TABLES';\nSET @m = 'NO_ENGINE_SUBSTITUTION', sql_mode = @m;\nCREATE PROCEDURE p() SELECT 1;`, { schemaName: 'shop' });
    expect(modesOf(r)).toEqual(['p:STRICT_TRANS_TABLES']);
  });

  it('@@ 읽기와 사용자 변수 맞바꾸기도 문장 전의 값을 읽는다', () => {
    const st = freshState();
    setIn(st, 'SET FOREIGN_KEY_CHECKS = 0, @fk = @@FOREIGN_KEY_CHECKS');
    expect([st.fkChecks, st.saved.get('@fk')]).toEqual([false, '1']);
    setIn(st, "SET @a = 'x', @b = 'y'");
    setIn(st, 'SET @a = @b, @b = @a');
    expect([st.saved.get('@a'), st.saved.get('@b')]).toEqual(['y', 'x']);
  });

  it('값 계산 중 저장 함수 호출: 앞에서 계산한 대입은 호출 뒤에 반영하고, 뒤에서 읽는 사용자 변수는 모른다 (8.0.46·8.4.11 실측)', () => {
    const FN = 'CREATE FUNCTION fn_one() RETURNS INT DETERMINISTIC NO SQL RETURN 1;';
    const after = applyScript(empty, `${T}\n${FN}\nSET @a = 'NO_ENGINE_SUBSTITUTION', time_zone = '+00:00', GLOBAL max_connections = fn_one();\nSET sql_mode = @a;\nCREATE PROCEDURE p() SELECT 1;\nALTER TABLE t ADD ts TIMESTAMP NULL DEFAULT '2020-01-01 00:00:00';`, { schemaName: 'shop' });
    expect(after).toMatchObject({ ok: true, applied: 4 });
    expect(modesOf(after)).toEqual(['p:NO_ENGINE_SUBSTITUTION']);
    const before = applyScript(empty, `${T}\n${FN}\nSET @a = 'NO_ENGINE_SUBSTITUTION';\nSET GLOBAL max_connections = fn_one(), @c = @a;\nSET sql_mode = @c;\nCREATE PROCEDURE p() SELECT 1;`, { schemaName: 'shop' });
    expect(before).toMatchObject({ ok: false, error: { index: 6, reason: expect.stringContaining('사용자 변수 @a 의 값을 알 수 없습니다') } });
  });
});
