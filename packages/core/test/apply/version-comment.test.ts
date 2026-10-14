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

  // 안의 주석: MySQL 은 한 겹을 주석으로 읽어 닫는 '*/' 가 뒤로 밀리는데, 그 '*/' 를 가린 줄 주석은 첫 '*/' 까지만 보면 놓친다 (8.4 클라이언트로 실행하면 c 를 더한다)
  it('어느 판이든 건너뛸 수 있는 번호 안의 주석은 RE_EXPORT 로 거부한다', () => {
    expectReExport(run('ALTER TABLE t ADD a INT;\n/*!99999 /* x */ -- y */ ALTER TABLE t ADD c INT;'), 0, '마지막 문장 뒤(줄 2)의 건너뛰는 실행 주석 /*!99999 안의 주석');
    expectReExport(run('ALTER TABLE t ADD a INT;\n/*!80400 /*!99999 */ -- y */ ALTER TABLE t ADD c INT;'), 0, '서버 버전에 따라 건너뛰는 실행 주석 /*!80400 안의 주석');
    expectReExport(run('ALTER TABLE t ADD a INT;\n/*!99999 /*/ */ -- y */ ALTER TABLE t ADD c INT;'), 0, '/*!99999 안의 주석'); // 첫 */ 와 겹친 /*/ 도 서버는 주석으로 연다
    expect(columnsOf(run('ALTER TABLE t ADD a INT;\n/*!40101 /* x */ -- y */ ALTER TABLE t ADD c INT;'))).toEqual(['id', 'a']);
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
    expect(trailing).toEqual({ marks: [{ at: text.lastIndexOf('/*!'), digits: '99999' }], spaces: [], closes: [text.lastIndexOf('*/')] });
    // 렉서가 실행 주석을 닫은 '*/' 와 문장 없이 끝난 덩어리의 구분자 (리뷰 13회차): 따옴표 안의 '*/' 는 닫지 않는다
    const quoted = "/*!99999 */;\n;\n/*!40101 ALTER TABLE t COMMENT '*/' */;";
    const [s] = splitForApply(quoted).statements;
    expect([s.closes, s.leading.closes, s.leading.ends]).toEqual([[quoted.lastIndexOf('*/')], [quoted.indexOf('*/')], [quoted.indexOf(';'), quoted.indexOf(';', quoted.indexOf(';') + 1)]]);
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
});
