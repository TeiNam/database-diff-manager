import { describe, expect, it } from 'vitest';
import { applyScript, printSqlDump } from '../../src/apply';
import { isCreateRoutine } from '../../src/apply/object-stmt';
import { DEFAULT_SQL_MODE, RE_EXPORT } from '../../src/apply/types';
import { canonicalJson } from '../../src/canonical';
import { diffSchemas } from '../../src/diff';
import { parseSqlDump } from '../../src/parse-dump';
import { parseRoutine } from '../../src/parse-routine';
import { printRoutine } from '../../src/print';
import { fixture } from '../helpers';

const SHOP = parseSqlDump(fixture('td-export-0152/shop.sql')).model; // 함수 tax, 프로시저 mark_paid, 뷰 paid_orders·big_paid
const apply = (script: string) => applyScript(SHOP, script, { schemaName: 'shop' });
const ok = (script: string) => {
  const r = apply(script);
  if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
  return r;
};

describe('루틴·뷰', () => {
  it('CREATE FUNCTION 은 RETURNS 를 정규화하고(문자열은 CHARSET) 그때 세션 SQL_MODE 를 붙인다', () => {
    const r = ok("SET SESSION sql_mode = 'STRICT_TRANS_TABLES';\nCREATE FUNCTION fn_double(x INT) RETURNS INT DETERMINISTIC RETURN x * 2;\nSET sql_mode = DEFAULT;\nDELIMITER ;;\nCREATE FUNCTION fn_label(p VARCHAR(10)) RETURNS VARCHAR(20) DETERMINISTIC\nBEGIN\n  RETURN CONCAT('[', p, ']');\nEND;;\nDELIMITER ;");
    const fn = (name: string) => r.model.routines.find((x) => x.name === name)!;
    expect(fn('fn_double')).toMatchObject({ kind: 'function', params: 'x INT', returns: 'int', sqlMode: 'STRICT_TRANS_TABLES', characteristics: { deterministic: true }, body: 'RETURN x * 2' });
    expect(fn('fn_label')).toMatchObject({ returns: 'varchar(20) CHARSET utf8mb4', sqlMode: DEFAULT_SQL_MODE });
  });

  it('같은 이름(대소문자 무시)은 1304, IF NOT EXISTS 는 그대로 둔다; DROP … IF EXISTS', () => {
    expect(apply('CREATE FUNCTION TAX(a INT) RETURNS INT DETERMINISTIC RETURN a;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1304') } });
    expect(ok('CREATE FUNCTION IF NOT EXISTS tax(a INT) RETURNS INT DETERMINISTIC RETURN a;').model.routines).toHaveLength(2);
    const r = ok('DROP FUNCTION tax; DROP PROCEDURE IF EXISTS nope; DROP VIEW IF EXISTS big_paid, nope;');
    expect(r.model.routines.map((x) => x.name)).toEqual(['mark_paid']);
    expect(r.model.views.map((v) => v.name)).toEqual(['paid_orders']);
    expect(apply('DROP PROCEDURE nope;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1305') } });
    expect(apply('DROP VIEW big_paid, nope;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1051') } });
  });
});

const routineOf = (script: string, name: string) => ok(script).model.routines.find((x) => x.name === name)!;

