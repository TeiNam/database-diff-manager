import { describe, expect, it } from 'vitest';
import { generateDdl, renderDdl } from '../src/ddl';
import { diffSchemas } from '../src/diff';
import type { Routine, SchemaModel } from '../src/model';
import { normalizeDdl } from '../src/normalize';
import { parseSqlDump, splitDump, splitStatements } from '../src/parse-dump';
import { parseMdDump } from '../src/parse-md';
import { parseRoutine } from '../src/parse-routine';
import { printRoutine } from '../src/print';
import { fixture, sample } from './helpers';

const MODE = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TAX = "CREATE DEFINER=`root`@`localhost` FUNCTION `tax`(a decimal(10,2)) RETURNS decimal(10,2)\n    DETERMINISTIC\n    COMMENT '세금 10%'\nBEGIN RETURN a * 0.1; END";
const MARK_PAID = "CREATE DEFINER=`root`@`localhost` PROCEDURE `mark_paid`(IN p_id int)\n    MODIFIES SQL DATA\nBEGIN UPDATE orders SET status = 'paid' WHERE id = p_id; INSERT INTO order_audit(order_id) VALUES (p_id); END";

// td-export 0.1.52 형식의 루틴 구간 하나
const routineBlock = (ddl: string, mode = MODE) =>
  `SET @OLD_ROUTINE_SQL_MODE = @@SQL_MODE, SQL_MODE = '${mode}';\nDELIMITER ;;\n${ddl};;\nDELIMITER ;\nSET SQL_MODE = @OLD_ROUTINE_SQL_MODE;\n`;
const dump = (...routines: string[]) => parseSqlDump(`/* Database : s */\n${routines.join('')}CREATE TABLE \`t\` (\n  \`a\` int\n);\n`);
const model = (...routines: Routine[]): SchemaModel => ({ name: 's', tables: [], views: [], routines });
const fn = (over: Partial<Routine> = {}): Routine => ({ ...parseRoutine(TAX), sqlMode: MODE, ...over });

