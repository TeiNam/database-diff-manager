// 실행 문장 경계: 우리 판정·mysql 클라이언트(add_line 상태기계)·서버 판정이 늘 같아야 한다 (스펙 4.6, 12회차)
// 1) 주석 안의 '/*' (클라이언트는 블록 주석 안 '/*!' 에서 조건 주석 플래그를 켜고 첫 '*/' 는 그 플래그만 끈다)
// 2) NO_BACKSLASH_ESCAPES 세션의 '\'' 와 버전 주석을 무시하는 서버 (/*!99999 ' */ — 클라이언트는 문자열로, 서버는 주석으로 본다)
// 3) optimizer hint 안의 클라이언트 명령 ('\!', '\g', 줄 맨 앞 delimiter)
// 4) 루틴 본문 뒤에 붙은 바깥 문장 (END; DROP …)
// 5) 같은 객체의 삭제·재생성 중 한쪽만 수동 확인
import { describe, expect, it } from 'vitest';
import { commentLine } from '../src/comment-text';
import { generateDdl, renderDdl, type Statement } from '../src/ddl';
import { diffSchemas } from '../src/diff';
import { parseSqlDump, splitStatements } from '../src/parse-dump';
import { assertExpression } from '../src/sql-safety';
import { isSingleStatement, UNSAFE_IDENTIFIER_REASON } from '../src/statement-check';
import { PRECIOUS } from './injection-fixtures';

const view = (name: string, body: string) => `CREATE ALGORITHM=UNDEFINED DEFINER=\`root\`@\`localhost\` SQL SECURITY DEFINER VIEW \`${name}\` AS ${body};`;
const routine = (create: string, mode?: string) => [
  ...(mode === undefined ? [] : [`SET @OLD_ROUTINE_SQL_MODE = @@SQL_MODE, SQL_MODE = '${mode}';`]),
  'DELIMITER ;;', `${create};;`, 'DELIMITER ;', ...(mode === undefined ? [] : ['SET SQL_MODE = @OLD_ROUTINE_SQL_MODE;']),
].join('\n');
const proc = (body: string) => `CREATE DEFINER=\`root\`@\`localhost\` PROCEDURE \`p\`()\n${body}`;

function generated(target: string, base = PRECIOUS): Statement[] {
  return generateDdl(diffSchemas(parseSqlDump(base).model, parseSqlDump(`${base}\n${target}`).model));
}
const executable = (stmts: Statement[]) => stmts.filter((s) => !s.comment);
// 출력 전체를 mysql 클라이언트처럼 나눴을 때 precious 를 지우는 문장
const drops = (stmts: Statement[]) => splitStatements(renderDdl(stmts)).filter((p) => /^DROP\s+TABLE\s+`?precious/i.test(p.ddl));

describe('1. 주석 안의 /* (클라이언트 주석 상태 어긋남)', () => {
  it('블록 주석 안 /*! 가 있는 뷰는 수동 확인이고, 뒤 이름의 */ 로 DROP 이 새지 않는다', () => {
    const stmts = generated([view('v_a', 'select 1 /* /*! */ AS `a`'), view('v_b*/;DROP TABLE precious;-- ', 'select 1 AS `b`')].join('\n'));
    const a = stmts.find((s) => s.object === 'v_a')!;
    expect(a.comment).toBe(true);
    expect(drops(stmts)).toEqual([]);
  });

  it.each([
    ['블록 주석 안 /*', 'CREATE TABLE `t` (`id` int /* a /* b */)'],
    ['블록 주석 안 /*!', 'CREATE TABLE `t` (`id` int /* a /*! b */)'],
    ['hint 안 /*', 'CREATE VIEW `v` AS select /*+ /* */ 1 AS `a`'],
    ['버전 주석 안 블록 주석', 'CREATE TABLE `t` (`id` int /*!80000 /* x */ */)'],
    ['버전 주석 안 버전 주석', 'CREATE TABLE `t` (`id` int /*!80000 /*!80000 NULL */ */)'],
  ])('%s: 한 문장이 아니다', (_, sql) => {
    expect(isSingleStatement({ sql, comment: false })).toBe(false);
  });

  it('닫힌 블록 주석·버전 주석·hint 는 그대로 통과한다', () => {
    for (const sql of ['CREATE TABLE `t` (`id` int /* x */)', 'CREATE TABLE `t` (`id` int) /*!50100 PARTITION BY HASH (`id`) */', 'CREATE VIEW `v` AS select /*+ BKA(`t1`@`select#1`) */ 1 AS `a`']) {
      expect(isSingleStatement({ sql, comment: false }), sql).toBe(true);
    }
  });

  it('식·뷰 본문(allowComments)의 주석 안 /* 는 거부한다', () => {
    expect(() => assertExpression('select 1 /* /*! */ AS `a`', '뷰 본문', { allowComments: true })).toThrow();
    expect(() => assertExpression('select /*+ \\! id */ 1', '뷰 본문', { allowComments: true })).toThrow();
    expect(assertExpression('select 1 /* x */ AS `a`', '뷰 본문', { allowComments: true })).toBe('select 1 /* x */ AS `a`');
  });

  it('루틴 본문 주석 안의 /*! 는 수동 확인', () => {
    const stmts = generated(routine(proc('BEGIN\n  /* /*! */\n  SELECT 1;\nEND')));
    expect(stmts.map((s) => s.comment)).toEqual([true]);
  });

  it('주석 줄의 */ · /* 는 무력화한다 (클라이언트가 블록 주석 안이어도 주석이 닫히지 않는다)', () => {
    expect(commentLine('v*/;DROP TABLE precious;/*x')).toBe('-- v*\\/;DROP TABLE precious;/\\*x');
  });
});

