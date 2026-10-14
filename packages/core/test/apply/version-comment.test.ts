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

describe('문장 나누기와 렉서 (덤프 파서와 함께 쓴다)', () => {
  it('splitForApply 는 splitDump 와 같은 문장에 원문 자리와 실행 주석 표지를 더한다', () => {
    const text = "-- 머리\n/*!40101 SET NAMES utf8 */;\n/*!99999 ALTER TABLE t ADD x INT */;\nALTER TABLE t ADD y INT /*!90000 , ADD z INT */;\n/*!99999 */;";
    const statements = splitForApply(text);
    expect(statements.map(({ ddl, line }) => ({ ddl, line }))).toEqual(splitStatements(text));
    expect(statements.map((s) => [text.slice(s.offset, s.offset + 3), s.marks.map((m) => [text.slice(m.at, m.at + 3), m.digits])])).toEqual([
      ['SET', [['/*!', '40101']]], ['ALT', [['/*!', '99999']]], ['ALT', [['/*!', '90000']]],
    ]);
  });

  it('렉서는 버전 번호와 상관없이 실행 주석의 내용을 토큰으로 읽는다 (덤프의 /*!80023 INVISIBLE */)', () => {
    expect(tokenize('KEY `k` (`c`) /*!99999 INVISIBLE */').map((t) => t.v)).toEqual(['KEY', 'k', '(', 'c', ')', 'INVISIBLE']);
    const dump = parseSqlDump(tdExport('CREATE TABLE `v` (\n  `id` int NOT NULL,\n  `c` int DEFAULT NULL /*!80023 INVISIBLE */,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;'));
    expect(dump.warnings).toEqual([]);
    expect(dump.model.tables[0].columns.map((c) => [c.name, c.invisible])).toEqual([['id', false], ['c', true]]);
  });
});