describe('splitStatements: DELIMITER', () => {
  it('DELIMITER ;; 구간은 ;; 로 끝을 찾고, 문자열 안 ;; 와 본문 안 ; 는 무시하고, DELIMITER ; 로 돌아온다', () => {
    const text = "SET @x = 1;\nDELIMITER ;;\nCREATE PROCEDURE `p`()\nBEGIN SELECT 'a;;b'; SELECT 2; END;;\nDELIMITER ;\nCREATE TABLE `t` (`a` int);\n";
    expect(splitStatements(text)).toEqual([
      { ddl: 'SET @x = 1', line: 1 },
      { ddl: "CREATE PROCEDURE `p`()\nBEGIN SELECT 'a;;b'; SELECT 2; END", line: 3 },
      { ddl: 'CREATE TABLE `t` (`a` int)', line: 6 },
    ]);
  });

  it('주석 안의 구분자와 다른 구분자($$)도 처리한다', () => {
    const text = 'DELIMITER $$\nCREATE PROCEDURE `p`() BEGIN /* $$ */ SELECT 1; END $$\ndelimiter ;\nSELECT 2;\n';
    expect(splitStatements(text).map((s) => s.ddl)).toEqual(['CREATE PROCEDURE `p`() BEGIN /* $$ */ SELECT 1; END', 'SELECT 2']);
  });

  // mysql 클라이언트(com_delimiter·get_arg)는 인자를 따옴표(' " `)로 감쌌으면 짝 따옴표 안을, 아니면 첫 공백(' ') 앞까지를 구분자로 읽고 줄의 나머지는 버린다
  // (8.4.11 실측: 'DELIMITER $$ -- 시작'·'# 시작' 은 $$, CRLF 의 \r 은 줄 끝). 줄 나머지를 통째로 구분자로 삼으면 그 글이 다시 나오지 않아 파일 끝까지가
  // 한 덩어리가 된다 (리뷰 1회차 I-2)
  it.each([
    ['뒤에 -- 주석', 'DELIMITER $$ -- 프로시저 시작', '$$'],
    ['뒤에 # 주석', 'DELIMITER $$ # 프로시저', '$$'],
    ['작은따옴표', "DELIMITER '$$'", '$$'],
    ['큰따옴표와 뒤 주석', 'DELIMITER "//" -- c', '//'],
    ['백틱', 'DELIMITER `@@`', '@@'],
    ['CRLF', 'DELIMITER $$\r', '$$'],
  ])('DELIMITER 인자는 mysql 클라이언트처럼 읽는다: %s', (_name, line, delimiter) => {
    const text = `${line}\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND${delimiter}\nDELIMITER ;\nALTER TABLE member ADD COLUMN nick VARCHAR(20);\nDROP TABLE orders;\n`;
    expect(splitStatements(text).map((s) => s.ddl)).toEqual(['CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND', 'ALTER TABLE member ADD COLUMN nick VARCHAR(20)', 'DROP TABLE orders']);
  });

  // 공백이 없으면 주석 표지도 구분자의 일부다 (8.4.11 실측: 'DELIMITER $$#x' 는 '$$#x', 탭은 인자를 끝내지 않아 'DELIMITER $$<탭>--' 는 '$$<탭>--').
  // 문장 나누기는 토큰으로 구분자를 찾으므로 주석 표지가 든 구분자는 찾지 못한다 — 다른 자리에서 끊지 않고 파일 끝까지 끝나지 않은 문장 하나로 남는다
  it.each([['$$#x'], ['$$\t--']])('주석 표지가 든 구분자 %j 는 찾지 못해 끝나지 않은 문장 하나로 남는다', (delimiter) => {
    const text = `DELIMITER ${delimiter}\nCREATE PROCEDURE p() BEGIN SELECT 1; END${delimiter}\nDELIMITER ;\nDROP TABLE orders;\n`;
    expect(splitDump(text).map((s) => s.terminated)).toEqual([false]);
  });
});

describe('parseRoutine', () => {
  it('함수: 파라미터·RETURNS·특성·본문을 나누고 DEFINER는 버린다', () => {
    expect(parseRoutine(TAX)).toEqual({
      kind: 'function', name: 'tax', params: 'a decimal(10,2)', returns: 'decimal(10,2)',
      characteristics: { deterministic: true, comment: '세금 10%' }, body: 'BEGIN RETURN a * 0.1; END',
    });
  });

  it('프로시저: 모든 특성(순서 무관)을 읽는다', () => {
    const r = parseRoutine("CREATE PROCEDURE p2(INOUT x int, IN y varchar(5) charset latin1) LANGUAGE SQL NOT DETERMINISTIC SQL SECURITY INVOKER READS SQL DATA COMMENT 'it''s' SELECT x");
    expect(r).toEqual({
      kind: 'procedure', name: 'p2', params: 'INOUT x int, IN y varchar(5) charset latin1',
      characteristics: { deterministic: false, dataAccess: 'READS SQL DATA', security: 'INVOKER', comment: "it's", language: 'SQL' }, body: 'SELECT x',
    });
  });

  it('RETURNS 의 문자셋·콜레이션까지 타입으로 본다', () => {
    const r = parseRoutine('CREATE FUNCTION `f`() RETURNS varchar(20) CHARSET utf8mb4 COLLATE utf8mb4_bin\n    NO SQL\nRETURN \'a\'');
    expect([r.returns, r.characteristics.dataAccess, r.body]).toEqual(['varchar(20) CHARSET utf8mb4 COLLATE utf8mb4_bin', 'NO SQL', "RETURN 'a'"]);
  });

  it('본문이 없으면 오류', () => {
    expect(() => parseRoutine('CREATE PROCEDURE `p`() COMMENT \'x\'')).toThrow('본문');
  });
});

