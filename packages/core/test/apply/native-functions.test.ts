import { describe, expect, it } from 'vitest';
import { applyScript, type ApplyResult } from '../../src/apply';
import { ADJACENT_NATIVE_FUNCTIONS, callsNativeFunction, NATIVE_FUNCTIONS } from '../../src/apply/native-functions';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

// 리뷰 10회차 R10-1: 따옴표·스키마 없이 쓴 '이름(' 이 이름이 같은 저장 함수가 있어도 내장 함수를 부르는 이름은 MySQL 8.0/8.4 의 내장 함수 전체다 (8.0.46·8.4.11 의
// mysql.help_topic 함수 이름과 매뉴얼 별칭을 저장 함수와 겹쳐 불러 잰 목록). lex.h 의 SYM_FN 이름은 바로 '(' 가 붙어야 내장 함수이고, IGNORE_SPACE 세션에서는 공백만 끼운 꼴도
// 내장 함수다 (주석을 끼우면 저장 함수)
describe('내장 함수 이름 목록', () => {
  it('이름은 소문자이고 겹치지 않으며, 두 목록은 서로 다르다', () => {
    for (const names of [NATIVE_FUNCTIONS, ADJACENT_NATIVE_FUNCTIONS]) for (const name of names) expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
    expect([...ADJACENT_NATIVE_FUNCTIONS].filter((name) => NATIVE_FUNCTIONS.has(name))).toEqual([]);
    expect(NATIVE_FUNCTIONS.size).toBe(356);
    expect(ADJACENT_NATIVE_FUNCTIONS.size).toBe(35);
  });

  it('9회차까지 빠졌던 이름(JSON_LENGTH·POW·DAYOFMONTH …)과 키워드 문법 함수(CHAR·INSERT·VALUES …)도 든다', () => {
    for (const name of ['json_length', 'pow', 'dayofmonth', 'sha', 'st_aswkt', 'char', 'insert', 'values', 'default', 'interval', 'regexp_like', 'json_table', 'row_number']) {
      expect(NATIVE_FUNCTIONS.has(name), name).toBe(true);
    }
    for (const name of ['adddate', 'mid', 'position', 'extract', 'json_arrayagg', 'st_collect', 'session_user', 'variance']) expect(ADJACENT_NATIVE_FUNCTIONS.has(name), name).toBe(true);
  });

  it('연산자·시스템 뷰 전용 내부 함수·Enterprise 함수·8.4 에 없는 함수·없어진 함수는 들지 않는다', () => {
    for (const name of ['and', 'in', 'like', 'regexp', 'exists', 'internal_auto_increment', 'can_access_table', 'asymmetric_encrypt', 'wait_until_sql_thread_after_gtids', 'password', 'encode']) {
      expect(NATIVE_FUNCTIONS.has(name) || ADJACENT_NATIVE_FUNCTIONS.has(name), name).toBe(false);
    }
  });
});

describe('callsNativeFunction — 이름과 괄호 사이의 글(gap)과 IGNORE_SPACE', () => {
  it.each([
    ['CONCAT', '', false, true], ['concat', ' ', false, true], ['Json_Length', '/* x */', false, true], ['POW', '\n', undefined, true],
    ['NOW', '', false, true], ['NOW', ' ', false, false], ['now', '/**/', false, false], ['COUNT', '\t', false, false],
    ['NOW', ' ', true, true], ['NOW', '\r\n\t\v\f ', true, true], ['NOW', '/**/', true, false], ['NOW', ' -- x\n', true, false], ['NOW', '\u00a0', true, false],
    ['NOW', ' ', undefined, false], ['NOW', '', undefined, true], ['fn_one', '', false, false], ['fn_one', '', true, false],
  ])('%s + %j (IGNORE_SPACE %s) → 내장 함수 %s', (name, gap, ignoreSpace, expected) => {
    expect(callsNativeFunction(name, gap, ignoreSpace)).toBe(expected);
  });
});

