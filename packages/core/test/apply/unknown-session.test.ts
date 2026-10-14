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
