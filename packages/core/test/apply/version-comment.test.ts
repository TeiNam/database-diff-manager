import { describe, expect, it } from 'vitest';
import { applyScript, type ApplyResult } from '../../src/apply';
import { RE_EXPORT } from '../../src/apply/types';
import { tokenize } from '../../src/lexer';
import { parseSqlDump, splitForApply, splitStatements } from '../../src/parse-dump';
import { tdExport } from '../helpers';

// 리뷰 11회차 R11-2·Claude F3: 실행 주석(/*!NNNNN …*/)의 버전 번호. MySQL 은 번호가 서버 버전 이하일 때만 안의 글을 실행하고 높으면 주석으로 건너뛴다
// (8.0.46·8.4.11 실측 — 8.0.46 은 80046 까지, 8.4.11 은 80411 까지 실행하고, 80500·99999 는 둘 다 건너뛴다). 8.0/8.4 를 함께 따르므로 80046 이하는 실행하고,
// 80047~80499 는 서버 버전에 따라 갈려 RE_EXPORT 로 거부하고, 80500 이상은 주석으로 본다. 덤프 파서와 함께 쓰는 렉서는 그대로다
const base = parseSqlDump(tdExport([
  'CREATE TABLE `parent` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  'CREATE TABLE `child` (\n  `id` int NOT NULL,\n  `p` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `p` (`p`),\n  CONSTRAINT `child_ibfk_1` FOREIGN KEY (`p`) REFERENCES `parent` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
].join('\n'))).model;
const run = (script: string): ApplyResult => applyScript(base, script, { schemaName: 'shop' });
const columnsOf = (r: ApplyResult, table = 't'): string[] | string => (r.ok ? r.model.tables.find((x) => x.name === table)!.columns.map((c) => c.name) : r.error.reason);
const sqlModeOf = (r: ApplyResult, name: string): string | undefined => (r.ok ? r.model.routines.find((x) => x.name === name)?.sqlMode : r.error.reason);
const expectReExport = (r: ApplyResult, index: number, ...parts: string[]): void => {
  expect(r).toMatchObject({ ok: false, error: { index } });
  if (r.ok) return;
  for (const part of parts) expect(r.error.reason).toContain(part);
  expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
};

describe('8.0·8.4 가 모두 건너뛰는 실행 주석 (80500 이상)', () => {
  it('통째로 감싼 문장은 주석뿐인 문장이라 적용하지 않는다 (문장 수에는 센다)', () => {
    const r = run('/*!99999 ALTER TABLE t ADD COLUMN phantom INT */;\nALTER TABLE t ADD COLUMN real_col INT;');
    expect(r).toMatchObject({ ok: true, applied: 1 });
    expect(columnsOf(r)).toEqual(['id', 'real_col']);
    expect(run('/*!80500 ALTER TABLE t ADD COLUMN phantom INT */;\nALTER TABLE nope ADD COLUMN x INT;')).toMatchObject({ ok: false, error: { index: 2 } });
    expect(run('/*!99999 ALTER TABLE t ADD COLUMN phantom INT */;')).toMatchObject({ ok: false, error: { index: 0, reason: '적용할 DDL 문장이 없습니다' } });
  });

  it('문장 가운데의 것은 그 글만 건너뛴다 (뒤에 이어진 문장도, 실행하는 주석 안에 든 것도)', () => {
    expect(columnsOf(run('ALTER TABLE t ADD d INT /*!90000 , ADD e INT */;'))).toEqual(['id', 'd']);
    expect(columnsOf(run('/*!99999 ALTER TABLE t ADD s1 INT */ ALTER TABLE t ADD s2 INT;'))).toEqual(['id', 's2']);
    expect(columnsOf(run('/*!40101 ALTER TABLE t ADD n1 INT /*!99999 , ADD n2 INT */ */;'))).toEqual(['id', 'n1']);
  });

  it('건너뛰는 SET 은 세션 값을 바꾸지 않는다 — 모르는 값도 그대로 모른다 (R11-2 형제)', () => {
    expect(sqlModeOf(run("SET sql_mode='STRICT_TRANS_TABLES';\n/*!99999 SET sql_mode='' */;\nCREATE PROCEDURE p() SELECT 1;"), 'p')).toBe('STRICT_TRANS_TABLES');
    const unknown = run("SET GLOBAL sql_mode='STRICT_TRANS_TABLES';\nSET SESSION sql_mode=@@global.sql_mode;\n/*!99999 SET SESSION sql_mode='' */;\nCREATE PROCEDURE p() SELECT 1;");
    expectReExport(unknown, 4, '서버 변수 값(@@global·@@persist 의 sql_mode)은 알 수 없습니다');
    expect(run('SET FOREIGN_KEY_CHECKS=0;\n/*!99999 SET FOREIGN_KEY_CHECKS=1 */;\nDROP TABLE parent;')).toMatchObject({ ok: true, applied: 1 });
  });

  it('루틴을 통째로 감싼 것은 건너뛰고, 루틴 정의 안의 것은 지금처럼 거부한다', () => {
    const wrapped = run('/*!99999 CREATE PROCEDURE p() SELECT 1 */;\nALTER TABLE t ADD c INT;');
    expect(wrapped).toMatchObject({ ok: true, applied: 1 });
    expect(wrapped.ok && wrapped.model.routines).toEqual([]);
    expectReExport(run('DELIMITER //\nCREATE PROCEDURE p() BEGIN /*!99999 SELECT 1; */ SELECT 2; END //\nDELIMITER ;'), 1, '루틴 정의 안의 실행 주석');
  });

  it('구분자가 건너뛰는 주석 안에 있으면 MySQL 처럼 닫히지 않은 주석으로 거부하고, 그 안의 주석은 RE_EXPORT 로 거부한다', () => {
    expect(run('/*!99999 SET @a = 1; SET @b = 2 */;\nALTER TABLE t ADD c INT;')).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining('(MySQL 1064)') } });
    expectReExport(run('/*!99999 ALTER TABLE t ADD c INT /* 메모 */ */;'), 1, '/*!99999');
    // 첫 '*/' 와 겹친 '/*/' 도 안의 주석이다: 서버는 '/*' 로 먼저 읽어 그 뒤 '*/' 까지 함께 건너뛰고 닫히지 않아 1064 다 (8.0.46·8.4.11 실측 — 13회차 전에는 a·b 를 더했다)
    expectReExport(run('ALTER TABLE t ADD a INT /*!99999 /*/ , ADD b INT */;'), 1, '/*!99999 안의 주석');
  });

  // 리뷰 12회차 R12-3·Claude F3 (8.0.46·8.4.11 에서 mysql 클라이언트로 실측): 건너뛰는 주석 안의 줄 주석은 mysql 클라이언트가 판과 설정에 따라 떼고 보내거나(8.0 기본) 그대로
  // 보내(8.4 기본·--comments) MySQL 이 건너뛰는 글이 갈린다 — 첫 재현은 8.0 이 1064, 8.4 가 real_col·second_col 이고, 셋째는 8.0 이 a, 8.4 가 1064 다. 렉서는 줄 주석으로 읽어
  // 닫는 '*/' 와 뒤 DDL 을 삼켰다 (11회차는 real_col 을 조용히 버렸고, 셋째는 a·b 였다)
  it.each([
    ['-- 가 닫는 */ 와 뒤 DDL 을 삼킨다 (Codex 재현)', '/*!99999 -- ignored */ ALTER TABLE t ADD real_col INT;\nALTER TABLE t ADD second_col INT;'],
    ['# 도 같다', '/*!99999 # ignored */ ALTER TABLE t ADD real_col INT;\nALTER TABLE t ADD second_col INT;'],
    ['# 줄 주석이 */ 를 담는다 (Claude 재현)', 'ALTER TABLE t ADD a INT /*!99999 # 나중에 */\n , ADD b INT */;'],
    ['-- 줄 주석이 */ 를 담는다 (CRLF)', 'ALTER TABLE t ADD a INT /*!99999 -- todo */\r\n , ADD b INT */;'],
    ['줄 주석이 다음 줄의 */ 앞에서 끝난다', 'ALTER TABLE t ADD a INT /*!99999 , ADD b INT --\tnote\n */;'],
  ])('건너뛰는 실행 주석 안의 줄 주석은 RE_EXPORT 로 거부한다 — %s', (_name, script) => {
    expectReExport(run(script), 1, '/*!99999', '줄 주석');
  });

  // 리뷰 13회차 F3: 문장 번호가 없는 거부라 서버·웹은 줄을 붙이지 않는다 — 안내 글에 그 줄을 밝힌다
  it('마지막 문장 뒤의 건너뛰는 주석 안에서 줄 주석이 DDL 을 삼켜도 거부하고, 안내에 그 줄을 밝힌다', () => {
    for (const end of ['', '\n', '\n*/\n']) {
      const r = run(`ALTER TABLE t ADD a INT;\n/*!99999 -- x */ ALTER TABLE t ADD c INT;${end}`);
      expect(r).toMatchObject({ ok: false, error: { index: 0, line: 2, reason: expect.stringContaining('줄 주석') } });
      expectReExport(r, 0, '마지막 문장 뒤(줄 2)의 건너뛰는 실행 주석 /*!99999 안의 줄 주석');
    }
    expect(columnsOf(run('ALTER TABLE t ADD a INT;\n/*!99999 */;\n/*!99999 x\n*/'))).toEqual(['id', 'a']);
  });

  it('줄 주석이 아닌 -- 와 건너뛰는 주석 밖의 줄 주석, 실행하는 주석 안의 줄 주석은 받는다', () => {
    expect(columnsOf(run('ALTER TABLE t ADD a INT /*!99999 , ADD b INT --*/;'))).toEqual(['id', 'a']);
    expect(columnsOf(run('ALTER TABLE t ADD a INT /*!99999 , ADD b INT */ -- 메모 */\n;'))).toEqual(['id', 'a']);
    expect(columnsOf(run('ALTER TABLE t ADD a INT /*!40101 , ADD b INT -- 메모\n */;'))).toEqual(['id', 'a', 'b']);
  });
});