describe('CREATE FUNCTION·PROCEDURE', () => {
  // MySQL 8.0.46 실측: 쓴 순서·중복과 상관없이 SHOW CREATE 의 sql_mode 는 MySQL 순서로 한 번씩만 나온다
  it('루틴의 sqlMode 는 쓴 순서가 아니라 MySQL 순서로 붙는다', () => {
    const r = routineOf("SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION,strict_trans_tables,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,STRICT_TRANS_TABLES';\nCREATE FUNCTION f1() RETURNS INT DETERMINISTIC RETURN 1;", 'f1');
    expect(r.sqlMode).toBe('ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION');
  });

  it('SQL_MODE 를 @@sql_mode 로 저장·복원한 뒤 만든 루틴에도 그 값이 붙는다', () => {
    const script = "SET @OLD_MODE = @@SQL_MODE, SQL_MODE = 'NO_BACKSLASH_ESCAPES';\nCREATE PROCEDURE p1() SELECT 1;\nSET SQL_MODE = @OLD_MODE;\nCREATE PROCEDURE p2() SELECT 2;";
    expect(routineOf(script, 'p1').sqlMode).toBe('NO_BACKSLASH_ESCAPES');
    expect(routineOf(script, 'p2').sqlMode).toBe(DEFAULT_SQL_MODE);
  });

  it('프로시저: returns 가 없고, DEFINER 는 버리며, 특성을 읽는다', () => {
    const p = routineOf("CREATE DEFINER=`root`@`localhost` PROCEDURE p_log(IN p_id INT)\n  MODIFIES SQL DATA\n  SQL SECURITY INVOKER\n  COMMENT 'it''s'\nINSERT INTO audit(id) VALUES (p_id);", 'p_log');
    expect(p).toEqual({
      kind: 'procedure', name: 'p_log', params: 'IN p_id INT', body: 'INSERT INTO audit(id) VALUES (p_id)', sqlMode: DEFAULT_SQL_MODE,
      characteristics: { dataAccess: 'MODIFIES SQL DATA', security: 'INVOKER', comment: "it's" },
    });
  });

  it('함수와 프로시저는 이름 공간이 따로다 (같은 이름이 함께 있을 수 있고, 같은 종류끼리만 1304)', () => {
    expect(ok('CREATE PROCEDURE tax() SELECT 1;').model.routines.map((x) => `${x.kind}:${x.name}`)).toEqual(['function:tax', 'procedure:mark_paid', 'procedure:tax']);
    expect(apply('CREATE PROCEDURE Mark_Paid() SELECT 1;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1304') } });
  });

  it('td-export 의 루틴 블록(SQL_MODE 저장·DELIMITER·복원)을 그대로 붙여도 덤프를 읽은 모델과 같다', () => {
    const dump = fixture('td-export-0152/shop.sql');
    const block = dump.slice(dump.indexOf('/* Routines */'), dump.indexOf('/* Table :'));
    const byName = (xs: typeof SHOP.routines) => canonicalJson([...xs].sort((a, b) => a.name.localeCompare(b.name)));
    expect(byName(ok(`DROP FUNCTION tax; DROP PROCEDURE mark_paid;\n${block}`).model.routines)).toBe(byName(SHOP.routines));
  });

  it('루틴을 만들고 지워도 입력 모델은 그대로다', () => {
    const before = JSON.stringify(SHOP);
    const r = ok('CREATE FUNCTION f_m(a INT) RETURNS INT DETERMINISTIC RETURN a; CREATE PROCEDURE p_m() SELECT 1; DROP FUNCTION tax; DROP PROCEDURE mark_paid; DROP VIEW big_paid;');
    expect(r.model.routines.map((x) => x.name)).toEqual(['f_m', 'p_m']);
    expect(JSON.stringify(SHOP)).toBe(before);
    expect(SHOP.routines).toHaveLength(2);
  });

  // MySQL 8.0.46·8.4.11 실측 (mysql2 로 보낸 문장, information_schema.routines.routine_definition): DELIMITER 를 ';' 가 아닌 것으로 바꾸고 'RETURN x + 1; //' 처럼
  // 끝에 ';' 를 함께 쓰면 본문에 ';' 가 들어가지 않는다 ('RETURN x + 1'). 공백이 끼어도(' ;'), ';' 가 여럿이어도(';;') 같다.
  // 본문 안의 ';'(BEGIN … END)·문자열 속 ';' 와, 뒤에 주석이 따르는 ';' 는 그대로다
  it("문장 끝의 ';' 는 본문이 아니다 (구분자를 바꾼 스크립트의 '…; //' 꼴)", () => {
    const r = ok([
      'DELIMITER //',
      'CREATE FUNCTION fn_t(x INT) RETURNS INT DETERMINISTIC RETURN x + 1; //',
      'CREATE PROCEDURE sp_t() SELECT 1 ; //',
      'CREATE PROCEDURE sp_u()', 'BEGIN', '  SELECT 2;', 'END; //',
      'CREATE FUNCTION fn_v() RETURNS INT DETERMINISTIC RETURN 1;; //',
      "CREATE FUNCTION fn_w() RETURNS VARCHAR(5) DETERMINISTIC RETURN 'a;'; //",
      'DELIMITER ;',
    ].join('\n'));
    const body = (name: string) => r.model.routines.find((x) => x.name === name)!.body;
    expect(['fn_t', 'sp_t', 'sp_u', 'fn_v', 'fn_w'].map(body)).toEqual(['RETURN x + 1', 'SELECT 1', 'BEGIN\n  SELECT 2;\nEND', 'RETURN 1', "RETURN 'a;'"]);
  });

  it("끝의 ';' 를 뗀 루틴은 print·parse 왕복 경고가 없고 같은 모델이다", () => {
    const r = ok('DELIMITER //\nCREATE FUNCTION fn_t(x INT) RETURNS INT DETERMINISTIC RETURN x + 1; //\nCREATE PROCEDURE sp_u()\nBEGIN\n  SELECT 2;\nEND; //\nDELIMITER ;');
    const again = parseSqlDump(printSqlDump(r.model));
    expect(again.warnings).toEqual([]);
    expect(canonicalJson(again.model.routines)).toBe(canonicalJson(r.model.routines));
  });

  it("끝에 주석이 따르는 ';' 와 본문 끝의 줄 주석 속 ';' 는 건드리지 않는다", () => {
    const r = ok('DELIMITER //\nCREATE FUNCTION fn_c() RETURNS INT DETERMINISTIC RETURN 1 -- end;\n//\nCREATE FUNCTION fn_d() RETURNS INT DETERMINISTIC RETURN 2; /* x */ //\nDELIMITER ;');
    expect(r.model.routines.find((x) => x.name === 'fn_c')!.body).toBe('RETURN 1 -- end;');
    expect(r.model.routines.find((x) => x.name === 'fn_d')!.body).toBe('RETURN 2; /* x */');
  });

  it('IF NOT EXISTS 인데 없으면 만든다 (DEFINER 와 함께 써도 된다)', () => {
    const r = ok('CREATE DEFINER=`root`@`localhost` FUNCTION IF NOT EXISTS fn_new(a INT) RETURNS INT DETERMINISTIC RETURN a;\nCREATE PROCEDURE IF NOT EXISTS mark_paid() SELECT 1;');
    expect(r.model.routines.map((x) => x.name)).toEqual(['tax', 'mark_paid', 'fn_new']);
    expect(r.model.routines.find((x) => x.name === 'mark_paid')!.params).toBe('IN p_id int'); // 이미 있어서 그대로
  });

  it.each([
    ['DECIMAL(10,2)', 'decimal(10,2)'], ['INT UNSIGNED', 'int unsigned'], ['TEXT', 'text CHARSET utf8mb4'], ['CHAR(3)', 'char(3) CHARSET utf8mb4'], ['JSON', 'json'],
  ])('RETURNS %s → %s', (type, expected) => {
    expect(routineOf(`CREATE FUNCTION f_t() RETURNS ${type} DETERMINISTIC RETURN NULL;`, 'f_t').returns).toBe(expected);
  });

  it('RETURNS 의 CHARSET 은 스키마 기본 문자셋을 따르고, 직접 쓴 CHARSET·COLLATE 는 다시 뽑아 올리라고 안내한다', () => {
    const latin1 = applyScript(SHOP, "CREATE FUNCTION f_l() RETURNS VARCHAR(5) DETERMINISTIC RETURN 'a';", { schemaName: 'shop', defaults: { charset: 'latin1' } });
    expect(latin1.ok && latin1.model.routines.find((x) => x.name === 'f_l')!.returns).toBe('varchar(5) CHARSET latin1');
    // 스키마 기본 콜레이션이 문자셋의 기본이 아니면 COLLATE 도 붙는다 (MySQL 8.0.46·8.4.11 실측)
    const unicode = applyScript(SHOP, "CREATE FUNCTION f_u() RETURNS VARCHAR(5) DETERMINISTIC RETURN 'a';", { schemaName: 'shop', defaults: { charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' } });
    expect(unicode.ok && unicode.model.routines.find((x) => x.name === 'f_u')!.returns).toBe('varchar(5) CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci');
    const r = apply("CREATE FUNCTION f_c() RETURNS VARCHAR(5) CHARSET latin1 DETERMINISTIC RETURN 'a';");
    expect(r).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringMatching(/CHARSET·COLLATE/) } });
    expect(!r.ok && r.error.reason.endsWith(RE_EXPORT)).toBe(true);
  });

  it('본문이 없거나 괄호가 없는 CREATE 는 1064 로 거부한다 (입력 모델은 그대로)', () => {
    const before = JSON.stringify(SHOP);
    expect(apply('CREATE FUNCTION f_x() RETURNS INT DETERMINISTIC;')).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringMatching(/루틴 본문.*\(MySQL 1064\)$/) } });
    expect(apply('CREATE FUNCTION f_y RETURNS INT DETERMINISTIC RETURN 1;')).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringMatching(/\(MySQL 1064\)$/) } });
    expect(JSON.stringify(SHOP)).toBe(before);
  });

  it('스키마를 붙인 루틴 이름은 받지 않고 다시 뽑아 올리라고 안내한다 (백틱 안의 점은 이름의 일부다)', () => {
    for (const ddl of [
      'CREATE FUNCTION shop.f_q() RETURNS INT DETERMINISTIC RETURN 1;', 'CREATE PROCEDURE `shop` . `p_q`() SELECT 1;',
      'CREATE DEFINER=`root`@`localhost` FUNCTION IF NOT EXISTS shop.f_q() RETURNS INT DETERMINISTIC RETURN 1;',
    ]) {
      const r = apply(ddl);
      expect(r, ddl).toMatchObject({ ok: false, error: { index: 1 } });
      expect(!r.ok && r.error.reason.endsWith(RE_EXPORT), ddl).toBe(true);
    }
    expect(routineOf('CREATE FUNCTION `a.b`() RETURNS INT DETERMINISTIC RETURN 1;', 'a.b')).toMatchObject({ kind: 'function', params: '' });
  });

  // parseRoutine 은 SHOW CREATE 출력(항상 일반 이스케이프)을 읽도록 만들어져 COMMENT 를 모드와 상관없이 일반 규칙으로 다시 읽는다.
  // NBE 세션에서 직접 쓴 'C:\new' 의 값은 글자 그대로 C:\new 인데, 그대로 두면 줄바꿈이 든 값으로 저장된다
  it('NO_BACKSLASH_ESCAPES 세션: 백슬래시가 든 COMMENT 는 받지 않고, 그렇지 않은 루틴은 NBE 규칙으로 읽는다', () => {
    const nbe = "SET sql_mode = 'NO_BACKSLASH_ESCAPES';\n";
    const r = apply(`${nbe}CREATE FUNCTION f_b() RETURNS INT DETERMINISTIC COMMENT 'C:\\new' RETURN 1;`);
    expect(r).toMatchObject({ ok: false, error: { index: 2, reason: expect.stringContaining('NO_BACKSLASH_ESCAPES') } });
    expect(!r.ok && r.error.reason.endsWith(RE_EXPORT)).toBe(true);
    const plain = routineOf(`${nbe}CREATE FUNCTION f_b() RETURNS INT DETERMINISTIC COMMENT 'it''s' RETURN 1;`, 'f_b');
    expect(plain).toMatchObject({ characteristics: { comment: "it's" }, sqlMode: 'NO_BACKSLASH_ESCAPES' });
    const body = routineOf(`${nbe}CREATE FUNCTION f_c() RETURNS VARCHAR(9) DETERMINISTIC RETURN 'a\\';`, 'f_c'); // 본문의 'a\' 는 NBE 에서 문자열 하나
    expect(body.body).toBe("RETURN 'a\\'");
    const off = routineOf("CREATE FUNCTION f_d() RETURNS INT DETERMINISTIC COMMENT 'C:\\new' RETURN 1;", 'f_d'); // 일반 세션에서는 \n 이 줄바꿈이다
    expect(off.characteristics.comment).toBe('C:\new');
  });

  it('isCreateRoutine: FUNCTION·PROCEDURE 만 (DEFINER 가 있어도, 소문자여도) 루틴 생성문으로 본다', () => {
    for (const ddl of ['CREATE FUNCTION f() RETURNS INT RETURN 1', "create definer = 'a'@'b' procedure p() select 1", 'CREATE\n  PROCEDURE p() SELECT 1']) expect(isCreateRoutine(ddl), ddl).toBe(true);
    for (const ddl of ['CREATE TABLE function (a INT)', 'CREATE AGGREGATE FUNCTION f RETURNS INT SONAME "x.so"', 'CREATE FUNCTIONS_X', 'CREATE VIEW v AS SELECT 1', 'DROP FUNCTION f']) expect(isCreateRoutine(ddl), ddl).toBe(false);
  });
});