describe('2. NO_BACKSLASH_ESCAPES 세션·버전 주석 무시 서버', () => {
  it.each([
    ['뷰 본문 문자열', view('v_n', "select 'x\\';DROP TABLE precious;#' AS `a`")],
    ['CHECK 식 문자열', "CREATE TABLE `t_n` (\n  `id` int NOT NULL,\n  CONSTRAINT `c1` CHECK ((`id` <> 'x\\';DROP TABLE precious;#'))\n) ENGINE=InnoDB;"],
    ['높은 버전 주석 안 따옴표', view('v_q', "select 1 /*!99999 ' */ AS `a`; DROP TABLE precious; -- ' */")],
  ])('%s: 수동 확인', (_, target) => {
    const stmts = generated(target);
    expect(executable(stmts)).toEqual([]);
  });

  it('높은 버전 주석으로 감춘 ; 는 한 문장이 아니다', () => {
    expect(isSingleStatement({ sql: "CREATE VIEW `v` AS select 1 /*!99999 ' */ AS a; DROP TABLE precious; -- ' */", comment: false })).toBe(false);
  });

  it('두 모드에서 같게 읽히는 백슬래시 문자열은 통과한다', () => {
    expect(isSingleStatement({ sql: "CREATE VIEW `v` AS select 'C:\\\\temp' AS `a`", comment: false })).toBe(true);
  });

  it('SQL_MODE 를 모르는 루틴은 두 모드로, 아는 루틴은 그 모드로 읽는다', () => {
    expect(generated(routine(proc("BEGIN\n  SELECT 'a\\';\n  SELECT 1;\nEND"), 'NO_BACKSLASH_ESCAPES')).map((s) => s.comment)).toEqual([false]);
    // 기본 모드로는 문자열 하나, NO_BACKSLASH_ESCAPES 로는 END 뒤 바깥 DROP
    const leaky = proc("BEGIN\n  SELECT 'a\\'; END; DROP TABLE precious; -- ';\nEND");
    expect(generated(routine(leaky)).map((s) => s.comment)).toEqual([true]);
    expect(generated(routine(leaky, 'STRICT_TRANS_TABLES')).map((s) => s.comment)).toEqual([false]);
    // 서버가 거부하는 모드 이름이면 SET 이 실패해 세션 모드로 실행될 수 있다
    expect(generated(routine(leaky, 'STRICT_TRANS_TABLES,BOGUS_MODE')).map((s) => s.comment)).toEqual([true]);
  });
});