describe('실행하는 실행 주석 (번호 없음, 80046 이하)', () => {
  it.each([
    ['/*!80046 ALTER TABLE t ADD COLUMN a INT */;', ['id', 'a']], ['/*! ALTER TABLE t ADD COLUMN a INT */;', ['id', 'a']],
    ['/*!40101 ALTER TABLE t ADD COLUMN a INT */;', ['id', 'a']], ['ALTER TABLE t ADD a INT /*!80023 INVISIBLE */;', ['id', 'a']],
    ['/*!80000ALTER TABLE t ADD COLUMN a INT */;', ['id', 'a']],
  ])('%s 는 안의 글을 실행한다', (sql, columns) => {
    expect(columnsOf(run(sql))).toEqual(columns);
  });

  // 리뷰 13회차 (8.0.46·8.4.11 에서 mysql 클라이언트로 실측): mysql 클라이언트는 '/*!' 안의 구분자에서도 문장을 끊어, 닫히지 않은 채 보낸 실행하는 주석을 MySQL 은 1064 로 거부한다
  // (13회차 전에는 그 문장과 뒤 문장을 적용했다). 서버는 안의 글을 실행하다 처음 만난 '*/' 에서 닫는다 — 따옴표·줄 주석 안의 '*/' 와 건너뛰는 주석을 닫은 '*/' 는 닫지 않는다
  it.each([
    ['문장을 감싼 주석', '/*!40101 ALTER TABLE t ADD c INT ;\n*/;\nALTER TABLE t ADD d INT;', 1],
    ['문장 가운데서 연 주석', 'ALTER TABLE t ADD c INT /*!40101 , ADD d INT ;\n*/;', 1],
    ['번호 없는 /*!', '/*! ALTER TABLE t ADD c INT ;\n*/;', 1],
    ['따옴표 안의 */', "/*!40101 ALTER TABLE t COMMENT '*/' ;\n*/;", 1],
    ['줄 주석 안의 */', '/*!40101 ALTER TABLE t ADD c INT -- x */\n;\n*/;', 1],
    ['안에서 건너뛰는 주석만 닫았다', '/*!40101 ALTER TABLE t ADD c INT /*!99999 , ADD d INT */ ;\n*/;', 1],
    ['파일 끝에서 끊긴 마지막 문장', 'ALTER TABLE t ADD a INT;\n/*!40101 ALTER TABLE t ADD c INT', 2],
    ['문장 없는 덩어리', '/*!40101 ;\nALTER TABLE t ADD c INT */;\nALTER TABLE t ADD d INT;', 1],
    ['문장 없는 덩어리 — 뒤 덩어리에서 닫는다', '/*!40101 ;\n*/;\nALTER TABLE t ADD c INT;', 1],
  ])('구분자까지 닫히지 않은 실행하는 주석은 1064 로 거부한다 — %s', (_name, script, index) => {
    expect(run(script)).toMatchObject({ ok: false, error: { index, reason: expect.stringContaining('(MySQL 1064)') } });
  });

  it('안에서 연 실행하는 주석은 처음 만난 */ 에서 함께 닫히고, 마지막 문장 뒤의 것은 앞 DDL 을 모두 적용한 뒤라 받는다', () => {
    expect(columnsOf(run('/*!40101 ALTER TABLE t ADD a INT /*!40101 , ADD b INT */ ;'))).toEqual(['id', 'a', 'b']);
    expect(columnsOf(run('ALTER TABLE t ADD a INT;\n/*!40101 ;\n'))).toEqual(['id', 'a']);
  });
});

