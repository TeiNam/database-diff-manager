import { describe, expect, it } from 'vitest';
import { initialState } from '../../src/apply/state';
import { storedFunctionCall } from '../../src/apply/stored-call';
import { DEFAULT_SQL_MODE, MYSQL_DEFAULTS } from '../../src/apply/types';
import { tokenize } from '../../src/lexer';
import type { Routine } from '../../src/model';

// 무시하는 문장 속 저장 함수 호출 찾기 (리뷰 7회차 R7-2·8회차 R8-1·R8-2). 모델: 현재 스키마 shop 의 함수 fn_one·1set_m 과 내장 함수와 이름이 같은 함수, 프로시저 proc_one
const routine = (kind: Routine['kind'], name: string): Routine => ({ kind, name, params: '', characteristics: {}, body: 'RETURN 1' });
const FUNCTIONS = ['fn_one', '1set_m', 'concat', 'now', 'ifnull', 'count'].map((n) => routine('function', n));
const model = { name: 'shop', tables: [], views: [], routines: [...FUNCTIONS, routine('procedure', 'proc_one')] };
const st = initialState(model, 'shop', MYSQL_DEFAULTS, DEFAULT_SQL_MODE);
const callIn = (sql: string) => storedFunctionCall(st, tokenize(sql));

describe('storedFunctionCall — 무시하는 문장이 부르는 저장 함수', () => {
  it.each([
    ['SELECT fn_one()', 'fn_one'], ['select FN_ONE ()', 'FN_ONE'], ['SELECT `fn_one`()', 'fn_one'], ['SELECT /* 주석 */ fn_one /* 주석 */ (1)', 'fn_one'],
    ['SELECT shop.fn_one()', 'shop.fn_one'], ['SELECT `shop`.`fn_one`(1)', 'shop.fn_one'], ['SELECT shop . fn_one()', 'shop.fn_one'],
    // 숫자로 시작하는 이름 (R8-2): 렉서는 숫자 1 과 단어 set_m 으로 나눈다
    ['SELECT 1set_m()', '1set_m'], ['DO shop.1set_m()', 'shop.1set_m'], ['SELECT `1set_m`()', '1set_m'], ['SELECT 1 + 1set_m(2)', '1set_m'],
    // 내장 함수와 이름이 같은 저장 함수: 공백·주석·백틱·스키마를 쓰면 MySQL 이 저장 함수를 부를 수 있다 (NOW ()·`now`()·`count`() 는 저장 함수, 8.0.46·8.4.11 실측)
    ['SELECT NOW ()', 'NOW'], ['SELECT NOW/**/()', 'NOW'], ['SELECT `now`()', 'now'], ['SELECT `count`(1)', 'count'], ['SELECT `concat`(1)', 'concat'], ['SELECT shop.concat(1)', 'shop.concat'],
    // 다른 스키마의 함수는 이 버전이 모르는 함수라 센다 (스키마 이름은 대소문자를 구분한다). INTO 를 뺀 INSERT 의 다른 스키마 테이블은 호출과 가르지 않는다 (보수적)
    ['SELECT other.anything(1)', 'other.anything'], ['SELECT SHOP.fn_one()', 'SHOP.fn_one'], ['INSERT other.t (id) VALUES (1)', 'other.t'],
  ])('%s → %s', (sql, name) => {
    expect(callIn(sql)).toBe(name);
  });

  it.each([
    // 따옴표·스키마 없이 바로 괄호를 붙인 내장 함수 이름은 이름이 같은 저장 함수가 있어도 내장 함수다 (R8-1)
    "SELECT NOW(), CONCAT('a', 'b'), IFNULL(NULL, 1), COUNT(*)", 'SELECT now(), Concat(1)',
    'SELECT fn_one FROM t', 'SELECT unknown_fn(1)', 'SELECT proc_one()', 'SELECT set_m()', "SELECT 'fn_one(1)'", 'SELECT 1 /* fn_one() */', 'SELECT 1set_m FROM t',
    'SELECT 1e5, 0x1F, 12 FROM t', 'SELECT shop.unknown_fn(1)', 'SELECT 1 set_m()',
    // INSERT·REPLACE … INTO 뒤 이름은 테이블이고 괄호는 컬럼 목록이다
    'INSERT INTO fn_one (id) VALUES (1)', 'INSERT INTO other.t (id) VALUES (1)', 'REPLACE INTO shop.fn_one (id) VALUES (1)', 'INSERT IGNORE INTO `fn_one`(id) VALUES (1)',
  ])('%s 는 저장 함수를 부르지 않는다', (sql) => {
    expect(callIn(sql)).toBeUndefined();
  });
});