describe('printRoutine', () => {
  it('SHOW CREATE 형식으로 다시 찍는다 (DEFINER 없이) — 왕복', () => {
    for (const ddl of [TAX, MARK_PAID]) expect(printRoutine(parseRoutine(ddl))).toBe(normalizeDdl(ddl));
  });

  it('특성 순서: 데이터 접근, DETERMINISTIC, SQL SECURITY INVOKER, COMMENT (기본값은 찍지 않는다)', () => {
    const r = parseRoutine("CREATE PROCEDURE `p`() COMMENT 'c' SQL SECURITY INVOKER DETERMINISTIC READS SQL DATA SELECT 1");
    expect(printRoutine(r)).toBe("CREATE PROCEDURE `p`()\n    READS SQL DATA\n    DETERMINISTIC\n    SQL SECURITY INVOKER\n    COMMENT 'c'\nSELECT 1");
    expect(printRoutine(parseRoutine('CREATE PROCEDURE `p`() SQL SECURITY DEFINER NOT DETERMINISTIC LANGUAGE SQL SELECT 1'))).toBe('CREATE PROCEDURE `p`()\nSELECT 1');
  });
});

describe('parseSqlDump: 루틴', () => {
  it('td-export 0.1.52 실제 샘플: 테이블 2·뷰 2·루틴 2, 경고 0', () => {
    const { model: m, warnings } = parseSqlDump(fixture('td-export-0152/shop.sql'));
    expect(warnings).toEqual([]);
    expect(m.name).toBe('shop');
    expect(m.tables.map((t) => t.name)).toEqual(['order_audit', 'orders']);
    expect(m.views.map((v) => v.name)).toEqual(['paid_orders', 'big_paid']);
    expect(m.routines.map((r) => [r.kind, r.name, r.sqlMode])).toEqual([['function', 'tax', MODE], ['procedure', 'mark_paid', MODE]]);
    expect(m.routines[0].characteristics).toEqual({ deterministic: true, comment: '세금 10%' });
    expect(m.routines[1]).toMatchObject({ params: 'IN p_id int', characteristics: { dataAccess: 'MODIFIES SQL DATA' } });
    expect(m.routines.every((r) => r.rawDdl === undefined)).toBe(true);
  });

  it('SQL_MODE 설정 없이 나온 루틴은 sqlMode 가 없다', () => {
    const { model: m } = parseSqlDump(`DELIMITER ;;\n${TAX};;\nDELIMITER ;\n`);
    expect(m.routines).toHaveLength(1);
    expect(m.routines[0].sqlMode).toBeUndefined();
  });

  it('파싱 실패는 parse-error(kind routine) 경고와 rawDdl 로 남긴다', () => {
    const { model: m, warnings } = dump(routineBlock('CREATE DEFINER=`root`@`%` FUNCTION `bad`(x int) RETURNS'));
    expect(warnings.map((w) => [w.code, w.kind, w.object])).toEqual([['parse-error', 'routine', 'bad']]);
    expect(m.routines[0]).toMatchObject({ kind: 'function', name: 'bad', sqlMode: MODE, rawDdl: 'CREATE FUNCTION `bad`(x int) RETURNS' });
    expect(m.routines[0].parseError).toBeTruthy();
    expect(m.tables.map((t) => t.name)).toEqual(['t']);
  });

  it('왕복 불일치는 round-trip(kind routine) 경고', () => {
    const { warnings } = dump(routineBlock('CREATE FUNCTION `f`() RETURNS int   DETERMINISTIC RETURN 1'));
    expect(warnings.map((w) => [w.code, w.kind, w.object])).toEqual([['round-trip', 'routine', 'f']]);
  });

  it('기존 덤프는 routines: [] , MD 는 routinesUnknown', () => {
    expect(parseSqlDump(sample('sql')).model.routines).toEqual([]);
    const md = parseMdDump(sample('md')).model;
    expect([md.routines, md.routinesUnknown]).toEqual([[], true]);
  });
});

