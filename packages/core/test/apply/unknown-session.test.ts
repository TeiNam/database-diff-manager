import { describe, expect, it } from 'vitest';
import { applyScript, type ApplyResult } from '../../src/apply';
import { RE_EXPORT } from '../../src/apply/types';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

// 리뷰 10회차 (Claude 참고 5): 값을 모르는 변수(저장 함수 호출 뒤 잊은 사용자 변수, 저장하지 않은 변수, @@global 서버 변수, 바뀐 전역 값을 읽는 DEFAULT)에서 정한
// 세션 SQL_MODE·TIME_ZONE·FOREIGN_KEY_CHECKS 는 그 SET 에서 거부하지 않고 모르는 값으로 둔다. 그 값에 기대는 뒤 문장만 거부한다:
// SQL_MODE — 루틴(만들 때의 SQL_MODE 를 기억한다), 백슬래시(NO_BACKSLASH_ESCAPES)·큰따옴표(ANSI_QUOTES)가 든 문장, DDL 의 REAL 타입(REAL_AS_FLOAT).
// TIME_ZONE — TIMESTAMP 리터럴 기본값. FOREIGN_KEY_CHECKS — 켜져 있으면 FK 검사에 걸리는 문장 (MySQL 오류 번호 대신 RE_EXPORT). 리터럴로 다시 정하면 다시 안다
const base = parseSqlDump(tdExport([
  'CREATE TABLE `parent` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  'CREATE TABLE `child` (\n  `id` int NOT NULL,\n  `p` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `p` (`p`),\n  CONSTRAINT `child_ibfk_1` FOREIGN KEY (`p`) REFERENCES `parent` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `v` int DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
].join('\n'))).model;
const run = (script: string): ApplyResult => applyScript(base, script, { schemaName: 'shop' });
// 도우미 함수를 만들어 데이터를 고친 뒤 지우는 마이그레이션 (적용하는 문장 셋)
const HELPER = ['CREATE FUNCTION fn_bump(x INT) RETURNS INT DETERMINISTIC NO SQL RETURN x + 1;', 'UPDATE t SET v = fn_bump(v);', 'DROP FUNCTION fn_bump;', 'ALTER TABLE t ADD COLUMN c INT;'];
const ALTER_ONLY = run(HELPER[3]);

const MYSQLDUMP_HEADER = [
  '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;', '/*!50503 SET NAMES utf8mb4 */;', '/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;', "/*!40103 SET TIME_ZONE='+00:00' */;",
  '/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;', '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;',
  "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;", '/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;',
];
const MYSQLDUMP_FOOTER = [
  '/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;', '/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;', '/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;',
  '/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;', '/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;', '/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;',
];
const WORKBENCH_HEADER = [
  'SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0;', 'SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0;',
  "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';",
];
const WORKBENCH_FOOTER = ['SET SQL_MODE=@OLD_SQL_MODE;', 'SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;', 'SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS;'];

// index 번째 문장을 RE_EXPORT 로 거부했고, 사유에 parts 가 모두 든다
const expectRejected = (r: ApplyResult, index: number, ...parts: string[]): void => {
  expect(r).toMatchObject({ ok: false, error: { index } });
  if (r.ok) return;
  for (const part of parts) expect(r.error.reason).toContain(part);
  expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
};
const sqlModeOf = (r: ApplyResult, name: string): string | undefined => (r.ok ? r.model.routines.find((x) => x.name === name)?.sqlMode : r.error.reason);

describe('저장 함수 호출 뒤 mysqldump·Workbench 꼬리 — 되돌린 세션 값을 모르는 값으로 두고 받는다', () => {
  it('mysqldump 머리·꼬리 사이에서 도우미 함수를 불러도 꼬리의 TIME_ZONE·SQL_MODE·FOREIGN_KEY_CHECKS 복원을 받고, 모델은 ALTER 만 적용한 것과 같다', () => {
    const r = run([...MYSQLDUMP_HEADER, ...HELPER, ...MYSQLDUMP_FOOTER].join('\n'));
    expect(r).toMatchObject({ ok: true, applied: 3 });
    expect(r.ok && ALTER_ONLY.ok && r.model).toEqual(ALTER_ONLY.ok && ALTER_ONLY.model);
  });

  it('Workbench 머리·꼬리 사이에서 도우미 함수를 불러도 받는다', () => {
    const r = run([...WORKBENCH_HEADER, ...HELPER, ...WORKBENCH_FOOTER].join('\n'));
    expect(r).toMatchObject({ ok: true, applied: 3 });
    expect(r.ok && ALTER_ONLY.ok && r.model).toEqual(ALTER_ONLY.ok && ALTER_ONLY.model);
  });

  it('입력 모델을 바꾸지 않는다', () => {
    const before = JSON.stringify(base);
    run([...MYSQLDUMP_HEADER, ...HELPER, ...MYSQLDUMP_FOOTER, 'CREATE PROCEDURE p() SELECT 1;'].join('\n'));
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('모르는 세션 SQL_MODE', () => {
  const UNKNOWN = [...HELPER.slice(0, 2), 'SET @m = @@sql_mode;', 'SELECT fn_bump(1);', 'SET SQL_MODE = @m;']; // 3·4번째에서 @m 을 저장했다 잊고, 5번째가 읽는다
  const after = (...lines: string[]) => run([...UNKNOWN, ...lines].join('\n'));
  const at = UNKNOWN.length + 1;
  const ORIGIN = ['앞의 `SET SQL_MODE = @m` 문장이 세션 SQL_MODE 를 알 수 없는 값으로 정했습니다', '사용자 변수 @m 의 값을 알 수 없습니다 — 무시한 문장의 저장 함수 호출(`fn_bump`)이 이 변수를 바꿨을 수 있습니다'];

  it('R7-2: 모르는 SQL_MODE 를 쓰는 뒤 CREATE PROCEDURE·FUNCTION 을 RE_EXPORT 로 거부하고, 어느 앞 문장이 값을 모르게 했는지 밝힌다', () => {
    const proc = after('CREATE PROCEDURE p() SELECT 1;');
    expectRejected(proc, at, 'PROCEDURE `p` 은(는) 만들 때의 세션 SQL_MODE 를 기억하는데 그 값을 알 수 없습니다', ...ORIGIN);
    expect(proc).toMatchObject({ ok: false, error: { line: at, statement: 'CREATE PROCEDURE p() SELECT 1' } });
    expectRejected(after('CREATE FUNCTION f() RETURNS INT DETERMINISTIC RETURN 1;'), at, 'FUNCTION `f` 은(는)', ...ORIGIN);
  });

  it('그 SET 자체와 SQL_MODE 에 기대지 않는 뒤 문장은 받는다 (이미 있는 루틴의 IF NOT EXISTS 도)', () => {
    expect(after('ALTER TABLE t ADD COLUMN y INT;', "INSERT INTO t VALUES (1, 'a''b');", 'DROP FUNCTION IF EXISTS nope;')).toMatchObject({ ok: true, applied: 3 });
    const withProc = applyScript(base, 'CREATE PROCEDURE p() SELECT 1;', { schemaName: 'shop' });
    if (!withProc.ok) throw new Error(withProc.error.reason);
    expect(applyScript(withProc.model, [...UNKNOWN, 'CREATE PROCEDURE IF NOT EXISTS p() SELECT 2;', 'ALTER TABLE t ADD COLUMN y INT;'].join('\n'), { schemaName: 'shop' })).toMatchObject({ ok: true, applied: 3 });
  });

  it.each([
    ["ALTER TABLE t COMMENT 'C:\\\\path';", 'NO_BACKSLASH_ESCAPES'], ["INSERT INTO t VALUES (1, 'a\\'b');", 'NO_BACKSLASH_ESCAPES'], ["SET @x = 'a\\\\b';", 'NO_BACKSLASH_ESCAPES'],
    ['ALTER TABLE t COMMENT "x";', 'ANSI_QUOTES'], ['SELECT "fn_bump"(1);', 'ANSI_QUOTES'], ['SET sql_mode = "NO_ENGINE_SUBSTITUTION";', 'ANSI_QUOTES'],
    ['ALTER TABLE t ADD COLUMN r REAL;', 'REAL_AS_FLOAT'], ['CREATE TABLE u (id INT PRIMARY KEY, r real(10,2) unsigned);', 'REAL_AS_FLOAT'],
  ])('모드에 따라 MySQL 이 다르게 읽는 %s 는 RE_EXPORT 로 거부한다 (%s)', (sql, mode) => {
    expectRejected(after(sql), at, `세션 SQL_MODE 를 알 수 없어 ${mode}`, ...ORIGIN);
  });

  it("작은따옴표 안의 큰따옴표, REAL 이 아닌 단어, 백슬래시 없는 문장은 받는다", () => {
    const r = after(`INSERT INTO t VALUES (1, '{"a": "b"}');`, 'ALTER TABLE t ADD COLUMN real_value DOUBLE, ADD COLUMN `real` INT;', 'SELECT CAST(1 AS REAL);');
    expect(r).toMatchObject({ ok: true, applied: 2 });
  });

  it("SET SQL_MODE = '…' 리터럴(과 서버 값을 바꾸지 않은 DEFAULT)로 다시 정하면 뒤 루틴이 그 값을 쓴다", () => {
    expect(sqlModeOf(after("SET SQL_MODE = 'NO_ENGINE_SUBSTITUTION';", 'CREATE PROCEDURE p() SELECT 1;'), 'p')).toBe('NO_ENGINE_SUBSTITUTION');
    expect(sqlModeOf(run('SET SQL_MODE = @never_saved;\nSET SQL_MODE = DEFAULT;\nCREATE PROCEDURE p() SELECT 1;'), 'p')).toBe('ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION');
  });

  it('모르는 SQL_MODE 를 @@sql_mode 로 옮긴 변수에서 다시 정해도 모르고, 안내는 옮긴 문장까지 밝힌다', () => {
    const r = after('SET @copy = @@sql_mode;', "SET SQL_MODE = 'NO_ENGINE_SUBSTITUTION';", 'SET SQL_MODE = @copy;', 'CREATE PROCEDURE p() SELECT 1;');
    expectRejected(r, at + 3, '앞의 `SET SQL_MODE = @copy` 문장이', '사용자 변수 @copy 에 앞의 `SET @copy = @@sql_mode` 문장이 알 수 없는 값을 넣었습니다', ...ORIGIN);
  });

  it('저장하지 않은 변수·서버 변수·바뀐 전역 값을 읽는 DEFAULT 도 같다: 그 SET 은 받고, 루틴에서 까닭을 밝혀 거부한다', () => {
    const PROC = 'CREATE PROCEDURE p() SELECT 1;';
    expectRejected(run(`SET SQL_MODE = @never_saved;\n${PROC}`), 2, '앞의 `SET SQL_MODE = @never_saved` 문장이', '값을 저장하지 않은 변수입니다: @never_saved');
    expectRejected(run(`SET sql_mode = @@global.sql_mode;\n${PROC}`), 2, '서버 변수 값(@@global·@@persist 의 sql_mode)은 알 수 없습니다');
    expectRejected(run(`SET GLOBAL sql_mode = '';\nSET sql_mode = DEFAULT;\n${PROC}`), 3, '앞의 `SET sql_mode = DEFAULT` 문장이', '전역(GLOBAL·PERSIST) sql_mode 를 바꿔');
    expectRejected(run(`${HELPER[0]}\nSELECT fn_bump(1);\nSET sql_mode = DEFAULT;\n${PROC}`), 4, '저장 함수 호출(`fn_bump`)이 전역 sql_mode 를 바꿨을 수 있');
    for (const set of ['SET SQL_MODE = @never_saved;', 'SET sql_mode = @@global.sql_mode;', "SET GLOBAL sql_mode = '';\nSET sql_mode = DEFAULT;"]) {
      expect(run(`${set}\nALTER TABLE t ADD COLUMN y INT;`), set).toMatchObject({ ok: true, applied: 1 });
    }
  });
});

describe('모르는 세션 TIME_ZONE', () => {
  const TS = "ALTER TABLE t ADD ts TIMESTAMP NULL DEFAULT '2020-01-01 09:00:00';";
  const UNKNOWN = ["SET @OLD_TIME_ZONE = @@TIME_ZONE, TIME_ZONE = '+00:00';", ...HELPER.slice(0, 2), 'SET TIME_ZONE = @OLD_TIME_ZONE;'];

  it('모르는 변수에서 되돌린 TIME_ZONE 은 받고, 뒤의 TIMESTAMP 리터럴 기본값을 그 문장을 밝혀 거부한다', () => {
    expect(run([...UNKNOWN, 'ALTER TABLE t ADD COLUMN y INT;'].join('\n'))).toMatchObject({ ok: true, applied: 2 });
    expectRejected(run([...UNKNOWN, TS].join('\n')), UNKNOWN.length + 1, 'TIMESTAMP 컬럼 `ts` 의 리터럴 기본값',
      '앞의 `SET TIME_ZONE = @OLD_TIME_ZONE` 문장이 세션 시간대를 알 수 없는 값으로 정해', '사용자 변수 @old_time_zone 의 값을 알 수 없습니다');
    expectRejected(run(`SET time_zone = @@global.time_zone;\n${TS}`), 2, '서버 변수 값(@@global·@@persist 의 time_zone)은 알 수 없습니다');
  });

  it('UTC 리터럴로 다시 정하면 TIMESTAMP 리터럴 기본값을 받는다', () => {
    expect(run([...UNKNOWN, "SET time_zone = '+00:00';", TS].join('\n'))).toMatchObject({ ok: true, applied: 2 });
  });
});

describe('모르는 세션 FOREIGN_KEY_CHECKS', () => {
  const UNKNOWN = ['SET @OLD_FK = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;', ...HELPER.slice(0, 2), 'SET FOREIGN_KEY_CHECKS = @OLD_FK;'];
  const after = (...lines: string[]) => run([...UNKNOWN, ...lines].join('\n'));
  const at = UNKNOWN.length + 1;
  const ORIGIN = '앞의 `SET FOREIGN_KEY_CHECKS = @OLD_FK` 문장이 세션 FOREIGN_KEY_CHECKS 를 알 수 없는 값으로 정했습니다';
  const CHECKED = 'FOREIGN_KEY_CHECKS 가 켜져 있으면 MySQL 이 거부하고 꺼져 있으면 받는데, 세션 FOREIGN_KEY_CHECKS 를 알 수 없습니다';

  it.each([
    'CREATE TABLE u (id INT PRIMARY KEY, q INT, FOREIGN KEY (q) REFERENCES missing (id));', 'ALTER TABLE t ADD FOREIGN KEY (v) REFERENCES missing (id);', 'DROP TABLE parent;',
  ])('켜져 있으면 FK 검사에 걸리는 %s 는 MySQL 오류 번호 대신 RE_EXPORT 로 거부한다', (sql) => {
    const r = after(sql);
    expectRejected(r, at, CHECKED, ORIGIN, '사용자 변수 @old_fk 의 값을 알 수 없습니다');
    expect(!r.ok && r.error.reason).not.toMatch(/\(MySQL \d+\)/);
  });

  it('검사가 켜져 있든 꺼져 있든 받는 문장은 받는다 (부모가 있는 FK, 참조하지 않는 테이블·자식과 함께 지우는 부모)', () => {
    const r = after('ALTER TABLE t ADD FOREIGN KEY (v) REFERENCES parent (id);', 'DROP TABLE t;', 'DROP TABLE child, parent;');
    expect(r).toMatchObject({ ok: true, applied: 4 });
  });

  it('FOREIGN_KEY_CHECKS 를 리터럴로 다시 정하면 MySQL 처럼 검사하거나 건너뛴다', () => {
    expect(after('SET FOREIGN_KEY_CHECKS = 0;', 'DROP TABLE parent;')).toMatchObject({ ok: true, applied: 2 });
    expect(after('SET FOREIGN_KEY_CHECKS = 1;', 'DROP TABLE parent;')).toMatchObject({ ok: false, error: { index: at + 1, reason: expect.stringContaining('(MySQL 3730)') } });
  });

  it('저장하지 않은 변수·서버 변수에서 정해도 같다', () => {
    const MISSING = 'ALTER TABLE t ADD FOREIGN KEY (v) REFERENCES missing (id);';
    expect(run('SET FOREIGN_KEY_CHECKS = @never_saved;\nALTER TABLE t ADD COLUMN y INT;')).toMatchObject({ ok: true, applied: 1 });
    expectRejected(run(`SET FOREIGN_KEY_CHECKS = @never_saved;\n${MISSING}`), 2, CHECKED, '값을 저장하지 않은 변수입니다: @never_saved');
    expectRejected(run(`SET FOREIGN_KEY_CHECKS = @@global.foreign_key_checks;\n${MISSING}`), 2, CHECKED, '서버 변수 값(@@global·@@persist 의 foreign_key_checks)은 알 수 없습니다');
  });
});

// 리뷰 11회차 R11-3·Claude F6: 이 도구가 값을 따라가지 않는 시스템 변수(@@init_connect·@@unique_checks·@@sql_notes·@@time_zone …)를 읽으면 '' 가 아니라 모르는 값이다.
// 한정하지 않은 @@init_connect 는 전역 값을 읽고(전역 전용 변수), @@unique_checks 는 정수 1 이라 sql_mode 가 REAL_AS_FLOAT 가 된다 — 지어낸 '' 로 정하면 루틴의 SQL_MODE 가 틀린다
describe('추적하지 않는 시스템 변수 읽기', () => {
  const PROC = 'CREATE PROCEDURE p() SELECT 1;';
  const UNTRACKED = '시스템 변수 @@init_connect 의 값은 이 도구가 따라가지 않아 알 수 없습니다';

  it('R11-3: SET GLOBAL init_connect 뒤 @@init_connect 로 정한 sql_mode 는 모르는 값이라 뒤 루틴을 거부한다', () => {
    expectRejected(run(`SET GLOBAL init_connect='STRICT_TRANS_TABLES';\nSET sql_mode=@@init_connect;\n${PROC}`), 3, '앞의 `SET sql_mode=@@init_connect` 문장이', UNTRACKED);
  });

  it.each([
    'SET sql_mode = @@init_connect;', 'SET SESSION sql_mode = @@init_connect;', 'SET LOCAL sql_mode = @@init_connect;', 'SET @@sql_mode = @@init_connect;',
    'SET @@SESSION.sql_mode = @@init_connect;', 'SET @@LOCAL.sql_mode = @@init_connect;', 'SET @a = @@init_connect;\nSET @b = @a;\nSET sql_mode = @b;',
    'SET @a = @@session.init_connect;\nSET SESSION sql_mode = @a;',
  ])('%s 뒤의 루틴은 거부하고, 그 SET 과 SQL_MODE 에 기대지 않는 문장은 받는다', (set) => {
    const at = set.split('\n').length + 1;
    expectRejected(run(`${set}\n${PROC}`), at, UNTRACKED);
    expect(run(`${set}\nALTER TABLE t ADD COLUMN y INT;`)).toMatchObject({ ok: true, applied: 1 });
  });

  it('@@unique_checks·@@sql_notes 를 sql_mode·FOREIGN_KEY_CHECKS 에 옮겨도 모르는 값이다 (Claude F6)', () => {
    expectRejected(run(`SET sql_mode = @@unique_checks;\n${PROC}`), 2, '시스템 변수 @@unique_checks 의 값은 이 도구가 따라가지 않아 알 수 없습니다');
    expectRejected(run(`SET @x = @@sql_notes;\nSET sql_mode = @x;\n${PROC}`), 3, '사용자 변수 @x 에 앞의 `SET @x = @@sql_notes` 문장이 알 수 없는 값을 넣었습니다');
    const fk = run('SET FOREIGN_KEY_CHECKS = @@unique_checks;\nALTER TABLE t ADD FOREIGN KEY (v) REFERENCES missing (id);');
    expectRejected(fk, 2, '세션 FOREIGN_KEY_CHECKS 를 알 수 없습니다', '@@unique_checks');
  });

  it('@@time_zone 도 값을 따라가지 않는다: 되돌린 시간대는 UTC 로 보지 않고 그 SET 을 밝혀 거부한다', () => {
    const r = run("SET time_zone = '+00:00';\nSET @tz = @@time_zone;\nSET time_zone = @tz;\nALTER TABLE t ADD ts TIMESTAMP NULL DEFAULT '2020-01-01 00:00:00';");
    expectRejected(r, 4, '앞의 `SET time_zone = @tz` 문장이 세션 시간대를 알 수 없는 값으로 정해', '@@time_zone');
  });

  it('값을 버리는 세션 변수에 옮기는 것은 지금처럼 받는다', () => {
    expect(run('SET unique_checks = @@sql_notes, @@session.sql_notes = @@init_connect;\nALTER TABLE t ADD COLUMN y INT;')).toMatchObject({ ok: true, applied: 1 });
  });
});

// 리뷰 11회차 R11-1 (10회차 R10-1 남은 가지): 처음 세션 SQL_MODE(서버가 기준 버전 루틴에서 짐작한 값)에서 온 IGNORE_SPACE 는 믿지 않지만, 스크립트가 SET SQL_MODE = '…'
// 리터럴로 정한 뒤에는 짐작한 값과 같아도 그 모드로 내장 함수를 가른다 — @@sql_mode·사용자 변수로 옮겨 되돌려도 같다 (12회차 R12-1). DEFAULT 나 짐작한 값을 저장한 변수로
// 돌아오면 다시 믿지 않는다 (보수적)
describe('처음 세션 SQL_MODE 의 IGNORE_SPACE', () => {
  const withSink = parseSqlDump(tdExport('CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\nCREATE TABLE `sink` (\n  `v` longtext\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;')).model;
  const NOW_FN = 'CREATE FUNCTION `now`() RETURNS INT DETERMINISTIC NO SQL RETURN 1;';
  const runIgnoreSpace = (...lines: string[]) => applyScript(withSink, [NOW_FN, ...lines].join('\n'), { schemaName: 'shop', sqlMode: 'IGNORE_SPACE' });
  const TAIL = ['SET @m=@@sql_mode;', 'INSERT INTO sink VALUES (NOW ());', 'ALTER TABLE t ADD y INT;', 'SET sql_mode=@m;', 'CREATE PROCEDURE p() SELECT 1;'];

  it("R11-1: 처음 값에 IGNORE_SPACE 가 있어도 SET sql_mode='IGNORE_SPACE' 뒤의 NOW () 는 내장 함수라 @m 을 잊지 않는다", () => {
    const r = runIgnoreSpace("SET sql_mode='IGNORE_SPACE';", ...TAIL);
    expect(r).toMatchObject({ ok: true, applied: 3 });
    expect(sqlModeOf(r, 'p')).toBe('IGNORE_SPACE');
  });

  it('SET 없이 처음 값 그대로이거나 DEFAULT 로 돌아온 세션의 NOW () 는 저장 함수 호출로 센다 (짐작한 값)', () => {
    expectRejected(runIgnoreSpace(...TAIL), TAIL.length + 1, '무시한 문장의 저장 함수 호출(`NOW`)');
    expectRejected(runIgnoreSpace("SET sql_mode='IGNORE_SPACE';", 'SET sql_mode = DEFAULT;', ...TAIL), TAIL.length + 3, '무시한 문장의 저장 함수 호출(`NOW`)');
  });

  // 리뷰 12회차 R12-1: 리터럴로 정한 SQL_MODE 를 @@sql_mode·사용자 변수로 옮겨 되돌려도 리터럴로 정한 값이다 — 11회차는 변수에서 되돌리면 짐작한 값으로 보았다
  it.each([
    ['@m 으로 되돌림 (Codex 재현)', ['SET @m=@@sql_mode;', 'SET sql_mode=@m;']], ['@@sql_mode 로 되돌림', ['SET sql_mode=@@sql_mode;']],
    ['@m 을 옮긴 @copy 로 되돌림', ['SET @m=@@sql_mode;', 'SET @copy=@m;', 'SET sql_mode=@copy;']], ['@@session.sql_mode 를 옮긴 변수', ['SET @s=@@session.sql_mode;', 'SET @@sql_mode=@s;']],
  ])("SET sql_mode='IGNORE_SPACE' 뒤 %s 해도 NOW () 는 내장 함수다", (_name, restore) => {
    const r = runIgnoreSpace("SET sql_mode='IGNORE_SPACE';", ...restore, ...TAIL);
    expect(r).toMatchObject({ ok: true, applied: 3 });
    expect(sqlModeOf(r, 'p')).toBe('IGNORE_SPACE');
  });

  it('리터럴을 담은 사용자 변수에서 정한 값도 리터럴이다 — 짐작한 값을 담았던 변수도 다시 저장하면 그 값을 따른다', () => {
    expect(sqlModeOf(runIgnoreSpace("SET @lit='IGNORE_SPACE';", 'SET sql_mode=@lit;', ...TAIL), 'p')).toBe('IGNORE_SPACE');
    expect(sqlModeOf(runIgnoreSpace('SET @m=@@sql_mode;', "SET @m='IGNORE_SPACE';", 'SET sql_mode=@m;', ...TAIL), 'p')).toBe('IGNORE_SPACE');
  });

  it('짐작한 값을 저장한 변수(옮긴 변수·같은 SET 의 앞 대입 전 값 포함)로 되돌리면 지금처럼 짐작한 값이다', () => {
    const counted = '무시한 문장의 저장 함수 호출(`NOW`)';
    expectRejected(runIgnoreSpace('SET @g=@@sql_mode;', 'SET @copy=@g;', "SET sql_mode='IGNORE_SPACE';", 'SET sql_mode=@copy;', ...TAIL), TAIL.length + 5, counted);
    expectRejected(runIgnoreSpace("SET sql_mode='IGNORE_SPACE', @g=@@sql_mode;", 'SET sql_mode=@g;', ...TAIL), TAIL.length + 3, counted);
    expectRejected(runIgnoreSpace("SET @g=@@sql_mode, sql_mode='IGNORE_SPACE';", 'SET sql_mode=@g;', ...TAIL), TAIL.length + 3, counted);
    expectRejected(runIgnoreSpace('SET sql_mode=DEFAULT;', 'SET sql_mode=@@sql_mode;', ...TAIL), TAIL.length + 3, counted);
  });
});

// 리뷰 11회차 Claude F7: 모르는 값을 다른 변수로 옮길 때마다 앞 까닭을 감싸, 옮기는 SET 이 이어진 스크립트(495,000자 — 서버 한도 안)의 안내가 220만 자가 됐다.
// 까닭이 500자를 넘으면 가운데를 줄여 앞(가장 가까운 대입)과 끝(값을 처음 모르게 만든 까닭)을 남긴다
describe('모르는 값의 까닭 글 길이', () => {
  it('옮기는 SET 이 45,000번 이어져도 안내는 짧고, 가장 가까운 대입과 처음 까닭을 밝힌다', () => {
    const lines = ['SET @a = @@global.sql_mode;'];
    for (let k = 0; k < 45000; k++) lines.push(k % 2 ? 'SET @a=@b;' : 'SET @b=@a;');
    lines.push('SET sql_mode=@a;', 'CREATE PROCEDURE p() SELECT 1;');
    const r = run(lines.join('\n'));
    expectRejected(r, lines.length, 'PROCEDURE `p` 은(는) 만들 때의 세션 SQL_MODE 를 기억하는데', '앞의 `SET sql_mode=@a` 문장이 세션 SQL_MODE 를 알 수 없는 값으로 정했습니다',
      '서버 변수 값(@@global·@@persist 의 sql_mode)은 알 수 없습니다', ' … ');
    expect(!r.ok && r.error.reason.length).toBeLessThan(700);
  });

  it('세션 값과 사용자 변수를 번갈아 옮겨도 같고, TIME_ZONE·FOREIGN_KEY_CHECKS 도 같다', () => {
    const chain = (target: string, source: string, dependent: string): ApplyResult => {
      const lines = [`SET ${target} = ${source};`];
      for (let k = 0; k < 2000; k++) lines.push(`SET @v${k} = @@${target};`, `SET ${target} = @v${k};`);
      return run([...lines, dependent].join('\n'));
    };
    for (const [r, root] of [
      [chain('sql_mode', '@@global.sql_mode', 'CREATE PROCEDURE p() SELECT 1;'), '서버 변수 값(@@global·@@persist 의 sql_mode)은 알 수 없습니다'],
      [chain('foreign_key_checks', '@never_saved', 'ALTER TABLE t ADD FOREIGN KEY (v) REFERENCES missing (id);'), '값을 저장하지 않은 변수입니다: @never_saved'],
    ] as const) {
      expectRejected(r, 4002, root);
      expect(!r.ok && r.error.reason.length).toBeLessThan(700);
    }
    const copies = Array.from({ length: 2000 }, (_, k) => (k % 2 ? 'SET @a = @b;' : 'SET @b = @a;'));
    const tz = run(['SET @a = @never_saved;', ...copies, 'SET time_zone = @a;', "ALTER TABLE t ADD ts TIMESTAMP NULL DEFAULT '2020-01-01 00:00:00';"].join('\n'));
    expectRejected(tz, 2003, '앞의 `SET time_zone = @a` 문장이 세션 시간대를 알 수 없는 값으로 정해', '값을 저장하지 않은 변수입니다: @never_saved');
    expect(!tz.ok && tz.error.reason.length).toBeLessThan(700);
  });
});

// 리뷰 11회차 Claude F9 (변이 M7 — setUnknown 의 st.timeZoneUtc = false): UTC 리터럴로 정한 뒤 모르는 값(@@global.time_zone)으로 다시 정한 time_zone 은 UTC 가 아니다.
// 저장 함수 호출이 끼지 않아도 TIMESTAMP 리터럴 기본값을 거부해야 한다 (호출이 끼면 그 호출이 먼저 UTC 를 지워 이 줄을 시험하지 않는다)
describe('UTC 로 정한 뒤 모르는 값으로 다시 정한 time_zone', () => {
  it('뒤의 TIMESTAMP 리터럴 기본값을 그 SET 을 밝혀 RE_EXPORT 로 거부한다', () => {
    const r = applyScript({ name: 'shop', tables: [], views: [], routines: [] },
      "CREATE TABLE t (id INT PRIMARY KEY);\nSET time_zone = '+00:00';\nSET time_zone = @@global.time_zone;\nALTER TABLE t ADD ts TIMESTAMP NULL DEFAULT '2020-01-01 00:00:00';", { schemaName: 'shop' });
    expectRejected(r, 4, '앞의 `SET time_zone = @@global.time_zone` 문장이 세션 시간대를 알 수 없는 값으로 정해', '서버 변수 값(@@global·@@persist 의 time_zone)은 알 수 없습니다');
  });
});