describe('서버 버전에 따라 실행 여부가 갈리는 실행 주석', () => {
  it.each(['80047', '80400', '80411', '80412', '80499'])('/*!%s …*/ 는 8.0.46 이 건너뛰고 8.4 판에 따라 실행해 RE_EXPORT 로 거부한다', (version) => {
    expectReExport(run(`/*!${version} ALTER TABLE t ADD COLUMN a INT */;`), 1, `/*!${version}`, '서버 버전');
    expectReExport(run(`ALTER TABLE t ADD a INT /*!${version} , ADD b INT */;`), 1, `/*!${version}`);
  });

  it.each(['1', '8004', '100000', '800460'])('번호가 다섯 자리가 아닌 /*!%s …*/ 는 RE_EXPORT 로 거부한다 (MySQL 8.0·8.4 가 번호를 다르게 읽는다)', (digits) => {
    expectReExport(run(`/*!${digits} ALTER TABLE t ADD COLUMN a INT */;`), 1, `/*!${digits}`, '다섯 자리');
  });
});

// 리뷰 13회차 F2·R13-2 (8.0.46·8.4.11 에서 mysql 클라이언트로 실측): 마지막 문장 뒤의 줄 주석 검사가 80500 이상만 봐, 80047~80499 와 여섯 자리 번호에서는 줄 주석이 첫 '*/' 를
// 가려 뒤 DDL 이 조용히 빠졌다. 줄 주석을 그대로 보내는 8.4 클라이언트로 그 번호를 건너뛰는 서버에 실행하면 MySQL 은 첫 '*/' 뒤의 ALTER 를 실행한다 (80047·80400 은 8.0.46 이,
// 80499 는 둘 다, 여섯 자리 100000 은 8.4.11 이 건너뛴다). 어느 판이든 건너뛸 수 있는 번호(다섯 자리 80047 이상, 여섯 자리 이상)를 모두 보고, 거부 안내에 그 줄을 밝힌다 (F3)
describe('마지막 문장 뒤의 실행 주석', () => {
  it.each([
    ['여섯 자리 번호 (Claude 재현 1)', '/*!100000 -- x */ ALTER TABLE t ADD c INT;', '/*!100000'],
    ['여섯 자리 번호의 #', '/*!100000 # x */ ALTER TABLE t ADD c INT;', '/*!100000'],
    ['80047~80499 (Claude 재현 2)', '/*!80400 -- x */ ALTER TABLE t ADD c INT;', '/*!80400'],
    ['가장 낮은 80047', '/*!80047 -- x */ ALTER TABLE t ADD c INT;', '/*!80047'],
    ['80499 (Codex 재현)', '/*!80499 -- ignored */ ALTER TABLE t ADD real_col INT;', '/*!80499'],
    ['80499 의 # 와 CRLF', '/*!80499 # ignored */ ALTER TABLE t ADD real_col INT;\r\n', '/*!80499'],
  ])('판에 따라 건너뛰는 번호에서 줄 주석이 첫 */ 를 가리면 RE_EXPORT 로 거부하고 그 줄을 밝힌다 — %s', (_name, tail, mark) => {
    const r = run(`ALTER TABLE t ADD a INT;\r\n\r\n${tail}`);
    expect(r).toMatchObject({ ok: false, error: { index: 0, line: 3 } });
    expectReExport(r, 0, `마지막 문장 뒤(줄 3)의 서버 버전에 따라 건너뛰는 실행 주석 ${mark} 안의 줄 주석`);
  });

  // 변이 M4 (리뷰 13회차 F4 — 번호를 보지 않으면 실행하는 주석도 거부한다): 실행하는 주석 안의 줄 주석은 MySQL 도 줄 주석이라 뒤 DDL 을 실행하지 않는다. 판에 따라 갈리는 번호도
  // 줄 주석이 첫 '*/' 앞 줄에서 끝나면 건너뛰든 실행하든 같다 (8.0.46·8.4.11 실측 — 오류가 나도 앞 DDL 을 모두 적용한 뒤다)
  it.each([
    '/*!40101 -- x */ ALTER TABLE t ADD c INT;', '/*!80046 -- x */ ALTER TABLE t ADD c INT;', '/*! -- x */ ALTER TABLE t ADD c INT;', '/*!1 # x */ ALTER TABLE t ADD c INT;',
    '/*!80499 -- 메모\n*/;', '/*!100000 # 메모\r\n*/;', '/*!80400 -- 닫지 않은 주석',
  ])('%j 는 받는다', (tail) => {
    expect(columnsOf(run(`ALTER TABLE t ADD a INT;\n${tail}`))).toEqual(['id', 'a']);
  });

  it('8.0·8.4 가 모두 건너뛰는 번호 안의 줄 주석은 첫 */ 를 가리지 않아도 거부한다 (문장 안·문장 없는 덩어리와 같다 — 보수적)', () => {
    expectReExport(run('ALTER TABLE t ADD a INT;\n/*!99999 -- 메모\n*/;'), 0, '마지막 문장 뒤(줄 2)의 건너뛰는 실행 주석 /*!99999 안의 줄 주석');
  });

  // 안의 주석: MySQL 은 한 겹을 주석으로 읽어 닫는 '*/' 가 뒤로 밀리는데, 그 '*/' 를 가린 줄 주석은 첫 '*/' 까지만 보면 놓친다 (8.4 클라이언트로 실행하면 c 를 더한다).
  // 실행하는 번호 안의 것도 거부한다 (리뷰 14회차 F1 — 이 꼴은 두 클라이언트 모두 1064 지만, 끝에 '*/' 를 하나 더 두면 8.0 클라이언트만 c 를 더한다 — 보수적)
  it('어느 판이든 건너뛸 수 있는 번호 안의 주석은 RE_EXPORT 로 거부한다', () => {
    expectReExport(run('ALTER TABLE t ADD a INT;\n/*!99999 /* x */ -- y */ ALTER TABLE t ADD c INT;'), 0, '마지막 문장 뒤(줄 2)의 건너뛰는 실행 주석 /*!99999 안의 주석');
    expectReExport(run('ALTER TABLE t ADD a INT;\n/*!80400 /*!99999 */ -- y */ ALTER TABLE t ADD c INT;'), 0, '서버 버전에 따라 건너뛰는 실행 주석 /*!80400 안의 주석');
    expectReExport(run('ALTER TABLE t ADD a INT;\n/*!99999 /*/ */ -- y */ ALTER TABLE t ADD c INT;'), 0, '/*!99999 안의 주석'); // 첫 */ 와 겹친 /*/ 도 서버는 주석으로 연다
    expectReExport(run('ALTER TABLE t ADD a INT;\n/*!40101 /* x */ -- y */ ALTER TABLE t ADD c INT;'), 0, '마지막 문장 뒤(줄 2)의 실행 주석 /*!40101 안의 주석');
  });

  // 변이 N28 (리뷰 14회차 F4 — 번호 바로 뒤에 붙은 '/*' 를 놓친다): 서버는 공백 없이 붙은 '/*' 도 건너뛰는 주석 안의 한 겹 주석으로 읽어 둘째 '*/' 까지 건너뛴다 (8.0.46·8.4.11
  // 에서 mysql 클라이언트로 실측: 8.4 클라이언트는 첫째에 a 만, 둘째에 a·c 를 더하고, 8.0 클라이언트는 둘 다 그 문장에서 1064 다). 변이는 a·b 와 a 를 냈다
  it('번호 바로 뒤에 붙은 주석도 안의 주석으로 거부한다', () => {
    expectReExport(run('ALTER TABLE t ADD a INT /*!99999/* x */ , ADD b INT */;'), 1, '건너뛰는 실행 주석 /*!99999 안의 주석은 받지 않습니다');
    expectReExport(run('ALTER TABLE t ADD a INT;\n/*!99999/* x */ -- y */ ALTER TABLE t ADD c INT;'), 0, '마지막 문장 뒤(줄 2)의 건너뛰는 실행 주석 /*!99999 안의 주석은 받지 않습니다');
    expectReExport(run('/*!99999/* x */ */;\nALTER TABLE t ADD c INT;'), 1, '앞 문장 뒤(줄 1)의 건너뛰는 실행 주석 /*!99999 안의 주석은 받지 않습니다');
  });

  it('문장이 없는 스크립트면 스크립트의 줄을 밝힌다', () => {
    expectReExport(run('-- 메모\n/*!80400 -- x */ ALTER TABLE t ADD c INT;'), 0, '스크립트(줄 2)의 서버 버전에 따라 건너뛰는 실행 주석 /*!80400');
  });
});