// R10-1 재현 (Codex): 이름이 같은 저장 함수가 있어도 내장 함수를 부르는 꼴은 사용자 변수를 잊게 하지 않는다 — 뒤 루틴이 되돌린 SQL_MODE 를 그대로 쓴다
describe('R10-1 — IGNORE_SPACE 세션과 9회차 목록에 없던 내장 함수', () => {
  const base = parseSqlDump(tdExport('CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `v` longtext,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\n')).model;
  const run = (script: string, sqlMode?: string): ApplyResult => applyScript(base, script, { schemaName: 'shop', ...(sqlMode === undefined ? {} : { sqlMode }) });
  const modeOfP = (r: ApplyResult) => (r.ok ? r.model.routines.find((x) => x.name === 'p')?.sqlMode : r.error.reason);
  const fn = (name: string) => `CREATE FUNCTION \`${name}\`() RETURNS INT DETERMINISTIC NO SQL RETURN 1;`;
  const PROC = 'CREATE PROCEDURE p() SELECT 1;';

  it("IGNORE_SPACE 를 리터럴로 정한 세션의 NOW () 는 내장 함수다 (Codex 재현 + 뒤 루틴)", () => {
    const script = [fn('now'), "SET sql_mode='IGNORE_SPACE';", 'SET @old_sql_mode=@@sql_mode;', 'INSERT INTO t VALUES (1, NOW ());', 'ALTER TABLE t ADD COLUMN y INT;', 'SET sql_mode=@old_sql_mode;'];
    expect(run(script.join('\n'))).toMatchObject({ ok: true, applied: 2 });
    expect(modeOfP(run([...script, PROC].join('\n')))).toBe('IGNORE_SPACE');
    expect(modeOfP(run([...script.slice(0, 3), 'INSERT INTO t VALUES (1, NOW\n());', 'SET sql_mode=@old_sql_mode;', PROC].join('\n')))).toBe('IGNORE_SPACE');
  });

  it('IGNORE_SPACE 세션이어도 주석을 끼운 꼴, 기본 SQL_MODE 의 공백 낀 꼴은 저장 함수 호출이다', () => {
    for (const [mode, call] of [["SET sql_mode='IGNORE_SPACE';", 'NOW/**/()'], ["SET sql_mode='IGNORE_SPACE';", 'NOW -- x\n()'], ["SET sql_mode='STRICT_TRANS_TABLES';", 'NOW ()']]) {
      const r = run([fn('now'), mode, 'SET @old=@@sql_mode;', `INSERT INTO t VALUES (1, ${call});`, 'SET sql_mode=@old;', PROC].join('\n'));
      expect(r, call).toMatchObject({ ok: false, error: { index: 6, reason: expect.stringContaining('저장 함수 호출(`NOW`)') } });
    }
  });

  it('한 SET 문 안에서는 문장을 읽을 때의 SQL_MODE 로 가른다 — 앞 대입이 켠 IGNORE_SPACE 는 뒤 대입의 NOW () 에 쓰지 않는다', () => {
    const head = [fn('now'), "SET @m = 'NO_ENGINE_SUBSTITUTION';"];
    const same = run([...head, "SET sql_mode = 'IGNORE_SPACE', GLOBAL max_connections = NOW ();", 'SET sql_mode = @m;', PROC].join('\n'));
    expect(same).toMatchObject({ ok: false, error: { index: 5, reason: expect.stringContaining('저장 함수 호출(`NOW`)') } });
    expect(modeOfP(run([...head, "SET sql_mode = 'IGNORE_SPACE';", 'SET GLOBAL max_connections = NOW ();', 'SET sql_mode = @m;', PROC].join('\n')))).toBe('NO_ENGINE_SUBSTITUTION');
  });

  it('세션 SQL_MODE 를 모르거나 처음 세션 SQL_MODE(서버가 짐작한 값)에 IGNORE_SPACE 가 있으면 공백 낀 꼴을 저장 함수 호출로 본다 (보수적)', () => {
    const unknown = run([fn('now'), 'SET sql_mode = @never_saved;', "SET @m = 'NO_ENGINE_SUBSTITUTION';", 'SELECT NOW ();', "SET sql_mode = 'IGNORE_SPACE';", 'SET sql_mode = @m;', PROC].join('\n'));
    expect(unknown).toMatchObject({ ok: false, error: { index: 7, reason: expect.stringContaining('저장 함수 호출(`NOW`)') } });
    const guessed = run([fn('now'), "SET @m = 'NO_ENGINE_SUBSTITUTION';", 'SELECT NOW ();', 'SET sql_mode = @m;', PROC].join('\n'), 'IGNORE_SPACE');
    expect(guessed).toMatchObject({ ok: false, error: { index: 5, reason: expect.stringContaining('저장 함수 호출(`NOW`)') } });
  });

  it.each(['JSON_LENGTH', 'POW', 'DAYOFMONTH', 'Json_Length /* x */', 'REGEXP_LIKE\n', 'CHAR '])("9회차 목록에 없던 내장 함수 %s('…') 는 이름이 같은 저장 함수가 있어도 사용자 변수를 잊게 하지 않는다", (call) => {
    const name = call.trim().split(/[\s/]/)[0].toLowerCase();
    const script = [fn(name), 'SET @old_sql_mode=@@sql_mode;', `INSERT INTO t VALUES (1, ${call}('{}'));`, 'ALTER TABLE t ADD COLUMN y INT;', 'SET sql_mode=@old_sql_mode;', PROC];
    expect(modeOfP(run(script.join('\n')))).toBe('ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION');
  });
});
