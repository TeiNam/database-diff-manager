import { describe, expect, it } from 'vitest';
import { initialState } from '../../src/apply/state';
import { storedFunctionCall } from '../../src/apply/stored-call';
import { DEFAULT_SQL_MODE, MYSQL_DEFAULTS } from '../../src/apply/types';
import { tokenize } from '../../src/lexer';
import type { Routine } from '../../src/model';

// 무시하는 문장 속 저장 함수 호출 찾기 (리뷰 7회차 R7-2·8회차 R8-1·R8-2·9회차 R9-1·R9-2). 모델: 현재 스키마 shop 의 함수 fn_one·1set_m, 숫자처럼 보이는 이름의 함수
// 0xface·0b101·123, 내장 함수와 이름이 같은 함수, 프로시저 proc_one
const routine = (kind: Routine['kind'], name: string): Routine => ({ kind, name, params: '', characteristics: {}, body: 'RETURN 1' });
const FUNCTIONS = ['fn_one', '1set_m', '0xface', '0b101', '123', 'concat', 'now', 'ifnull', 'count', 'json_length', 'pow', 'char'].map((n) => routine('function', n));
const model = { name: 'shop', tables: [], views: [], routines: [...FUNCTIONS, routine('procedure', 'proc_one')] };
const st = initialState(model, 'shop', MYSQL_DEFAULTS, DEFAULT_SQL_MODE);
const callIn = (sql: string, state = st) => storedFunctionCall(state, tokenize(sql), sql);

describe('storedFunctionCall — 무시하는 문장이 부르는 저장 함수', () => {
  it.each([
    ['SELECT fn_one()', 'fn_one'], ['select FN_ONE ()', 'FN_ONE'], ['SELECT `fn_one`()', 'fn_one'], ['SELECT /* 주석 */ fn_one /* 주석 */ (1)', 'fn_one'],
    ['SELECT shop.fn_one()', 'shop.fn_one'], ['SELECT `shop`.`fn_one`(1)', 'shop.fn_one'], ['SELECT shop . fn_one()', 'shop.fn_one'],
    // 숫자로 시작하는 이름 (R8-2): 렉서는 숫자 1 과 단어 set_m 으로 나눈다
    ['SELECT 1set_m()', '1set_m'], ['DO shop.1set_m()', 'shop.1set_m'], ['SELECT `1set_m`()', '1set_m'], ['SELECT 1 + 1set_m(2)', '1set_m'],
    // 현재 스키마로 한정한 자리의 숫자처럼 보이는 이름 (R9-2): 렉서는 16진수·비트·숫자 리터럴로 읽지만 MySQL 은 '.' 바로 뒤를 식별자로 읽는다 (shop.0xface() 는 저장 함수 0xface)
    ['SELECT shop.0xface()', 'shop.0xface'], ['DO shop.0b101()', 'shop.0b101'], ['SELECT 1 + shop.123(2)', 'shop.123'], ['SELECT shop.`0xface`()', 'shop.0xface'], ['SELECT other.0xface()', 'other.0xface'],
    // 내장 함수와 이름이 같은 저장 함수: 백틱·스키마를 쓰거나, 바로 '(' 가 붙어야 내장 함수인 이름(NOW·COUNT …)에 공백·주석을 끼우면 MySQL 이 저장 함수를 부를 수 있다
    // (NOW ()·NOW/**/()·COUNT (1)·`now`()·`count`() 는 저장 함수, 8.0.46·8.4.11 실측)
    ['SELECT NOW ()', 'NOW'], ['SELECT NOW/**/()', 'NOW'], ['SELECT count\n(1)', 'count'], ['SELECT `now`()', 'now'], ['SELECT `count`(1)', 'count'], ['SELECT `concat`(1)', 'concat'],
    ['SELECT shop.concat(1)', 'shop.concat'],
    // 다른 스키마의 함수는 이 버전이 모르는 함수라 센다 (스키마 이름은 대소문자를 구분한다). INTO 를 뺀 INSERT 의 다른 스키마 테이블은 호출과 가르지 않는다 (보수적)
    ['SELECT other.anything(1)', 'other.anything'], ['SELECT SHOP.fn_one()', 'SHOP.fn_one'], ['INSERT other.t (id) VALUES (1)', 'other.t'],
  ])('%s → %s', (sql, name) => {
    expect(callIn(sql)).toBe(name);
  });

  it.each([
    // 따옴표·스키마 없이 바로 괄호를 붙인 내장 함수 이름은 이름이 같은 저장 함수가 있어도 내장 함수다 (R8-1)
    "SELECT NOW(), CONCAT('a', 'b'), IFNULL(NULL, 1), COUNT(*)", 'SELECT now(), Concat(1)',
    // 그 밖의 내장 함수(CONCAT·IFNULL …)는 이름과 괄호 사이에 공백·주석을 끼워도 내장 함수다 (R9-1, 8.0.46·8.4.11 실측)
    "SELECT CONCAT ('a', 'b')", "SELECT CONCAT/**/('a', 'b')", 'SELECT Ifnull\n(NULL, 1)', "SELECT concat /* 주석 */ ('a')",
    // 한정하지 않은 숫자는 MySQL 도 리터럴로 읽는다 (0xface() 는 1064)
    'SELECT 0xface()', 'SELECT 0b101(), 123()',
    // 9회차 목록에 없던 내장 함수 (리뷰 10회차 R10-1 — MySQL 8.0/8.4 의 내장 함수 전체, native-functions.ts)
    "SELECT JSON_LENGTH('{}'), POW(2, 3), CHAR (65)", "SELECT json_length /* x */ ('[]')",
    'SELECT fn_one FROM t', 'SELECT unknown_fn(1)', 'SELECT proc_one()', 'SELECT set_m()', "SELECT 'fn_one(1)'", 'SELECT 1 /* fn_one() */', 'SELECT 1set_m FROM t',
    'SELECT 1e5, 0x1F, 12 FROM t', 'SELECT shop.unknown_fn(1)', 'SELECT 1 set_m()',
    // INSERT·REPLACE … INTO 뒤 이름은 테이블이고 괄호는 컬럼 목록이다
    'INSERT INTO fn_one (id) VALUES (1)', 'INSERT INTO other.t (id) VALUES (1)', 'REPLACE INTO shop.fn_one (id) VALUES (1)', 'INSERT IGNORE INTO `fn_one`(id) VALUES (1)',
  ])('%s 는 저장 함수를 부르지 않는다', (sql) => {
    expect(callIn(sql)).toBeUndefined();
  });
});