describe('문장 나누기와 렉서 (덤프 파서와 함께 쓴다)', () => {
  it('splitForApply 는 splitDump 와 같은 문장에 원문 자리와 실행 주석 표지를 더하고, 마지막 문장 뒤의 표지는 따로 둔다', () => {
    const text = "-- 머리\n/*!40101 SET NAMES utf8 */;\n/*!99999 ALTER TABLE t ADD x INT */;\nALTER TABLE t ADD y INT /*!90000 , ADD z INT */;\n/*!99999 */;";
    const { statements, trailing } = splitForApply(text);
    expect(statements.map(({ ddl, line }) => ({ ddl, line }))).toEqual(splitStatements(text));
    expect(statements.map((s) => [text.slice(s.offset, s.offset + 3), s.marks.map((m) => [text.slice(m.at, m.at + 3), m.digits])])).toEqual([
      ['SET', [['/*!', '40101']]], ['ALT', [['/*!', '99999']]], ['ALT', [['/*!', '90000']]],
    ]);
    expect(trailing).toEqual({ marks: [{ at: text.lastIndexOf('/*!'), digits: '99999' }], spaces: [], closes: [text.lastIndexOf('*/')], nested: [], hints: [] });
    // 렉서가 실행 주석을 닫은 '*/' 와 문장 없이 끝난 덩어리의 구분자 (리뷰 13회차): 따옴표 안의 '*/' 는 닫지 않는다
    const quoted = "/*!99999 */;\n;\n/*!40101 ALTER TABLE t COMMENT '*/' */;";
    const [s] = splitForApply(quoted).statements;
    expect([s.closes, s.leading.closes, s.leading.ends]).toEqual([[quoted.lastIndexOf('*/')], [quoted.indexOf('*/')], [quoted.indexOf(';'), quoted.indexOf(';', quoted.indexOf(';') + 1)]]);
  });

  // 리뷰 14회차 F3: mysql 클라이언트가 인자 뒤를 버리는 DELIMITER 줄의 표지·닫힘·안의 주석은 뺀다 (마지막 문장 뒤의 것도). 그 줄의 닫히지 않은 표지 안에 뒤 주석이 있다고 보지도 않는다
  it('splitForApply 는 DELIMITER 줄의 인자 뒤 실행 주석을 mysql 클라이언트처럼 버린다', () => {
    const text = 'DELIMITER ;; /*!40101 /* z */ */ /*!99999 w\nSELECT 1 /* v */;;\nDELIMITER ; /*!40101 */';
    const { statements: [s], trailing } = splitForApply(text);
    expect([s.leading.marks, s.leading.closes, s.leading.nested, s.marks, s.closes, s.nested, trailing.marks, trailing.closes]).toEqual([[], [], [], [], [], [], [], []]);
  });

  // 리뷰 14회차 F1: 렉서는 실행 주석 안에서 연 일반 주석('/*!'·'/*+' 는 아니다)과 그때 가장 안쪽 표지를 알린다 (닫힌 뒤의 주석은 아니다)
  it('splitForApply 는 실행 주석 안에서 연 일반 주석과 그 표지를 알린다', () => {
    const text = 'ALTER TABLE t ADD a INT /*!40101 , ADD b INT /* x */ /*+ h */ /*!99999 /* w */ */ */ /* y */;';
    const [s] = splitForApply(text).statements;
    const mark = (digits: string) => ({ at: text.indexOf(`/*!${digits}`), digits });
    expect(s.nested).toEqual([{ at: text.indexOf('/* x'), mark: mark('40101') }, { at: text.indexOf('/* w'), mark: mark('99999') }]);
    expect(s.hints).toEqual([text.indexOf('/*+')]); // 힌트는 따로 알린다 (DELIMITER 줄 앞의 것을 거부한다)
  });

  it('렉서는 버전 번호와 상관없이 실행 주석의 내용을 토큰으로 읽는다 (덤프의 /*!80023 INVISIBLE */)', () => {
    expect(tokenize('KEY `k` (`c`) /*!99999 INVISIBLE */').map((t) => t.v)).toEqual(['KEY', 'k', '(', 'c', ')', 'INVISIBLE']);
    const dump = parseSqlDump(tdExport('CREATE TABLE `v` (\n  `id` int NOT NULL,\n  `c` int DEFAULT NULL /*!80023 INVISIBLE */,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;'));
    expect(dump.warnings).toEqual([]);
    expect(dump.model.tables[0].columns.map((c) => [c.name, c.invisible])).toEqual([['id', false], ['c', true]]);
  });
});

