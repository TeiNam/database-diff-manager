import { describe, expect, it } from 'vitest';
import { applyScript, type ApplyResult } from '../../src/apply';
import { RE_EXPORT } from '../../src/apply/types';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

// 리뷰 9회차 (Claude 참고 1): 값을 모르는 변수(저장하지 않았거나 무시한 문장의 저장 함수 호출 뒤 잊은 사용자 변수, @@global 서버 변수)를 읽는 SET 은 받는다. 그 밖의 세션
// 변수(UNIQUE_CHECKS·SQL_NOTES·CHARACTER_SET_*·COLLATION_* …)는 값을 버리고, 값을 쓰는 대상(사용자 변수와 세션 SQL_MODE·TIME_ZONE·FOREIGN_KEY_CHECKS)은 모르는 값을
// 기억해 그 값에 기대는 뒤 문장(루틴·TIMESTAMP 리터럴 기본값·FK 검사에 걸리는 문장)만 거부한다 (리뷰 10회차 — unknown-session.test.ts)
const base = parseSqlDump(tdExport('CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `v` int DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\n')).model;
const run = (script: string): ApplyResult => applyScript(base, script, { schemaName: 'shop' });
// 도우미 함수를 만들어 데이터를 고친 뒤 지우는 마이그레이션 (적용하는 문장 셋: CREATE·DROP FUNCTION, ALTER)
const HELPER = ['CREATE FUNCTION fn_bump(x INT) RETURNS INT DETERMINISTIC NO SQL RETURN x + 1;', 'UPDATE t SET v = fn_bump(v);', 'DROP FUNCTION fn_bump;', 'ALTER TABLE t ADD COLUMN c INT;'];
// 되돌린 세션 값에 기대는 문장: 루틴(SQL_MODE), TIMESTAMP 리터럴 기본값(TIME_ZONE), 부모 없는 FK(FOREIGN_KEY_CHECKS)
const PROC = 'CREATE PROCEDURE p() SELECT 1;';
const TS = "ALTER TABLE t ADD ts TIMESTAMP NULL DEFAULT '2020-01-01 09:00:00';";
const FK = 'ALTER TABLE t ADD FOREIGN KEY (v) REFERENCES missing (id);';

// mysqldump 8.0 머리·꼬리 (실행 주석 그대로)
const MYSQLDUMP_HEADER = [
  '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;', '/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;',
  '/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;', '/*!50503 SET NAMES utf8mb4 */;', '/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;',
  "/*!40103 SET TIME_ZONE='+00:00' */;", '/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;',
  '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;', "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;",
  '/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;',
];
const MYSQLDUMP_FOOTER = [
  '/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;', '/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;', '/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;',
  '/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;', '/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;',
  '/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;', '/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;', '/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;',
];
// MySQL Workbench 정방향 스크립트 머리·꼬리
const WORKBENCH_HEADER = [
  'SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0;', 'SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0;',
  "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';",
];
const WORKBENCH_FOOTER = ['SET SQL_MODE=@OLD_SQL_MODE;', 'SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;', 'SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS;'];

// index 번째 문장이 호출 전에 저장한 변수(variable)에서 되돌린 값에 기대어, 저장 함수가 바꿨을 수 있다고 알리며 RE_EXPORT 로 거부됐다
const expectSavedBeforeCall = (r: ApplyResult, index: number, variable: string): void => {
  expect(r).toMatchObject({ ok: false, error: { index } });
  if (r.ok) return;
  expect(r.error.reason).toContain(`사용자 변수 ${variable} 의 값을 알 수 없습니다 — 무시한 문장의 저장 함수 호출(\`fn_bump\`)이 이 변수를 바꿨을 수 있습니다`);
  expect(r.error.reason).toContain('호출 전에 저장한 값이지만 저장 함수는 어느 사용자 변수든 바꿀 수 있어 그 값을 그대로 쓰지 않는데');
  expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
};