describe('diffSchemas: 루틴', () => {
  it('(종류, 이름) 기준 add/drop, 이름은 대소문자 무시', () => {
    const proc = parseRoutine(MARK_PAID);
    const d = diffSchemas(model(fn(), proc), model(fn({ name: 'TAX' }), { ...proc, kind: 'function', returns: 'int' }));
    expect(d.routines.map((r) => [r.op, r.kind, r.name])).toEqual([['drop', 'procedure', 'mark_paid'], ['add', 'function', 'mark_paid']]);
    expect(d.routinesUnknown).toBe(false);
  });

  it('바뀐 필드 목록: params, returns, characteristics.*, body, sqlMode', () => {
    const to = fn({
      params: 'a decimal(12,2)', returns: 'decimal(12,2)', body: 'BEGIN RETURN a * 0.2; END', sqlMode: 'ANSI',
      characteristics: { deterministic: false, dataAccess: 'NO SQL', security: 'INVOKER', comment: '세금' },
    });
    const [r] = diffSchemas(model(fn()), model(to)).routines;
    expect([r.op, r.name, r.fields]).toEqual(['modify', 'tax', ['params', 'returns', 'characteristics.deterministic', 'characteristics.dataAccess',
      'characteristics.security', 'characteristics.comment', 'body', 'sqlMode']]);
  });

  it('기본값과 같은 명시 특성, 줄 끝 공백·줄바꿈 차이, 한쪽만 아는 sqlMode 는 차이가 아니다', () => {
    const to = fn({ body: 'BEGIN RETURN a * 0.1; END   \r\n', sqlMode: undefined, characteristics: { deterministic: true, comment: '세금 10%', dataAccess: 'CONTAINS SQL', security: 'DEFINER', language: 'SQL' } });
    expect(diffSchemas(model(fn()), model(to)).routines).toEqual([]);
    expect(diffSchemas(model(fn({ body: 'BEGIN\n  RETURN 1;\nEND' })), model(fn({ body: 'BEGIN  \r\n  RETURN 1;\r\nEND' }))).routines).toEqual([]);
    expect(diffSchemas(model(fn({ body: 'BEGIN RETURN 1; END' })), model(fn({ body: 'BEGIN  RETURN 1; END' }))).routines).toHaveLength(1);
  });

  it('실제 샘플: 같은 DB 의 MD(0.1.52, 루틴 없음)와 비교해도 루틴을 drop/add 로 보지 않는다', () => {
    const sql = parseSqlDump(fixture('td-export-0152/shop.sql')).model;
    const md = parseMdDump(fixture('td-export-0152/shop.md')).model;
    for (const [a, b] of [[sql, md], [md, sql]]) {
      const d = diffSchemas(a, b);
      expect([d.routines, d.routinesUnknown]).toEqual([[], true]);
      expect(generateDdl(d).filter((s) => s.kind === 'function' || s.kind === 'procedure')).toEqual([]);
    }
  });

  it('MD 버전이 끼면 루틴을 비교하지 않는다 (routinesUnknown)', () => {
    const md = { ...model(), routinesUnknown: true };
    for (const [a, b] of [[model(fn()), md], [md, model(fn())]]) {
      const d = diffSchemas(a, b);
      expect([d.routines, d.routinesUnknown]).toEqual([[], true]);
      expect(generateDdl(d)).toEqual([]);
    }
  });
});