// 리뷰 12회차 Claude F5 (변이 M15 — parse-dump.ts ChunkLog.take 의 표지 걸러내기): 문장 없이 끝난 덩어리('/*!80400 */;')와 DELIMITER 줄의 실행 주석 표지는 뒤 문장의 것이
// 아니다. 안에 토큰이 없어 판에 따라 갈리는 번호도 8.0·8.4 가 실행하든 건너뛰든 같다 (8.0.46·8.4.11 실측). 번호를 다르게 읽는 것과 건너뛰는 것 안의 주석·줄 주석은 문장 안의
// 것처럼 거부한다
describe('문장 없이 끝난 덩어리의 실행 주석', () => {
  it.each(['/*!80400 */;', '/*!80047 */ ;', '/*!40101 */;', '/*! */;', '/*!99999 */;\n/*!80499 -- 메모\n*/;', 'DELIMITER ;; /*!80400 */\nDELIMITER ;'])(
    '%j 뒤의 DDL 도 적용한다', (chunk) => {
      expect(columnsOf(run(`${chunk}\nALTER TABLE t ADD c INT;`))).toEqual(['id', 'c']);
    });

  it('건너뛰는 주석 안의 주석·줄 주석과 다섯 자리가 아닌 번호는 거부한다', () => {
    expectReExport(run('/*!99999 -- 메모\n*/;\nALTER TABLE t ADD c INT;'), 1, '/*!99999', '줄 주석');
    expectReExport(run('/*!99999 /* 메모 */ */;\nALTER TABLE t ADD c INT;'), 1, '/*!99999', '안의 주석');
    expectReExport(run('/*!1 */;\nALTER TABLE t ADD c INT;'), 1, '/*!1', '다섯 자리');
  });

  // 변이 M25 (리뷰 13회차 F4 — 덩어리의 건너뛰는 주석을 뒤 문장 끝까지 닫힌 것으로 본다): 구분자가 주석 안에 있어 mysql 클라이언트가 첫 덩어리('/*!99999 ')를 보내고 MySQL 은 1064 다.
  // 뒤의 문장 없는 덩어리에서 닫혀도 같다 (8.0.46·8.4.11 실측 — 13회차 전에는 뒤 문장까지 닫힌 것으로 봐 받았다)
  it.each([
    '/*!99999 ;\nALTER TABLE t ADD c INT */;', '/*!99999 ;\n*/;\nALTER TABLE t ADD c INT;', '/*!80400 ;\n*/;\nALTER TABLE t ADD c INT;',
  ])('건너뛰는 주석이 덩어리 안에서 닫히지 않으면 뒤에서 닫혀도 1064 로 거부한다 — %j', (script) => {
    expect(run(script)).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining('(MySQL 1064)') } });
  });

  // 리뷰 13회차 F2 (8.0.46·8.4.11 에서 mysql 클라이언트로 실측): 판에 따라 갈리는 번호를 받는 전제(건너뛰든 실행하든 같다)가 깨지는 것은 거부한다 — 첫 '*/' 를 가린 줄 주석은
  // 8.4 클라이언트로 8.0.46 에 실행하면 그 '*/' 뒤의 ALTER 를 실행하고(c·d, 8.4.11 은 d), 안의 주석은 8.0 클라이언트가 1064 를 내며, 덩어리 안에서 닫히지 않으면 1064 다
  it('판에 따라 갈리는 번호의 첫 */ 를 가린 줄 주석·안의 주석·닫히지 않은 것은 거부한다', () => {
    expectReExport(run('/*!80400 -- x */ ALTER TABLE t ADD c INT /*\n*/;\nALTER TABLE t ADD d INT;'), 1, '서버 버전에 따라 건너뛰는 실행 주석 /*!80400 안의 줄 주석');
    expectReExport(run('/*!80400 # x */ ALTER TABLE t ADD c INT /*\r\n*/;\r\nALTER TABLE t ADD d INT;'), 1, '/*!80400 안의 줄 주석');
    expectReExport(run('/*!80400 /* x */ -- y */ ALTER TABLE t ADD c INT /*\n*/;\nALTER TABLE t ADD d INT;'), 1, '/*!80400 안의 주석');
    expectReExport(run('/*!80400 /* 메모 */ */;\nALTER TABLE t ADD d INT;'), 1, '/*!80400 안의 주석');
    expect(run('/*!80400 ;\nALTER TABLE t ADD c INT */;\nALTER TABLE t ADD d INT;')).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining('(MySQL 1064)') } });
  });

  // 리뷰 14회차 F2: 문장 앞 덩어리의 거부는 뒤 문장의 번호로 안내해 서버·웹이 그 문장의 줄을 붙인다 — 표지가 있는 줄을 앞말로 밝히고(unicode-space.ts 의 앞 문장 뒤 NBSP 와 같다),
  // 덩어리의 것은 '문장 안에서' 대신 '구분자까지' 로 적는다 (mysql 클라이언트는 첫째와 마지막을 'ERROR 1064 … at line 2' 로 알린다)
  it.each([
    ['닫히지 않은 실행하는 주석 (Claude 재현)', 'ALTER TABLE t ADD a INT;\n/*!40101 ;\n\n\nALTER TABLE t ADD b INT;', 5, '앞 문장 뒤(줄 2)의 실행 주석 /*!40101 가 구분자까지 닫히지 않았습니다 (MySQL 1064)'],
    ['판에 따라 갈리는 번호의 줄 주석', 'ALTER TABLE t ADD a INT;\n/*!80400 -- x */ ALTER TABLE t ADD c INT /*\n*/;\n\nALTER TABLE t ADD d INT;', 5, '앞 문장 뒤(줄 2)의 서버 버전에 따라 건너뛰는 실행 주석 /*!80400 안의 줄 주석'],
    ['판에 따라 갈리는 번호 안의 주석', 'ALTER TABLE t ADD a INT;\n/*!80400 /* x */ */;\n\nALTER TABLE t ADD d INT;', 4, '앞 문장 뒤(줄 2)의 서버 버전에 따라 건너뛰는 실행 주석 /*!80400 안의 주석'],
    ['뒤 덩어리에서 닫힌 건너뛰는 주석', 'ALTER TABLE t ADD a INT;\n/*!99999 ;\n*/;\n\nALTER TABLE t ADD d INT;', 5, '앞 문장 뒤(줄 2)의 건너뛰는 실행 주석 /*!99999 가 구분자까지 닫히지 않았습니다 (MySQL 1064)'],
    ['다섯 자리가 아닌 번호', 'ALTER TABLE t ADD a INT;\n\n/*!1 */;\nALTER TABLE t ADD d INT;', 4, '앞 문장 뒤(줄 3)의 실행 주석 /*!1 의 버전 번호가 다섯 자리가 아닙니다'],
    ['DELIMITER 줄 앞에서 닫히지 않은 주석', 'ALTER TABLE t ADD a INT;\n/*!40101\nDELIMITER ;;\nCREATE PROCEDURE p() SELECT 1;;', 4, '앞 문장 뒤(줄 2)의 실행 주석 /*!40101 가 DELIMITER 줄 앞에서 닫히지 않았습니다 (MySQL 1064)'],
  ])('문장 앞 덩어리의 거부는 표지가 있는 줄을 밝힌다 — %s', (_name, script, line, reason) => {
    const r = run(script);
    expect(r).toMatchObject({ ok: false, error: { index: 2, line } });
    expect(!r.ok && r.error.reason).toContain(reason);
  });

  // 리뷰 14회차 F3 (8.0.46·8.4.11 에서 mysql 클라이언트로 실측 — 넷 모두 a·b 와 루틴 p): mysql 클라이언트는 DELIMITER 줄의 인자 뒤를 버린다 (com_delimiter·get_arg). 그 줄의 실행
  // 주석은 덩어리 검사에서 뺀다 (13회차는 닫히지 않은 '/*!40101 x' 를 MySQL 1064 로, 12회차부터 '/*!99999 x' 도 1064 로 거부했다). 문장 나누기가 그 줄 끝에서 렉서를 새로
  // 읽혀 뒤 글을 닫히지 않은 그 주석 안의 것으로 보지 않는다 — 뒤의 일반 주석('/* 메모 */')을 실행 주석 안의 주석으로 거부하지 않는다
  it.each([
    ['닫히지 않은 실행하는 주석 (Claude 재현)', 'DELIMITER ;; /*!40101 x'],
    ['닫히지 않은 건너뛰는 주석', 'DELIMITER ;; /*!99999 x'],
    ['판에 따라 갈리는 번호와 다섯 자리가 아닌 번호', 'DELIMITER ;; /*!80400 x /*!1 y'],
    ['안의 주석', 'DELIMITER ;; /*!40101 /* x */ y'],
  ])('DELIMITER 줄의 인자 뒤 실행 주석은 mysql 클라이언트처럼 버린다 — %s', (_name, command) => {
    const r = run(`ALTER TABLE t ADD a INT;\n${command}\nCREATE PROCEDURE p() SELECT 1;;\nDELIMITER ;\nALTER TABLE t ADD b INT /* 메모 */;`);
    expect(columnsOf(r)).toEqual(['id', 'a', 'b']);
    expect(r.ok && r.model.routines.map((x) => x.name)).toEqual(['p']);
  });

  it('마지막 문장 뒤의 DELIMITER 줄도 같다 (넷 모두 a)', () => {
    expect(columnsOf(run('ALTER TABLE t ADD a INT;\nDELIMITER ;; /*!99999 -- x */ ALTER TABLE t ADD c INT;'))).toEqual(['id', 'a']);
  });

  // 그 주석이 닫히지 않은 것으로 읽지 않으므로 뒤의 짝 없는 '*/' 는 MySQL 처럼 글로 남는다 (넷 모두 a·c 뒤 4번째 줄에서 1064 — 그 주석의 닫힘으로 읽으면 d 를 더한다)
  it('DELIMITER 줄의 닫히지 않은 실행 주석 뒤의 짝 없는 */ 는 문장의 글이다', () => {
    const r = run('ALTER TABLE t ADD a INT;\nDELIMITER ;; /*!99999\nALTER TABLE t ADD c INT;;\n*/ ALTER TABLE t ADD d INT;;\nDELIMITER ;');
    expect(r).toMatchObject({ ok: false, error: { index: 3, line: 4 } });
  });

  // 리뷰 14회차 (8.0.46·8.4.11 에서 mysql 클라이언트로 실측): mysql 클라이언트는 버퍼가 비었을 때만 DELIMITER 줄을 명령으로 읽는다 (8.4 는 버퍼가 공백·블록 주석뿐일 때도 — 실행 주석도
  // 블록 주석으로 보고 버린다). 구분자 없이 그 앞에 둔 실행 주석은 8.0 클라이언트가 버퍼에 남겨 DELIMITER 줄을 문장의 글로 보내 1064 이고, 8.4 클라이언트는 그 주석을 버리고 뒤
  // 루틴·ALTER 를 실행한다 (뒤에 줄 주석을 두면 8.4 도 1064). 판에 따라 갈려 거부한다 — 13회차까지는 받았다. ';' 로 끝낸 것은 두 클라이언트 모두 받는다
  it.each([
    ['실행하는 주석', 'ALTER TABLE t ADD a INT;\n/*!40101 */\nDELIMITER ;;\nCREATE PROCEDURE p() SELECT 1;;\nDELIMITER ;\nALTER TABLE t ADD b INT;', 2, 2],
    ['건너뛰는 주석', 'ALTER TABLE t ADD a INT;\n/*!99999 */\nDELIMITER ;;\nCREATE PROCEDURE p() SELECT 1;;\nDELIMITER ;\nALTER TABLE t ADD b INT;', 2, 2],
    ['DELIMITER 줄 사이', 'ALTER TABLE t ADD a INT;\nDELIMITER ;;\n/*!99999 */\n\nDELIMITER $$\nCREATE PROCEDURE p() SELECT 1$$\nDELIMITER ;\nALTER TABLE t ADD b INT;', 2, 3],
    ['뒤에 줄 주석 (두 클라이언트 모두 1064)', 'ALTER TABLE t ADD a INT;\n/*!80400 */ -- memo\nDELIMITER ;;\nCREATE PROCEDURE p() SELECT 1;;\nDELIMITER ;\nALTER TABLE t ADD b INT;', 2, 2],
    ['스크립트 맨 앞', '/*!40101 */\nDELIMITER ;;\nCREATE PROCEDURE p() SELECT 1;;\nDELIMITER ;', 1, 1],
  ])('구분자 없이 실행 주석 바로 뒤에 둔 DELIMITER 줄은 RE_EXPORT 로 거부한다 — %s', (_name, script, index, line) => {
    expectReExport(run(script), index, `앞 문장 뒤(줄 ${line})의 실행 주석 /*!`, 'DELIMITER 줄');
  });

  // 힌트('/*+ … */')도 같다 (8.0.46·8.4.11 에서 mysql 클라이언트로 실측): 8.0 클라이언트는 버퍼에 남겨 DELIMITER 줄을 문장으로 보내 1064 이고, 8.4 클라이언트는 블록 주석으로 보고 버려
  // a·b 와 루틴 p 를 더한다. 렉서는 일반 주석으로 건너뛰어 13회차까지는 받았다
  it('구분자 없이 힌트 바로 뒤에 둔 DELIMITER 줄도 RE_EXPORT 로 거부한다', () => {
    const script = 'ALTER TABLE t ADD a INT;\n/*+ x */\nDELIMITER ;;\nCREATE PROCEDURE p() SELECT 1;;\nDELIMITER ;\nALTER TABLE t ADD b INT;';
    expectReExport(run(script), 2, '앞 문장 뒤(줄 2)의 힌트 /*+', 'DELIMITER 줄');
  });

  it("';' 로 끝낸 실행 주석 뒤의 DELIMITER 줄은 받는다 (넷 모두 a·b 와 루틴 p)", () => {
    const r = run('ALTER TABLE t ADD a INT;\n/*!40101 */;\nDELIMITER ;;\nCREATE PROCEDURE p() SELECT 1;;\nDELIMITER ;\nALTER TABLE t ADD b INT;');
    expect(columnsOf(r)).toEqual(['id', 'a', 'b']);
    expect(r.ok && r.model.routines.map((x) => x.name)).toEqual(['p']);
  });

  // 리뷰 15회차 F6 (변이 P1 — 앞 덩어리를 끝낸 ';' 앞의 힌트도 DELIMITER 줄 앞의 것으로 본다): ';' 로 끝낸 힌트는 두 클라이언트 모두 주석뿐인 문장으로 보내고 버퍼를 비운다
  // (8.0.46·8.4.11 에서 mysql 클라이언트로 실측)
  it("';' 로 끝낸 힌트 뒤의 DELIMITER 줄도 받는다 (넷 모두 a·b 와 루틴 p)", () => {
    const r = run('ALTER TABLE t ADD a INT;\n/*+ x */;\nDELIMITER ;;\nCREATE PROCEDURE p() SELECT 1;;\nDELIMITER ;\nALTER TABLE t ADD b INT;');
    expect(columnsOf(r)).toEqual(['id', 'a', 'b']);
    expect(r.ok && r.model.routines.map((x) => x.name)).toEqual(['p']);
  });
});