// SHOW CREATE 는 기본값과 같은 특성(NOT DETERMINISTIC·CONTAINS SQL·SQL SECURITY DEFINER·LANGUAGE SQL)과 빈 COMMENT 를 찍지 않는다 (printRoutine 이 따르는 규칙).
// 덤프에서 읽은 모델에는 그래서 들어 있지 않다. 손으로 쓴 스크립트(GUI 클라이언트가 내보내는 꼴)의 것을 그대로 저장하면 diff 와 print·parse 왕복이 어긋난다
describe('손으로 쓴 기본값 특성', () => {
  it.each([['LANGUAGE SQL'], ['NOT DETERMINISTIC'], ['CONTAINS SQL'], ['SQL SECURITY DEFINER'], ["COMMENT ''"]])('%s 는 저장하지 않는다 (함수·프로시저)', (clause) => {
    expect(routineOf(`CREATE PROCEDURE p_d() ${clause} SELECT 1;`, 'p_d').characteristics).toEqual({});
    expect(routineOf(`CREATE FUNCTION f_d() RETURNS INT ${clause} RETURN 1;`, 'f_d').characteristics).toEqual({});
  });

  it('다섯 가지를 함께 써도 저장하지 않는다', () => {
    const all = "LANGUAGE SQL NOT DETERMINISTIC CONTAINS SQL SQL SECURITY DEFINER COMMENT ''";
    expect(routineOf(`CREATE PROCEDURE p_d() ${all} SELECT 1;`, 'p_d').characteristics).toEqual({});
    expect(routineOf(`CREATE FUNCTION f_d() RETURNS INT COMMENT '' SQL SECURITY DEFINER CONTAINS SQL NOT DETERMINISTIC LANGUAGE SQL RETURN 1;`, 'f_d').characteristics).toEqual({});
  });

  it.each([
    ['DETERMINISTIC', { deterministic: true }], ['NO SQL', { dataAccess: 'NO SQL' }], ['READS SQL DATA', { dataAccess: 'READS SQL DATA' }],
    ['MODIFIES SQL DATA', { dataAccess: 'MODIFIES SQL DATA' }], ['SQL SECURITY INVOKER', { security: 'INVOKER' }], ["COMMENT 'x'", { comment: 'x' }],
  ])('기본값이 아닌 %s 는 SHOW CREATE 가 찍는 그대로 남긴다', (clause, expected) => {
    expect(routineOf(`CREATE PROCEDURE p_k() ${clause} SELECT 1;`, 'p_k').characteristics).toEqual(expected);
  });

  it('기본값과 아닌 것이 섞이면 기본값만 뺀다', () => {
    const r = routineOf("CREATE FUNCTION f_k(a INT) RETURNS INT LANGUAGE SQL NOT DETERMINISTIC READS SQL DATA SQL SECURITY INVOKER COMMENT 'c' RETURN a;", 'f_k');
    expect(r.characteristics).toEqual({ dataAccess: 'READS SQL DATA', security: 'INVOKER', comment: 'c' });
  });

  it('기본값을 덧붙여 쓴 CREATE 는 덧붙이지 않은 CREATE 와 같은 모델이고, print·parse 왕복이 그대로다', () => {
    const plain = routineOf('CREATE FUNCTION f_r(a INT) RETURNS INT DETERMINISTIC RETURN a;', 'f_r');
    const spelled = routineOf("CREATE FUNCTION f_r(a INT) RETURNS INT LANGUAGE SQL DETERMINISTIC CONTAINS SQL SQL SECURITY DEFINER COMMENT '' RETURN a;", 'f_r');
    expect(canonicalJson(spelled)).toBe(canonicalJson(plain));
    expect(canonicalJson({ ...parseRoutine(printRoutine(spelled)), sqlMode: spelled.sqlMode })).toBe(canonicalJson(spelled));
  });

  it('덤프에서 읽은 루틴을 기본값을 덧붙여 다시 만들어도 diff 에 변경으로 나오지 않는다 (빈 COMMENT 포함)', () => {
    const script = [
      'DROP PROCEDURE mark_paid;', 'DELIMITER $$',
      "CREATE PROCEDURE mark_paid(IN p_id int) LANGUAGE SQL NOT DETERMINISTIC MODIFIES SQL DATA SQL SECURITY DEFINER COMMENT ''",
      "BEGIN UPDATE orders SET status = 'paid' WHERE id = p_id; INSERT INTO order_audit(order_id) VALUES (p_id); END$$", 'DELIMITER ;',
    ].join('\n');
    expect(diffSchemas(SHOP, ok(script).model).routines).toEqual([]);
  });

  // 빈 COMMENT 는 저장하지 않으므로, COMMENT 가 있을 때만 거부하는 NBE 가드(위)에 걸리지 않는다
  it('NO_BACKSLASH_ESCAPES 세션의 빈 COMMENT 는 본문에 백슬래시가 있어도 받는다', () => {
    const r = routineOf("SET sql_mode = 'NO_BACKSLASH_ESCAPES';\nCREATE FUNCTION f_e() RETURNS VARCHAR(9) DETERMINISTIC COMMENT '' RETURN 'a\\';", 'f_e');
    expect(r.characteristics).toEqual({ deterministic: true });
  });
});