describe('generateDdl: 루틴', () => {
  it('추가: DELIMITER 로 감싼 CREATE (DEFINER 없이) 와 SQL_MODE 설정·복원을 한 문장으로, renderDdl 은 ; 를 덧붙이지 않는다', () => {
    const [s] = generateDdl(diffSchemas(model(), model(fn())));
    expect(s).toMatchObject({ object: 'tax', kind: 'function', op: 'add', comment: false, delimited: true });
    expect(s.notes).toEqual(['DEFINER 없이 생성합니다 — 실행한 사용자가 DEFINER 가 됩니다']);
    expect(renderDdl([s])).toBe([
      '-- [+] FUNCTION tax',
      '-- DEFINER 없이 생성합니다 — 실행한 사용자가 DEFINER 가 됩니다',
      `SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = '${MODE}';`,
      'DELIMITER ;;',
      'CREATE FUNCTION `tax`(a decimal(10,2)) RETURNS decimal(10,2)',
      '    DETERMINISTIC',
      "    COMMENT '세금 10%'",
      'BEGIN RETURN a * 0.1; END;;',
      'DELIMITER ;',
      'SET SQL_MODE = @OLD_SQL_MODE;',
      '',
    ].join('\n'));
  });

  it('sqlMode 가 없으면 SET 없이 DELIMITER 만', () => {
    const [s] = generateDdl(diffSchemas(model(), model(fn({ sqlMode: undefined }))));
    expect(s.sql).toBe("DELIMITER ;;\nCREATE FUNCTION `tax`(a decimal(10,2)) RETURNS decimal(10,2)\n    DETERMINISTIC\n    COMMENT '세금 10%'\nBEGIN RETURN a * 0.1; END;;\nDELIMITER ;");
    expect(renderDdl([s]).endsWith('DELIMITER ;\n')).toBe(true);
  });

  it('변경: 앞쪽에서 DROP ... IF EXISTS, 테이블 변경 뒤·뷰 생성 앞에서 CREATE, 삭제는 DROP', () => {
    const base: SchemaModel = { ...model(fn(), parseRoutine(MARK_PAID)), tables: parseSqlDump('CREATE TABLE `t` (\n  `a` int\n);').model.tables };
    const target: SchemaModel = {
      ...model(fn({ body: 'BEGIN RETURN a * 0.2; END' })),
      tables: parseSqlDump('CREATE TABLE `t` (\n  `a` bigint\n);').model.tables,
      views: [{ kind: 'view', name: 'v', body: 'select `tax`(1) AS `x`', fidelity: 'full' }],
      evidence: { level: 'complete', objects: [] }, // 루틴 삭제(DROP)는 완전한 TARGET 에서만 실행한다 (15회차)
    };
    const stmts = generateDdl(diffSchemas(base, target));
    expect(stmts.map((s) => `${s.kind} ${s.object} ${s.sql.split('\n').find((l) => !l.startsWith('SET') && !l.startsWith('DELIMITER'))}`)).toEqual([
      'function tax DROP FUNCTION IF EXISTS `tax`',
      'procedure mark_paid DROP PROCEDURE IF EXISTS `mark_paid`',
      'table t ALTER TABLE `t`',
      'function tax CREATE FUNCTION `tax`(a decimal(10,2)) RETURNS decimal(10,2)',
      'view v CREATE OR REPLACE VIEW `v` AS select `tax`(1) AS `x`',
    ]);
  });

  it('파싱 실패 루틴의 생성은 수동 확인 주석', () => {
    const bad = parseSqlDump(routineBlock('CREATE FUNCTION `bad`(x int) RETURNS')).model.routines[0];
    const [s] = generateDdl(diffSchemas(model(), model(bad)));
    expect(s).toMatchObject({ kind: 'function', comment: true, sql: '-- [수동 확인 필요] bad: 파싱할 수 없는 루틴입니다. 원문을 확인하세요' });
  });
});