// 리뷰 14회차 (8.0.46·8.4.11 에서 mysql 클라이언트로 실측 — 모두 1064): MySQL 은 열린 실행 주석이 없으면 '*/' 를 '*' '/' 로 읽는다. 문장 끝의 것은 문장을 감싼 실행 주석의 닫힘처럼
// 떼고 받았고(13회차까지 — ALTER 는 c 를, 루틴은 p 를 더했다), 실행 주석 안에서 연 실행하는 주석과 함께 처음 '*/' 에서 닫힌 뒤의 '*/' 는 렉서가 바깥 주석의 닫힘으로 읽어 받았다
describe('짝 없는 */', () => {
  it.each([
    ['ALTER 끝', 'ALTER TABLE t ADD c INT */;', 1],
    ['루틴 끝', 'CREATE PROCEDURE p() SELECT 1 */;', 1],
    ['바꾼 구분자 앞의 */;', 'DELIMITER $$\nALTER TABLE t ADD c INT */;$$\nDELIMITER ;', 1],
    ['문장을 감싼 주석 뒤에 하나 더', '/*!40101 ALTER TABLE t ADD c INT */ */;', 1],
    ['안에서 연 실행하는 주석과 함께 닫힌 뒤', '/*!40101 ALTER TABLE t ADD a INT /*!40101 , ADD b INT */ */;', 1],
    ['함께 닫힌 뒤 문장 가운데', '/*!40101 ALTER TABLE t ADD a INT /*!40101 , ADD b INT */ , ADD c INT */;', 1],
    ['*/ 만 있는 문장', 'ALTER TABLE t ADD a INT;\n*/;', 2],
    ['문장 없는 덩어리', '/*!40101 /*!40101 */ */;\nALTER TABLE t ADD c INT;', 1],
  ])('MySQL 처럼 1064 로 거부한다 — %s', (_name, script, index) => {
    const r = run(script);
    expect(r).toMatchObject({ ok: false, error: { index } });
    expect(!r.ok && r.error.reason).toContain("짝 없는 '*/'");
    expect(!r.ok && r.error.reason.endsWith('(MySQL 1064)')).toBe(true);
  });

  it('문장을 감싼 실행 주석의 닫힘·건너뛰는 주석의 닫힘·일반 주석의 끝은 받는다', () => {
    expect(columnsOf(run('DELIMITER $$\n/*!40101 ALTER TABLE t ADD c INT */;$$\nDELIMITER ;'))).toEqual(['id', 'c']);
    expect(columnsOf(run('/*!40101 ALTER TABLE t ADD a INT /*!99999 , ADD b INT */ */;'))).toEqual(['id', 'a']);
    expect(columnsOf(run('ALTER TABLE t ADD c INT /* x */;'))).toEqual(['id', 'c']);
  });
});

