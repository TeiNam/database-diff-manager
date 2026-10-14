import { describe, expect, it } from 'vitest';
import { applyScript, type ApplyOptions, type ApplyResult } from '../../src/apply';
import { RE_EXPORT } from '../../src/apply/types';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

// 리뷰 11회차 Claude F4 (8.0.46·8.4.11 에서 mysql 클라이언트로 실측): MySQL 은 문장의 바이트를 세션 character_set_client 로 읽어 이름·COMMENT 는 utf8mb3 로, 문자열 리터럴은
// character_set_connection 으로 바꾼다. 스크립트는 UTF-8 이므로 SET NAMES latin1 뒤의 DEFAULT '가'·COMMENT '회원 이름'·`가` 는 'ê°€'·'íšŒì› ì´ë¦„'·`ê°€` 로 저장되고,
// connection 만 latin1 이어도 DEFAULT '가' 는 '?', ENUM('가','나') 는 1291 이다. 두 문자셋이 utf8mb4·utf8mb3·utf8·binary 가 아니면 ASCII 밖 글자가 든 DDL·루틴 문장을
// RE_EXPORT 로 거부한다. 처음 세션 문자셋은 utf8mb4 로 본다
const base = parseSqlDump(tdExport('CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;')).model;
const run = (script: string, opts: Partial<ApplyOptions> = {}): ApplyResult => applyScript(base, script, { schemaName: 'shop', ...opts });
const KOREAN = "ALTER TABLE t ADD c VARCHAR(10) DEFAULT '가' COMMENT '회원 이름';";
const ASCII = "ALTER TABLE t ADD c VARCHAR(10) DEFAULT 'a' COMMENT 'name';";
const expectRejected = (r: ApplyResult, index: number, ...parts: string[]): void => {
  expect(r).toMatchObject({ ok: false, error: { index } });
  if (r.ok) return;
  expect(r.error.reason).toContain('ASCII 밖 글자');
  for (const part of parts) expect(r.error.reason).toContain(part);
  expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
};

describe('UTF-8 이 아닌 세션 문자셋', () => {
  it.each([
    ['SET NAMES latin1;', 'character_set_client=latin1'], ['/*!40101 SET NAMES latin1 */;', 'character_set_client=latin1'], ["SET NAMES 'euckr';", 'character_set_client=euckr'],
    ['SET NAMES `latin1` COLLATE latin1_bin;', 'character_set_client=latin1'], ['SET CHARACTER SET latin1;', 'character_set_client=latin1'], ['SET CHARSET latin1;', 'character_set_client=latin1'],
    ['SET character_set_client = latin1;', 'character_set_client=latin1'], ["SET SESSION character_set_connection = 'latin1';", 'character_set_connection=latin1'],
    ['SET @@collation_connection = latin1_swedish_ci;', 'character_set_connection=latin1'],
  ])('%s 뒤의 ASCII 밖 글자가 든 DDL 은 RE_EXPORT 로 거부하고, ASCII 만 쓴 DDL 은 받는다', (set, part) => {
    expectRejected(run(`${set}\n${KOREAN}`), 2, part);
    expect(run(`${set}\n${ASCII}`)).toMatchObject({ ok: true, applied: 1 });
  });

  it('루틴·백틱 이름도 거부하고, 주석 속 글자와 무시하는 문장은 받는다', () => {
    expectRejected(run("SET NAMES latin1;\nCREATE PROCEDURE p() COMMENT '설명' SELECT 1;"), 2);
    expectRejected(run('SET NAMES latin1;\nALTER TABLE t ADD `이름` INT;'), 2);
    expect(run("SET NAMES latin1;\nINSERT INTO t VALUES (1);\nUPDATE t SET id = 2 WHERE '가' = '가';\nALTER TABLE t ADD c INT /* 메모 */;\n-- 끝\n")).toMatchObject({ ok: true, applied: 1 });
  });

  it('SET CHARACTER SET 은 character_set_connection 을 스키마 기본 문자셋으로 둔다 (MySQL: character_set_database)', () => {
    expectRejected(run(`SET CHARACTER SET utf8mb4;\n${KOREAN}`, { defaults: { charset: 'latin1' } }), 2, 'character_set_connection=latin1');
    expect(run(`SET CHARACTER SET utf8mb4;\n${KOREAN}`)).toMatchObject({ ok: true, applied: 1 });
  });
});

describe('UTF-8 계열·binary 세션과 되돌림', () => {
  it.each(['SET NAMES utf8mb4;', 'SET NAMES utf8;', 'SET NAMES utf8mb3;', 'SET NAMES binary;', 'SET NAMES utf8mb4 COLLATE utf8mb4_bin;', "SET NAMES latin1;\nSET NAMES 'UTF8MB4';",
    'SET GLOBAL character_set_client = latin1, PERSIST character_set_connection = latin1;', 'SET character_set_client = utf8, collation_connection = utf8mb4_0900_ai_ci;'])(
    '%s 뒤의 한글 DDL 은 받는다', (set) => {
      const r = run(`${set}\n${KOREAN}`);
      expect(r).toMatchObject({ ok: true, applied: 1 });
      if (r.ok) expect(r.model.tables[0].columns[1]).toMatchObject({ default: "'가'", comment: '회원 이름' });
    });

  it('mysqldump 테이블마다의 @saved_cs_client 저장·복원은 아는 값으로 되돌린다', () => {
    const r = run([
      '/*!40101 SET @saved_cs_client     = @@character_set_client */;', '/*!50503 SET character_set_client = utf8mb4 */;',
      "CREATE TABLE u (id INT PRIMARY KEY) COMMENT='회원';", '/*!40101 SET character_set_client = @saved_cs_client */;', KOREAN,
    ].join('\n'));
    expect(r).toMatchObject({ ok: true, applied: 2 });
  });

  it('@@character_set_client·@@character_set_connection 은 따라간 값이다 — latin1 을 저장했다 되돌리면 다시 거부한다', () => {
    expectRejected(run(`SET NAMES latin1;\nSET @cs = @@character_set_client, @cc = @@character_set_connection;\nSET NAMES utf8mb4;\nSET character_set_client = @cs;\n${KOREAN}`), 5, 'character_set_client=latin1');
    expectRejected(run(`SET NAMES latin1;\nSET @cc = @@session.character_set_connection;\nSET NAMES utf8mb4;\nSET character_set_connection = @cc;\n${KOREAN}`), 5, 'character_set_connection=latin1');
  });

  it('모르는 값(저장하지 않은 변수·DEFAULT·@@collation_connection 을 되돌림)이면 한글 DDL 은 그 까닭을 밝혀 거부하고 ASCII DDL 은 받는다', () => {
    for (const [set, part] of [
      ['SET character_set_client = @never_saved;', '값을 저장하지 않은 변수입니다: @never_saved'], ['SET NAMES DEFAULT;', 'DEFAULT'], ['SET character_set_connection = DEFAULT;', 'DEFAULT'],
      ['SET @c = @@collation_connection;\nSET collation_connection = @c;', '@@collation_connection'],
    ]) {
      const at = set.split('\n').length + 1;
      expectRejected(run(`${set}\n${KOREAN}`), at, '알 수 없어', part);
      expect(run(`${set}\n${ASCII}`)).toMatchObject({ ok: true, applied: 1 });
    }
  });
});