describe('3. optimizer hint 안의 클라이언트 명령', () => {
  it.each([
    ['\\!', 'select /*+ \\! touch /tmp/x */ 1 AS `a`'],
    ['\\g', 'select /*+ \\g */ 1 AS `a`'],
    ['\\G', 'select /*+ \\G */ 1 AS `a`'],
    ['줄 맨 앞 delimiter', 'select /*+ \ndelimiter $$\n */ 1 AS `a`'],
  ])('%s: 수동 확인', (_, body) => {
    expect(executable(generated(view('v_h', body)))).toEqual([]);
  });

  it('블록 주석·줄 주석 안의 백슬래시는 클라이언트 명령이 아니다 (통과)', () => {
    expect(isSingleStatement({ sql: 'CREATE VIEW `v` AS select /* \\! x */ 1 AS `a`', comment: false })).toBe(true);
  });
});

describe('4. 루틴 본문 뒤 바깥 문장', () => {
  it.each([
    ['BEGIN…END 뒤', proc('BEGIN\n  SELECT 1;\nEND; DROP TABLE precious')],
    ['단일 문장 뒤', 'CREATE DEFINER=`root`@`localhost` FUNCTION `f`() RETURNS int\n    DETERMINISTIC\nRETURN 1; DROP TABLE precious'],
    ['식별자 begin 으로 깊이 속이기', proc('BEGIN\n  SELECT 1 AS begin;\nEND; DROP TABLE precious; SELECT 1 AS end')],
    ['DO begin 으로 깊이 속이기', proc('BEGIN\n  DO begin;\nEND; DROP TABLE precious;\nEND')],
    ['CASE 식 THEN begin', proc('BEGIN\n  SELECT CASE WHEN 1 THEN begin END;\nEND; DROP TABLE precious; END')],
    ['높은 버전 주석의 BEGIN', proc('BEGIN\n  /*!99999 BEGIN */ SELECT 1;\nEND; DROP TABLE precious;\nEND')],
    ['END 뒤 라벨 아닌 토큰', proc('BEGIN\n  SELECT 1;\nEND x y')],
  ])('%s: 수동 확인이고 DROP 이 실행 문장에 없다', (_, create) => {
    const stmts = generated(routine(create));
    expect(stmts.map((s) => s.comment)).toEqual([true]);
    expect(drops(stmts)).toEqual([]);
  });

  it.each([
    ['중첩 BEGIN·라벨', proc('lbl: BEGIN\n  DECLARE x int DEFAULT 0;\n  inner_blk: BEGIN\n    SET x = 1;\n  END inner_blk;\nEND lbl')],
    ['IF·CASE 문·CASE 식', proc("BEGIN\n  DECLARE x int;\n  IF 1 THEN BEGIN SET x = 1; END; ELSEIF 2 THEN SET x = 2; ELSE SET x = 3; END IF;\n  CASE x WHEN 1 THEN BEGIN END; ELSE SELECT CASE WHEN x THEN 'a' ELSE 'b' END; END CASE;\nEND")],
    ['LOOP·WHILE·REPEAT', proc('BEGIN\n  DECLARE i int DEFAULT 0;\n  l: LOOP SET i = i + 1; IF i > 3 THEN LEAVE l; END IF; END LOOP l;\n  WHILE i > 0 DO BEGIN SET i = i - 1; END; END WHILE;\n  REPEAT SET i = REPEAT(\'a\', 2) = \'aa\'; UNTIL i END REPEAT;\nEND')],
    ['핸들러 BEGIN', proc('BEGIN\n  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION, NOT FOUND BEGIN SELECT 1; END;\n  DECLARE EXIT HANDLER FOR SQLSTATE \'42000\' BEGIN END;\n  SELECT 2;\nEND')],
    ['빈 BEGIN END', proc('BEGIN\nEND')],
    ['단일 문장 함수', "CREATE DEFINER=`root`@`localhost` FUNCTION `f`(x int) RETURNS int\n    DETERMINISTIC\nRETURN CASE WHEN x > 0 THEN x ELSE 0 END + 1"],
  ])('%s: 실행 문장', (_, create) => {
    expect(generated(routine(create)).map((s) => s.comment)).toEqual([false]);
  });
});