// 리뷰 14회차 F1 (8.0.46·8.4.11 에서 mysql 클라이언트로 실측): mysql 클라이언트는 '/*!' 를 연 줄에서 그 뒤에 연 일반 주석을 둘째 '*/' 까지 주석으로 보고, 8.0 기본(--skip-comments)은
// 그 글을 지우고 보낸다 (8.4 기본은 그대로 보낸다). 서버와 렉서는 첫 '*/' 에서 닫아 같은 스크립트가 클라이언트에 따라 다른 DDL 을 실행한다 — 문장 안의 첫째는 8.0 이 a·b·d·e,
// 8.4 가 a·b·c·d·e 이고, 둘째는 8.0 이 a·c, 8.4 가 1064 이며, 마지막 문장 뒤의 첫째는 8.0 만 c 를 더한다 (13회차 전부터 받았다). 실행하는 실행 주석 안의 일반 주석은 문장·
// 문장 없는 덩어리·마지막 문장 뒤 모두 RE_EXPORT 로 거부한다 — 다음 줄의 것은 두 클라이언트가 같지만 함께 거부한다 (보수적)
describe('실행하는 실행 주석 안의 일반 주석', () => {
  it.each([
    ['같은 줄 두 실행 주석 (Claude 재현 B)', 'ALTER TABLE t ADD a INT /*!40101 , ADD b INT /* x */ , ADD c INT */ , ADD d INT /*!40101 , ADD e INT */;', '/*!40101'],
    ['남는 */ (Claude 재현 C)', 'ALTER TABLE t ADD a INT /*!40101 /* x */ , ADD b INT */ , ADD c INT */;', '/*!40101'],
    ['번호 없는 /*!', 'ALTER TABLE t ADD a INT /*! , ADD b INT /* x */ */;', '/*!'],
    ['다음 줄의 주석 (두 클라이언트 모두 a·b·c·d — 보수적)', 'ALTER TABLE t ADD a INT /*!40101 , ADD b INT\n/* x */ , ADD c INT */ , ADD d INT;', '/*!40101'],
  ])('문장 안의 것은 RE_EXPORT 로 거부한다 — %s', (_name, script, mark) => {
    expectReExport(run(script), 1, `실행 주석 ${mark} 안의 주석`);
  });

  it('문장 없는 덩어리의 것은 표지의 줄을 밝혀 거부한다 (8.0 클라이언트는 1064, 8.4 클라이언트는 뒤 ALTER 를 실행한다)', () => {
    expectReExport(run('ALTER TABLE t ADD a INT;\n/*!40101 /* x */ */;\nALTER TABLE t ADD c INT;'), 2, '앞 문장 뒤(줄 2)의 실행 주석 /*!40101 안의 주석');
  });

  it.each([
    ['Claude 재현 A', 'ALTER TABLE t ADD a INT;\n/*!40101 /* x */ -- y */ ALTER TABLE t ADD c INT */;\n', 2, '마지막 문장 뒤(줄 2)의 실행 주석 /*!40101'],
    ['번호 없는 /*!', 'ALTER TABLE t ADD a INT;\r\n/*! /* x */ -- y */ ALTER TABLE t ADD c INT */;\r\n', 2, '마지막 문장 뒤(줄 2)의 실행 주석 /*!'],
    ['문장이 없는 스크립트', '/*!40101 /* x */ -- y */ ALTER TABLE t ADD c INT */;\n', 1, '스크립트(줄 1)의 실행 주석 /*!40101'],
  ])('마지막 문장 뒤의 것도 거부하고 그 줄을 밝힌다 (렉서가 뒤 ALTER 를 삼킨다) — %s', (_name, script, line, part) => {
    const r = run(script);
    expect(r).toMatchObject({ ok: false, error: { index: 0, line } });
    expectReExport(r, 0, `${part} 안의 주석`);
  });

  it('실행 주석 밖·닫힌 뒤의 주석과 힌트(/*+ … */)는 받는다 (두 클라이언트가 같다)', () => {
    expect(columnsOf(run('ALTER TABLE t ADD a INT /*!40101 , ADD b INT */ /* x */ , ADD c INT /* y */;'))).toEqual(['id', 'a', 'b', 'c']);
    expect(columnsOf(run('ALTER TABLE t ADD a INT /*!40101 , ADD b INT /*+ x */ */;'))).toEqual(['id', 'a', 'b']);
  });
});