// 리뷰 10회차 R10-1: IGNORE_SPACE 세션에서는 바로 '(' 가 붙어야 하는 이름(NOW·COUNT …)도 공백(공백·탭·줄바꿈·CR·VT·FF)만 끼우면 내장 함수다 (주석을 끼우면 저장 함수 —
// 8.0.46·8.4.11 실측). 세션 SQL_MODE 를 모르거나 처음 세션 SQL_MODE(서버가 짐작한 값)에 IGNORE_SPACE 가 있으면 공백 낀 꼴도 센다 (보수적)
describe('storedFunctionCall — IGNORE_SPACE', () => {
  const withMode = (mode: string, initial = DEFAULT_SQL_MODE) => ({ ...initialState(model, 'shop', MYSQL_DEFAULTS, initial), sqlMode: mode });

  it.each(['SELECT NOW ()', 'SELECT now\n()', 'SELECT COUNT\t(1)', 'SELECT NOW \r\n ()'])('IGNORE_SPACE 세션의 %j 는 내장 함수다', (sql) => {
    expect(callIn(sql, withMode('IGNORE_SPACE,STRICT_TRANS_TABLES'))).toBeUndefined();
  });

  it.each([['SELECT NOW/**/()', 'NOW'], ['SELECT NOW -- x\n()', 'NOW'], ['SELECT count # x\n(1)', 'count'], ['SELECT `now`()', 'now'], ['SELECT shop.now()', 'shop.now']])(
    'IGNORE_SPACE 세션이어도 %j 는 저장 함수 호출이다', (sql, name) => {
      expect(callIn(sql, withMode('IGNORE_SPACE'))).toBe(name);
    });

  it('세션 SQL_MODE 를 모르거나, 처음 세션 SQL_MODE 에 IGNORE_SPACE 가 있으면 공백 낀 꼴을 센다', () => {
    expect(callIn('SELECT NOW ()', { ...withMode('IGNORE_SPACE'), sqlModeUnknown: '앞의 SET …' })).toBe('NOW');
    expect(callIn('SELECT NOW ()', withMode('IGNORE_SPACE', 'IGNORE_SPACE'))).toBe('NOW');
    expect(callIn('SELECT NOW()', { ...withMode('IGNORE_SPACE'), sqlModeUnknown: '앞의 SET …' })).toBeUndefined();
  });

  // 리뷰 11회차 R11-1: 짐작한 처음 값과 같아도 리터럴로 정한 SQL_MODE 는 믿는다 — 내장 함수 판정은 늘 지금 아는 모드를 따른다
  it('처음 세션 SQL_MODE 와 같은 값이어도 리터럴로 정했으면 공백 낀 꼴은 내장 함수다', () => {
    expect(callIn('SELECT NOW ()', { ...withMode('IGNORE_SPACE', 'IGNORE_SPACE'), sqlModeLiteral: true })).toBeUndefined();
  });
});