describe('DROP FUNCTION·PROCEDURE', () => {
  it('스키마를 붙인 이름은 이 스키마일 때만 받는다; 종류가 다르면 없는 것이다 (1305)', () => {
    expect(ok('DROP FUNCTION shop.tax;').model.routines.map((x) => x.name)).toEqual(['mark_paid']);
    expect(ok('DROP PROCEDURE `shop`.`MARK_PAID`;').model.routines.map((x) => x.name)).toEqual(['tax']);
    expect(apply('DROP FUNCTION other.tax;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('other') } });
    expect(apply('DROP FUNCTION mark_paid;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1305') } });
    expect(ok('DROP FUNCTION IF EXISTS mark_paid;').model.routines).toHaveLength(2);
  });

  it('이름 뒤에 다른 내용이 있으면 1064 로 거부한다', () => {
    expect(apply('DROP FUNCTION tax, mark_paid;')).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining('(MySQL 1064)') } });
    expect(apply('DROP PROCEDURE mark_paid CASCADE;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('(MySQL 1064)') } });
  });

  it('지운 루틴이 다시 만들어지면 새 정의가 된다 (DROP 후 CREATE)', () => {
    const r = routineOf('DROP FUNCTION tax; CREATE FUNCTION tax(b INT) RETURNS INT DETERMINISTIC RETURN b + 1;', 'tax');
    expect(r).toMatchObject({ params: 'b INT', returns: 'int', body: 'RETURN b + 1' });
  });
});

describe('DROP VIEW', () => {
  it('스키마를 붙인 이름과 RESTRICT·CASCADE 를 받고, 입력 모델은 그대로다', () => {
    const before = JSON.stringify(SHOP);
    expect(ok('DROP VIEW shop.big_paid RESTRICT;').model.views.map((v) => v.name)).toEqual(['paid_orders']);
    expect(ok('DROP VIEW paid_orders, `big_paid` CASCADE;').model.views).toEqual([]);
    expect(JSON.stringify(SHOP)).toBe(before);
  });

  it('하나라도 없으면(IF EXISTS 제외) 아무것도 지우지 않고 없는 이름을 모두 알려 준다', () => {
    const r = apply('DROP VIEW big_paid, nope, nada;');
    expect(r).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining('`nope`, `nada`') } });
    expect(!r.ok && r.error.reason).toContain('(MySQL 1051)');
    expect(apply('DROP VIEW other.big_paid;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('other') } });
  });
});