describe('리뷰 반영', () => {
  it('본문 문자열 안의 공백은 보존한다 (값 변경을 잃지 않는다), 문자열 밖 줄 끝 공백만 없앤다', () => {
    const a = dump(routineBlock("CREATE FUNCTION `f`() RETURNS varchar(9)\n    NO SQL\nBEGIN   \n  RETURN 'a \nb';\nEND"));
    const b = dump(routineBlock("CREATE FUNCTION `f`() RETURNS varchar(9)\n    NO SQL\nBEGIN\n  RETURN 'a\nb';\nEND"));
    expect([a.warnings, b.warnings]).toEqual([[], []]);
    expect(a.model.routines[0].body).toBe("BEGIN\n  RETURN 'a \nb';\nEND");
    expect(diffSchemas(a.model, b.model).routines.map((r) => r.fields)).toEqual([['body']]);
  });

  it('TARGET 루틴을 파싱할 수 없으면 DROP 도 실행하지 않는다 (수동 확인)', () => {
    const bad = parseSqlDump(routineBlock('CREATE FUNCTION `tax`(x int) RETURNS')).model;
    const stmts = generateDdl(diffSchemas(model(fn()), bad));
    expect(stmts.length).toBeGreaterThan(0);
    expect(stmts.every((s) => s.comment)).toBe(true);
    expect(stmts[0].sql).toContain('-- DROP FUNCTION IF EXISTS `tax`');
  });

  it('단어에 붙은 구분자(END$$)도 문장 끝으로 본다', () => {
    const text = 'DELIMITER $$\nCREATE PROCEDURE `p`()\nBEGIN SELECT 1; END$$\nDELIMITER ;\nCREATE TABLE `t` (\n  `a` int\n);\n';
    expect(splitStatements(text).map((s) => s.ddl)).toEqual(['CREATE PROCEDURE `p`()\nBEGIN SELECT 1; END', 'CREATE TABLE `t` (\n  `a` int\n)']);
    const { model: m, warnings } = parseSqlDump(text);
    expect([m.routines.length, m.tables.length, warnings]).toEqual([1, 1, []]);
  });

  it('NO_BACKSLASH_ESCAPES 루틴은 그 SQL_MODE 로 읽고, 복원 뒤에는 기본 규칙으로 읽는다', () => {
    const text = routineBlock("CREATE FUNCTION `f`() RETURNS varchar(5)\n    NO SQL\nRETURN 'a\\'", 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES')
      + "CREATE TABLE `t` (\n  `a` int COMMENT 'x\\\\y'\n);\n";
    const { model: m, warnings } = parseSqlDump(text);
    expect(warnings).toEqual([]);
    expect(m.routines[0].body).toBe("RETURN 'a\\'");
    expect(m.tables[0].columns[0].comment).toBe('x\\y');
    // 같은 본문끼리는 차이가 없다 (diff 도 그 SQL_MODE 로 본문을 읽는다)
    expect(diffSchemas(m, m).routines).toEqual([]);
  });

  it('NO_BACKSLASH_ESCAPES 루틴의 COMMENT: SHOW CREATE 형식(일반 escaping)으로 읽고, 생성 DDL 은 그 모드에 맞춰 \' 만 두 배로 쓴다 (8회차 6)', () => {
    // MySQL 8.4 실측: 그 모드로 COMMENT 'C:\new it''s' 를 만들면 저장값은 C:\new it's, SHOW CREATE 는 'C:\\new it''s' 로 낸다
    const ddl = "CREATE DEFINER=`root`@`%` FUNCTION `f`() RETURNS int\n    NO SQL\n    COMMENT 'C:\\\\new it''s'\nRETURN 1";
    const { model: m, warnings } = dump(routineBlock(ddl, 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES'));
    expect(warnings).toEqual([]);
    const [r] = m.routines;
    expect(r.characteristics.comment).toBe("C:\\new it's");
    expect(printRoutine(r)).toContain("COMMENT 'C:\\\\new it''s'");
    const [create] = generateDdl(diffSchemas(model(), model(r)));
    expect(create.sql).toContain("    COMMENT 'C:\\new it''s'\n");
    // 모드가 없으면 일반 escaping
    expect(generateDdl(diffSchemas(model(), model({ ...r, sqlMode: 'STRICT_TRANS_TABLES' })))[0].sql).toContain("COMMENT 'C:\\\\new it''s'");
  });
});