describe('5. 같은 객체의 삭제·재생성 쌍', () => {
  const procOf = (body: string) => routine(proc(body), 'STRICT_TRANS_TABLES');

  it('루틴 CREATE 가 수동 확인이면 앞의 DROP … IF EXISTS 도 수동 확인', () => {
    const base = `${PRECIOUS}\n${procOf('BEGIN\n  SELECT 1;\nEND')}`;
    const stmts = generateDdl(diffSchemas(parseSqlDump(base).model, parseSqlDump(`${PRECIOUS}\n${procOf('BEGIN\n  SELECT 2;\nEND; DROP TABLE precious')}`).model));
    expect(stmts.map((s) => [s.kind, s.op, s.comment])).toEqual([['procedure', 'modify', true], ['procedure', 'modify', true]]);
  });

  it('테이블→뷰: 새 뷰가 수동 확인이면 DROP TABLE 도 수동 확인', () => {
    const base = `${PRECIOUS}\nCREATE TABLE \`x\` (\n  \`id\` int NOT NULL\n) ENGINE=InnoDB;`;
    const target = `${PRECIOUS}\n${view('x', 'select 1 /* /*! */ AS `a`')}`;
    const stmts = generateDdl(diffSchemas(parseSqlDump(base).model, parseSqlDump(target).model));
    expect(executable(stmts)).toEqual([]);
  });

  it('뷰→테이블: 새 테이블이 수동 확인(파싱 실패)이면 DROP VIEW 도 수동 확인', () => {
    const base = `${PRECIOUS}\n${view('x', 'select 1 AS `a`')}`;
    // 파서가 읽지 못하는 인덱스 속성 → 파싱 실패 테이블 (생성 문장이 수동 확인)
    const target = `${PRECIOUS}\nCREATE TABLE \`x\` (\n  \`id\` int NOT NULL,\n  KEY \`ix\` (\`id\`) /*!80021 SECONDARY_ENGINE_ATTRIBUTE '{}' */\n) ENGINE=InnoDB;`;
    const stmts = generateDdl(diffSchemas(parseSqlDump(base).model, parseSqlDump(target).model));
    expect(executable(stmts)).toEqual([]);
  });

  it('한쪽도 막히지 않으면 그대로 실행한다', () => {
    const base = `${PRECIOUS}\n${procOf('BEGIN\n  SELECT 1;\nEND')}`;
    const stmts = generateDdl(diffSchemas(parseSqlDump(base).model, parseSqlDump(`${PRECIOUS}\n${procOf('BEGIN\n  SELECT 2;\nEND')}`).model));
    expect(stmts.map((s) => s.comment)).toEqual([false, false]);
  });
});