describe('저장 함수 호출 뒤 값을 모르는 변수에서 되돌리는 SET', () => {
  it('mysqldump 머리·꼬리 사이에서 저장 함수를 불러도 꼬리의 복원은 받고, 뒤에서 되돌린 값에 기대면 호출 전에 저장한 값도 함수가 바꿨을 수 있다고 알린다', () => {
    const script = [...MYSQLDUMP_HEADER, ...HELPER, ...MYSQLDUMP_FOOTER];
    expect(run(script.join('\n'))).toMatchObject({ ok: true, applied: 3 });
    expectSavedBeforeCall(run([...script, PROC].join('\n')), script.length + 1, '@old_sql_mode');
    expectSavedBeforeCall(run([...script, TS].join('\n')), script.length + 1, '@old_time_zone');
    expectSavedBeforeCall(run([...script, FK].join('\n')), script.length + 1, '@old_foreign_key_checks');
  });

  it('Workbench 머리·꼬리 사이에서 저장 함수를 불러도 꼬리의 복원은 받고, 뒤 루틴은 거부한다', () => {
    const script = [...WORKBENCH_HEADER, ...HELPER, ...WORKBENCH_FOOTER];
    expect(run(script.join('\n'))).toMatchObject({ ok: true, applied: 3 });
    expectSavedBeforeCall(run([...script, PROC].join('\n')), script.length + 1, '@old_sql_mode');
  });

  it('값을 버리는 세션 변수만 저장·복원하는 머리·꼬리는 저장 함수를 불러도 받고, 모델은 ALTER 만 적용한 것과 같다', () => {
    const header = MYSQLDUMP_HEADER.filter((s) => !/TIME_ZONE|FOREIGN_KEY_CHECKS|SQL_MODE/.test(s));
    const footer = MYSQLDUMP_FOOTER.filter((s) => !/TIME_ZONE|FOREIGN_KEY_CHECKS|SQL_MODE/.test(s));
    const r = run([...header, ...HELPER, ...footer].join('\n'));
    const alterOnly = run(HELPER[3]);
    expect(r).toMatchObject({ ok: true, applied: 3 });
    expect(r.ok && alterOnly.ok && r.model).toEqual(alterOnly.ok && alterOnly.model);
  });

  const SAVE = 'SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, @OLD_SQL_NOTES=@@SQL_NOTES, @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT, @OLD_TIME_ZONE=@@TIME_ZONE, @OLD_SQL_MODE=@@SQL_MODE, @OLD_FK=@@FOREIGN_KEY_CHECKS;';

  it.each([
    'SET UNIQUE_CHECKS = @OLD_UNIQUE_CHECKS;', 'SET SQL_NOTES = @OLD_SQL_NOTES;', 'SET CHARACTER_SET_CLIENT = @OLD_CHARACTER_SET_CLIENT;', 'SET collation_connection = @old_collation_connection;',
    'SET @@session.unique_checks = @never_saved;', 'SET SESSION autocommit = @x, sql_notes = @y;', 'SET unique_checks = @@global.unique_checks;', 'SET NAMES utf8mb4, sql_notes = @OLD_SQL_NOTES;',
  ])('저장 함수 호출 뒤 값을 버리는 세션 변수의 %s 는 변수 값을 몰라도 받는다', (restore) => {
    expect(run([SAVE, ...HELPER, restore].join('\n'))).toMatchObject({ ok: true, applied: 3 });
  });

  it.each([
    ['SET TIME_ZONE = @OLD_TIME_ZONE;', [TS], '@old_time_zone'], ['SET SQL_MODE = @OLD_SQL_MODE;', [PROC], '@old_sql_mode'], ['SET FOREIGN_KEY_CHECKS = @OLD_FK;', [FK], '@old_fk'],
    ['SET @@session.sql_mode = @OLD_SQL_MODE;', [PROC], '@old_sql_mode'], ['SET @copy = @OLD_UNIQUE_CHECKS;', ['SET SQL_MODE = @copy;', PROC], '@old_unique_checks'],
    ['SET unique_checks = 1, time_zone = @OLD_TIME_ZONE;', [TS], '@old_time_zone'],
  ])('저장 함수 호출 뒤 값을 쓰는 %s 는 받고, 그 값에 기대는 뒤 문장은 호출 전에 저장한 변수여도 함수가 바꿨을 수 있다고 알리고 RE_EXPORT 로 거부한다', (restore, dependent, variable) => {
    expect(run([SAVE, ...HELPER, restore].join('\n'))).toMatchObject({ ok: true, applied: 3 });
    expectSavedBeforeCall(run([SAVE, ...HELPER, restore, ...dependent].join('\n')), 1 + HELPER.length + 1 + dependent.length, variable);
  });

  it('저장한 적 없는 변수에서 정한 값에 기대면 호출 전에 저장했다고 하지 않는다', () => {
    const r = run([...HELPER, 'SET SQL_MODE = @never_saved;', PROC].join('\n'));
    expect(r).toMatchObject({ ok: false, error: { index: HELPER.length + 2, reason: expect.stringContaining('사용자 변수 @never_saved 의 값을 알 수 없습니다') } });
    expect(!r.ok && r.error.reason).not.toContain('호출 전에 저장');
  });

  it('저장 함수 호출이 없어도 같다: 저장하지 않은 변수·서버 변수에서 되돌린 SET 은 받고, 값을 쓰는 대상이면 그 값에 기대는 뒤 문장을 거부한다', () => {
    expect(run('SET UNIQUE_CHECKS = @never_saved;\nSET sql_notes = @@global.sql_notes;\nALTER TABLE t ADD COLUMN c INT;')).toMatchObject({ ok: true, applied: 1 });
    expect(run('SET FOREIGN_KEY_CHECKS = @never_saved;\nALTER TABLE t ADD COLUMN c INT;')).toMatchObject({ ok: true, applied: 1 });
    expect(run(`SET FOREIGN_KEY_CHECKS = @never_saved;\n${FK}`)).toMatchObject({ ok: false, error: { index: 2, reason: expect.stringContaining('값을 저장하지 않은 변수입니다: @never_saved') } });
    expect(run('SET time_zone = @@global.time_zone;\nALTER TABLE t ADD COLUMN c INT;')).toMatchObject({ ok: true, applied: 1 });
    expect(run(`SET time_zone = @@global.time_zone;\n${TS}`)).toMatchObject({ ok: false, error: { index: 2, reason: expect.stringContaining('서버 변수 값') } });
  });

  it('값을 버리는 세션 변수에도 식은 쓸 수 없다 — 값 안의 저장 함수 호출이 숨지 않는다', () => {
    const r = run([HELPER[0], 'SET unique_checks = fn_bump(1);', HELPER[3]].join('\n'));
    expect(r).toMatchObject({ ok: false, error: { index: 2, reason: expect.stringContaining('SET 값은 리터럴·@변수·@@변수만 받습니다') } });
  });
});