// 보수적 이름 규칙 (심층 방어): 백틱으로 인용했어도 위험 글자가 든 이름은 실행 문장으로 내보내지 않는다
describe('6. 보수적 이름 규칙', () => {
  const tableOf = (name: string, cols = '`id` int NOT NULL', tail = '') =>
    `CREATE TABLE \`${name}\` (\n  ${cols}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci${tail};`;
  const reasonOf = (st: Statement) => st.comment && st.sql.includes(UNSAFE_IDENTIFIER_REASON);
  const BAD = ['a\x01b', 'a\nb', 'a;b', 'a\\b', 'a/*b', 'a*/b', 'a#b', 'a--b', 'a;;\\G', 'a\ndelimiter $$'];

  it.each(BAD)('테이블 이름 %j: 수동 확인 (이름 규칙 사유)', (name) => {
    const stmts = generated(tableOf(name));
    expect(stmts.map(reasonOf)).toEqual([true]);
    expect(drops(stmts)).toEqual([]);
  });

  it.each([
    ['컬럼', tableOf('t', '`id` int NOT NULL,\n  `c#x` int DEFAULT NULL')],
    ['인덱스', tableOf('t', '`id` int NOT NULL,\n  KEY `ix--1` (`id`)')],
    ['제약', tableOf('t', '`id` int NOT NULL,\n  CONSTRAINT `ck;1` CHECK ((`id` > 0))')],
    ['파티션', tableOf('t', '`id` int NOT NULL', '\n/*!50100 PARTITION BY RANGE (`id`)\n(PARTITION `p\\\\0` VALUES LESS THAN (10) ENGINE = InnoDB) */')],
    ['뷰', view('v/*x', 'select 1 AS `a`')],
    ['뷰 컬럼 별칭', view('v', 'select 1 AS `a*/b`')],
    ['루틴', routine("CREATE DEFINER=`root`@`localhost` PROCEDURE `p;;`()\nBEGIN\n  SELECT 1;\nEND", 'STRICT_TRANS_TABLES')],
  ])('%s 이름: 수동 확인 (이름 규칙 사유)', (_, target) => {
    const stmts = generated(target);
    expect(stmts.length).toBeGreaterThan(0);
    expect(stmts.every(reasonOf)).toBe(true);
  });

  it.each(['a-b', 'a/b', 'a b', 'a*b', 'delimiter_log', '한글 이름', "a'b", 'a"b', 'a``b'])('이름 %j: 실행 문장', (name) => {
    expect(generated(tableOf(name)).map((s) => s.comment)).toEqual([false]);
  });

  // 관찰된 어긋남: 이름이 ';;\\G' 인 루틴은 mysql 클라이언트가 우리 판정보다 많은 문장을 보냈다 → 이제 실행 문장이 아니다
  it("루틴 이름 ';;\\G': 루틴 문장은 모두 수동 확인이고 렌더 결과를 나눈 실행 문장은 0개", () => {
    const stmts = generated(routine("CREATE DEFINER=`root`@`localhost` PROCEDURE `x;;\\G`()\nBEGIN\n  SELECT 1;\nEND", 'STRICT_TRANS_TABLES'));
    expect(stmts.map(reasonOf)).toEqual([true]);
    expect(splitStatements(renderDdl(stmts))).toEqual([]);
  });

  it('재생성 루틴: CREATE 본문에만 위험 이름이 있어도 앞 DROP 까지 수동 확인 (삭제·재생성 쌍)', () => {
    const procOf = (body: string) => routine(`CREATE DEFINER=\`root\`@\`localhost\` PROCEDURE \`p\`()\n${body}`, 'STRICT_TRANS_TABLES');
    const base = `${PRECIOUS}\n${procOf('BEGIN\n  SELECT 1;\nEND')}`;
    const stmts = generateDdl(diffSchemas(parseSqlDump(base).model, parseSqlDump(`${PRECIOUS}\n${procOf('BEGIN\n  SELECT 1 AS `a#b`;\nEND')}`).model));
    expect(stmts.map((s) => s.comment)).toEqual([true, true]);
  });

  it('FK 의존: 위험 이름 컬럼을 고친 테이블을 참조하는 자식 FK 재추가도 실행 문장에 남지 않는다', () => {
    const parent = (col: string) => tableOf('pa', `\`id\` int NOT NULL,\n  \`${col}\` int DEFAULT NULL,\n  PRIMARY KEY (\`id\`)`);
    const child = tableOf('ch', '`id` int NOT NULL,\n  `pid` int DEFAULT NULL,\n  KEY `pid` (`pid`),\n  CONSTRAINT `fk` FOREIGN KEY (`pid`) REFERENCES `pa` (`id`)');
    const stmts = generated([parent('x#y'), child].join('\n'), [PRECIOUS, parent('x'), child].join('\n'));
    expect(executable(stmts).filter((s) => s.sql.includes('x#y'))).toEqual([]);
  });

  it("루틴 본문의 래핑 구분자 ';;' (문자열·주석 밖): 수동 확인, 문자열·주석 안이면 실행", () => {
    const single = (body: string) => isSingleStatement({ sql: routine(proc(body), 'STRICT_TRANS_TABLES'), comment: false, delimited: true });
    expect(single('BEGIN\n  SELECT 1;;\nEND')).toBe(false);
    expect(single("BEGIN\n  SELECT ';;';\nEND")).toBe(true);
    expect(single('BEGIN\n  /* ;; */ SELECT 1;\nEND')).toBe(true);
    expect(single('BEGIN\n  SELECT 1;\nEND')).toBe(true);
  });
});
