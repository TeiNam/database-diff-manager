import { describe, expect, it } from 'vitest';
import { applyScript, MYSQL_DEFAULTS, resolveDefaults } from '../../src/apply';
import { ApplyFailure, DEFAULT_SQL_MODE, RE_EXPORT } from '../../src/apply/types';
import { parseSqlDump } from '../../src/parse-dump';
import { fixture, tdExport } from '../helpers';

const base = parseSqlDump(tdExport('CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\n')).model;
const run = (script: string) => applyScript(base, script, { schemaName: 'shop' });
const SHOP = parseSqlDump(fixture('td-export-0152/shop.sql')).model; // 함수 tax, 프로시저 mark_paid, 테이블 orders·order_audit
// 구분자를 ';;' 로 바꾼 뒤 되돌리지 않은 스크립트의 머리: 뒤에 쓴 ';' 는 문장을 끝내지 않아 다음 ';;' 나 파일 끝까지가 한 덩어리다
const NO_DELIMITER_RESET = 'DELIMITER ;;\nCREATE FUNCTION f1() RETURNS INT DETERMINISTIC RETURN 1;;\n';

describe('applyScript — 문장 처리', () => {
  it('SET·USE·주석만 있으면 적용할 문장이 없다', () => {
    expect(run('SET NAMES utf8mb4; SET FOREIGN_KEY_CHECKS = 0; USE shop; -- 주석\n')).toEqual({ ok: false, error: { index: 0, line: 1, statement: '', reason: '적용할 DDL 문장이 없습니다' } });
  });

  it('지원하지 않는 문장·다른 스키마 USE·VIEW 는 그 문장 번호·줄과 함께 실패한다', () => {
    expect(run('SET NAMES utf8mb4;\nCREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW SET @x = 1;')).toMatchObject({ ok: false, error: { index: 2, line: 2, statement: 'CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW SET @x = 1' } });
    expect(run('USE other;')).toMatchObject({ ok: false, error: { index: 1 } });
    expect(run('CREATE OR REPLACE VIEW v AS SELECT 1;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('VIEW') } });
  });

  it('지원하지 않는 문장의 거부 안내는 모두 RE_EXPORT 로 끝난다', () => {
    for (const sql of ['CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW SET @x = 1;', 'CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO SELECT 1;', 'ALTER DATABASE shop CHARACTER SET utf8mb4;', 'CALL p();',
      "PREPARE s FROM 'ALTER TABLE t ADD x INT';", 'EXECUTE s;', 'CREATE VIEW v AS SELECT 1;', 'CREATE SCHEMA shop;']) {
      const r = run(sql);
      expect(r, sql).toMatchObject({ ok: false, error: { index: 1 } });
      expect(!r.ok && r.error.reason.endsWith(RE_EXPORT), sql).toBe(true);
    }
  });

  it('닫히지 않은 따옴표는 문장으로 나누지 못한다', () => {
    expect(run("ALTER TABLE t COMMENT 'x;")).toMatchObject({ ok: false, error: { index: 0, reason: expect.stringContaining('나누지 못했습니다') } });
  });

  it('입력 모델을 바꾸지 않고, 맞지 않는 스키마 기본값은 거부한다', () => {
    const before = JSON.stringify(base);
    run('INSERT INTO t VALUES (1);');
    expect(JSON.stringify(base)).toBe(before);
    expect(applyScript(base, 'SET NAMES utf8mb4;', { schemaName: 'shop', defaults: { charset: 'latin1', collation: 'utf8mb4_bin' } })).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1253') } });
  });

  // 리뷰 9회차 (Claude 참고 3): 렉서는 따옴표 없는 숫자 시작 이름(2024_sales)을 숫자와 단어로 나눠 이름으로 읽지 못한다 (MySQL 은 숫자로만 되지 않은 이름이면 식별자로 읽는다).
  // 렉서는 그대로 두고 백틱으로 감싸라고 안내한다
  it.each([
    ['ALTER TABLE 2024_sales ADD COLUMN c INT;', '2024_sales'], ['ALTER TABLE t ADD COLUMN 4x INT;', '4x'], ['CREATE TABLE 2025_sales (id INT PRIMARY KEY);', '2025_sales'],
    ['CREATE TABLE s (id INT PRIMARY KEY, 1st INT);', '1st'], ['DROP TABLE 2024_sales;', '2024_sales'], ['ALTER TABLE t RENAME COLUMN id TO 1st;', '1st'], ['ALTER TABLE t ADD INDEX 1ix (id);', '1ix'],
  ])('따옴표 없는 숫자 시작 이름 %s 는 백틱으로 감싸라고 안내한다', (sql, name) => {
    expect(run(sql)).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining(`숫자로 시작하는 이름(${name})은 백틱(\`)으로 감싸 주세요`) } });
  });

  it('루틴 이름도 같이 안내하고, MySQL 은 받는 이름이라 MySQL 오류 번호(1064)를 붙이지 않는다', () => {
    const r = run('CREATE FUNCTION 1fn() RETURNS INT DETERMINISTIC RETURN 1;');
    expect(r).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining('숫자로 시작하는 이름(1fn)은 백틱(`)으로 감싸 주세요') } });
    expect(!r.ok && r.error.reason).not.toContain('MySQL 1064');
  });

  it('백틱으로 감싼 숫자 시작 이름은 받는다', () => {
    expect(run('ALTER TABLE t ADD COLUMN `4x` INT, ADD INDEX `1ix` (id);\nCREATE TABLE `2025_sales` (id INT PRIMARY KEY, `1st` INT);')).toMatchObject({ ok: true, applied: 2 });
  });

  // 지수 표기 기본값도 같다: 렉서가 1e3 을 숫자와 단어로 나눈다 — 지수 없는 숫자나 (실수·DECIMAL 컬럼이면) 따옴표로 감싼 값으로 쓰라고 안내한다
  it.each(['ALTER TABLE t ADD COLUMN d DOUBLE DEFAULT 1e3;', 'ALTER TABLE t ALTER COLUMN id SET DEFAULT 1e3;', 'CREATE TABLE s (id INT PRIMARY KEY, d DECIMAL(10,2) DEFAULT -1.5E3);'])(
    '지수 표기 기본값 %s 는 지수 없는 숫자나 따옴표로 감싼 값으로 쓰라고 안내한다',
    (sql) => expect(run(sql)).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining('기본값의 지수 표기 숫자(') } }),
  );

  it("안내대로 쓴 지수 없는 숫자(1000)와 따옴표 값('1e3')은 DOUBLE 컬럼에서 같은 기본값이 된다", () => {
    const r = run("ALTER TABLE t ADD COLUMN d DOUBLE DEFAULT 1000, ADD COLUMN e DOUBLE DEFAULT '1e3';");
    expect(r.ok && r.model.tables[0].columns.slice(1).map((col) => col.default)).toEqual(["'1000'", "'1000'"]);
  });
});

// 이미 MySQL 에서 돈 스크립트에 흔한, 스키마(SHOW CREATE 결과)를 바꾸지 않는 문장은 무시한다: 트랜잭션 제어, LOCK·UNLOCK TABLES, 데이터 문장, 권한, 서버 변수(SET GLOBAL·PERSIST),
// 조회(SELECT·SHOW·DESC·DESCRIBE·EXPLAIN·DO), DISABLE·ENABLE KEYS 만 쓴 ALTER TABLE (InnoDB 는 note 1031 만 남긴다), 현재 스키마의 CREATE SCHEMA·DATABASE IF NOT EXISTS
// (리뷰 3회차 M-5, 8.0.46·8.4.11 실측: note 1007 — 문자셋·콜레이션·ENCRYPTION 옵션도 무시하고 스키마 기본값은 그대로다), FLUSH PRIVILEGES·TABLES, 테이블 점검(ANALYZE·OPTIMIZE·
// CHECK·CHECKSUM TABLE — 결과 행만 낸다), DROP·RENAME USER (리뷰 4회차 M-3, 8.0.46·8.4.11 실측)
describe('applyScript — 스키마를 바꾸지 않는 문장', () => {
  const NO_OPS = [
    "SELECT 'done';", 'SELECT COUNT(*) FROM t WHERE id > 0;', 'SHOW TABLES;', 'SHOW CREATE TABLE t;', 'DESC t;', 'DESCRIBE `t`;', 'EXPLAIN SELECT * FROM t;', 'DO 1 + 1;',
    'ALTER TABLE t DISABLE KEYS;', 'ALTER TABLE `t` ENABLE KEYS;', 'ALTER TABLE shop.t DISABLE KEYS;', '/*!40000 ALTER TABLE `t` DISABLE KEYS */;',
    'CREATE SCHEMA IF NOT EXISTS shop;', 'CREATE DATABASE IF NOT EXISTS `shop`;',
    'CREATE SCHEMA IF NOT EXISTS `shop` DEFAULT CHARACTER SET utf8 ;', 'CREATE DATABASE IF NOT EXISTS shop CHARACTER SET = latin1 COLLATE = latin1_swedish_ci;',
    "CREATE DATABASE IF NOT EXISTS shop DEFAULT CHARSET 'utf8mb4' DEFAULT COLLATE utf8mb4_bin;",
    "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `shop` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci */ /*!80016 DEFAULT ENCRYPTION='N' */;",
    'FLUSH PRIVILEGES;', 'FLUSH TABLES;', 'ANALYZE TABLE t;', 'ANALYZE NO_WRITE_TO_BINLOG TABLE t;', 'ANALYZE LOCAL TABLES `t`;', 'OPTIMIZE TABLE shop.t;',
    'CHECK TABLE t;', 'CHECK TABLE t, `t` QUICK;', 'CHECK TABLE t FOR UPGRADE;', 'CHECK TABLE t QUICK FAST;', 'CHECKSUM TABLE t;', 'CHECKSUM TABLE t EXTENDED;',
    "DROP USER 'app'@'%';", "DROP USER IF EXISTS 'a'@'%', b@localhost;", "RENAME USER 'a'@'%' TO 'b'@'%';",
    'START TRANSACTION;', 'BEGIN;', 'BEGIN WORK;', 'COMMIT;', 'ROLLBACK;', 'ROLLBACK TO SAVEPOINT s1;', 'LOCK TABLES t WRITE;', 'LOCK TABLE t READ;', 'UNLOCK TABLES;',
    "INSERT INTO t VALUES (1), (2);", "INSERT INTO t (id) SELECT 3;", "UPDATE t SET id = 4 WHERE id = 1;", 'DELETE FROM t WHERE id = 2;', "REPLACE INTO t VALUES (5);",
    'TRUNCATE TABLE t;', 'TRUNCATE t;', "GRANT SELECT ON shop.* TO 'app'@'%';", "REVOKE SELECT ON shop.* FROM 'app'@'%';",
    'SET GLOBAL log_bin_trust_function_creators = 1;', 'SET PERSIST max_connections = 100;', "INSERT INTO t VALUES ('😀');",
  ];

  it.each(NO_OPS)('%s 는 무시하고 세지 않는다', (sql) => {
    const r = run(`${sql}\nALTER TABLE t ADD COLUMN x INT;`);
    expect(r).toMatchObject({ ok: true, applied: 1 });
    if (r.ok) expect(r.model.tables[0].columns.map((c) => c.name)).toEqual(['id', 'x']);
  });

  it('무시하는 문장만 있으면 적용할 문장이 없다', () => {
    expect(run(NO_OPS.join('\n'))).toMatchObject({ ok: false, error: { index: 0, reason: '적용할 DDL 문장이 없습니다' } });
  });

  it('SET GLOBAL foreign_key_checks = 0 은 이 세션의 FK 검사를 끄지 않는다', () => {
    expect(run('SET GLOBAL foreign_key_checks = 0;\nCREATE TABLE u (id INT, ref INT, FOREIGN KEY (ref) REFERENCES missing (id));')).toMatchObject({ ok: false, error: { index: 2, reason: expect.stringContaining('1824') } });
  });

  it('SET GLOBAL sql_mode 는 세션을 바꾸지 않지만 문장 나누기는 NO_BACKSLASH_ESCAPES 로 읽으므로, 백슬래시가 든 뒤 문장은 RE_EXPORT 로 거부한다', () => {
    const r = run("SET GLOBAL sql_mode = 'NO_BACKSLASH_ESCAPES';\nALTER TABLE t COMMENT 'C:\\path';");
    expect(r).toMatchObject({ ok: false, error: { index: 2 } });
    if (!r.ok) expect(r.error.reason.endsWith(RE_EXPORT)).toBe(true);
  });

  // 구분자를 바꾼 뒤(DELIMITER ;; 뒤 되돌리지 않음)나 클라이언트 명령 '\g' 로 문장 여럿이 한 덩어리가 되면, 첫 단어만 보고 무시하면 뒤 DDL 이 조용히 사라진다
  it.each([
    'INSERT INTO t VALUES (1); ALTER TABLE t ADD COLUMN x INT;', 'START TRANSACTION; ALTER TABLE t ADD COLUMN x INT;', "GRANT SELECT ON shop.* TO 'app'@'%'; ALTER TABLE t ADD COLUMN x INT;",
    'TRUNCATE TABLE t; ALTER TABLE t ADD COLUMN x INT;', 'SET GLOBAL max_connections = 10; ALTER TABLE t ADD COLUMN x INT;', 'SET NAMES utf8mb4; ALTER TABLE t ADD COLUMN x INT;',
    'SET FOREIGN_KEY_CHECKS = 0; ALTER TABLE t ADD COLUMN x INT;', 'USE shop; ALTER TABLE t ADD COLUMN x INT;', 'SELECT 1; ALTER TABLE t ADD COLUMN x INT;',
    'SHOW TABLES; DROP TABLE t;', 'DO 1; ALTER TABLE t ADD COLUMN x INT;', 'ALTER TABLE t DISABLE KEYS; ALTER TABLE t ADD COLUMN x INT;',
    'CREATE SCHEMA IF NOT EXISTS shop; ALTER TABLE t ADD COLUMN x INT;', 'DESC t; DROP TABLE t;',
    'CREATE SCHEMA IF NOT EXISTS shop DEFAULT CHARACTER SET utf8mb4; ALTER TABLE t ADD COLUMN x INT;', 'FLUSH PRIVILEGES; ALTER TABLE t ADD COLUMN x INT;',
    'ANALYZE TABLE t; DROP TABLE t;', "DROP USER 'a'@'%'; ALTER TABLE t ADD COLUMN x INT;",
  ])('구분자 안에 문장이 여럿이면 무시하지 않고 RE_EXPORT 로 거부한다: %s', (chunk) => {
    const r = run(`${NO_DELIMITER_RESET}${chunk}`);
    expect(r).toMatchObject({ ok: false, error: { index: 2 } });
    if (!r.ok) expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
  });

  it.each([
    'INSERT INTO t VALUES (1)\\g ALTER TABLE t ADD COLUMN x INT;', 'COMMIT\\g ALTER TABLE t ADD COLUMN x INT;', 'SET GLOBAL max_connections = 10\\g ALTER TABLE t ADD COLUMN x INT;',
    "INSERT INTO t VALUES (1)\\G", 'SET NAMES utf8mb4 \\g',
  ])('클라이언트 명령(\\g)이 든 문장도 거부한다: %s', (chunk) => {
    const r = run(`${chunk}\nALTER TABLE t ADD COLUMN y INT;`);
    expect(r).toMatchObject({ ok: false, error: { index: 1 } });
    if (!r.ok) expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
  });

  it('구분자를 바꾼 뒤에도 끝에 ; 만 붙은 무시하는 문장 하나는 그대로 무시한다', () => {
    const r = run('DELIMITER $$\nINSERT INTO t VALUES (1);$$\nCOMMIT;;$$\nDELIMITER ;\nALTER TABLE t ADD COLUMN x INT;');
    expect(r).toMatchObject({ ok: true, applied: 1 });
  });

  // 조회 문장의 사용자 변수 대입(:=·INTO)은 뒤 SET 이 읽는 저장 값과 어긋날 수 있다. DISABLE·ENABLE KEYS 를 다른 절과 함께 쓴 ALTER TABLE, 다른 스키마나 문자셋·콜레이션·
  // ENCRYPTION 밖의 옵션을 쓴 CREATE SCHEMA, 그 밖의 FLUSH, 히스토그램 절을 쓴 ANALYZE TABLE 은 받지 않는다 (MySQL 은 받는다 — 드물어 1차에서 받지 않는다).
  // 없는 테이블의 DISABLE KEYS 는 MySQL 처럼 1146 이다
  it.each([
    ['SELECT @x := 1;', ':='], ['SELECT COUNT(*) INTO @n FROM t;', 'INTO'], ['DO @x := 1;', ':='],
    ['ALTER TABLE t DISABLE KEYS, ADD x INT;', 'DISABLE'], ['ALTER TABLE t ADD x INT, ENABLE KEYS;', 'ENABLE'],
    ['CREATE DATABASE IF NOT EXISTS other;', 'other'], ['CREATE DATABASE IF NOT EXISTS other CHARACTER SET latin1;', 'other'],
    ['FLUSH TABLES WITH READ LOCK;', 'FLUSH'], ['FLUSH LOGS;', 'FLUSH'], ['ANALYZE TABLE t UPDATE HISTOGRAM ON id;', 'UPDATE'],
  ])('%s 는 무시하지 않고 RE_EXPORT 로 거부한다', (sql, mention) => {
    const r = run(`${sql}\nALTER TABLE t ADD COLUMN y INT;`);
    expect(r).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining(mention) } });
    if (!r.ok) expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
  });

  // 리뷰 6회차 Codex #2: 무시하는 데이터 문장도 사용자 변수에 대입할 수 있다(@v := …). 실행하지 않으니 대입한 값을 몰라, 뒤 SET 이 그 변수를 읽으면 옛 값을 쓴다 —
  // 조회 문장처럼 받지 않는다. INSERT·REPLACE 의 INTO 는 테이블을 가리켜 대입이 아니다 (NO_OPS 의 INSERT INTO … 는 그대로 무시한다)
  it.each([
    'INSERT INTO t(id) VALUES ((@m := 1));', 'INSERT INTO t (id) SELECT @n := 3;', 'UPDATE t SET id = (@m := id + 1);', 'DELETE FROM t WHERE (@m := id) > 0;',
    'REPLACE INTO t VALUES ((@m:=5));', '/*!40000 INSERT INTO t VALUES ((@m := 1)) */;',
  ])('사용자 변수에 대입하는 데이터 문장 %s 는 무시하지 않고 RE_EXPORT 로 거부한다', (sql) => {
    const r = run(`${sql}\nALTER TABLE t ADD COLUMN y INT;`);
    expect(r).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining(':=') } });
    if (!r.ok) expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
  });

  it('데이터 문장의 대입 뒤 SET SQL_MODE = @변수 가 옛 값을 읽어 루틴에 틀린 SQL_MODE 를 붙이지 않는다 (Codex #2 재현)', () => {
    const script = "SET @m='STRICT_TRANS_TABLES';\nINSERT INTO t(id,v) VALUES(1,(@m:='NO_ENGINE_SUBSTITUTION'));\nSET SQL_MODE=@m;\nCREATE PROCEDURE p() SELECT 1;";
    const r = run(script);
    expect(r).toMatchObject({ ok: false, error: { index: 2, line: 2 } });
    if (!r.ok) expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
  });

  // 리뷰 7회차 R7-2·8회차: 무시하는 문장이 저장 함수를 부르면 함수가 SET @m = … 으로 바꾼 사용자 변수를 알 수 없다 — 문장을 실행하지 않아 함수의 결과를 평가할 수 없다.
  // 문장은 받고(임시 도우미 함수로 데이터를 고치는 마이그레이션이 흔하다) 사용자 변수를 모두 잊는다. 뒤 SET 이 그 전에 저장한 변수를 읽으면 그 SET 을 RE_EXPORT 로 거부한다
  const FN = 'CREATE FUNCTION fn_one() RETURNS INT DETERMINISTIC NO SQL RETURN 1;';
  const MODE = "SET @m = 'NO_ENGINE_SUBSTITUTION';";
  const READ = 'SET SQL_MODE = @m;';
  const ALTER = 'ALTER TABLE t ADD COLUMN y INT;';
  const PROC = 'CREATE PROCEDURE p() SELECT 1;';
  const sqlModeOfP = (r: ReturnType<typeof run>) => (r.ok ? r.model.routines.find((x) => x.name === 'p')?.sqlMode : r.error.reason);
  // 함수가 바꿨을 수 있는 변수(variable)를 읽는 index 번째 문장을, 부른 함수 이름(call)을 알리며 RE_EXPORT 로 거부한다
  const expectForgotten = (r: ReturnType<typeof run>, index: number, call: string, variable = '@m'): void => {
    expect(r).toMatchObject({ ok: false, error: { index } });
    if (r.ok) return;
    expect(r.error.reason).toContain(`사용자 변수 ${variable} 의 값을 알 수 없습니다`);
    expect(r.error.reason).toContain(`저장 함수 호출(\`${call}\`)이 이 변수를 바꿨을 수 있`);
    expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
  };

  it.each([
    'SELECT fn_one();', 'select FN_ONE ();', 'SELECT `fn_one`();', 'SELECT shop.fn_one();', 'SELECT 1 + fn_one() AS x FROM t;', 'SELECT * FROM t WHERE id IN (1, fn_one());',
    'SELECT /* 주석 */ fn_one /* 주석 */ ();', 'DO fn_one();', 'EXPLAIN SELECT fn_one();', 'INSERT INTO t VALUES (fn_one());', 'INSERT INTO t VALUES (1), (fn_one());',
    'REPLACE INTO t (id) VALUES (fn_one());', 'UPDATE t SET id = fn_one();', 'DELETE FROM t WHERE id = fn_one();', '/*!40000 SELECT fn_one() */;',
    // 서버 변수의 SET(GLOBAL·PERSIST·PERSIST_ONLY, @@global.x)도 무시하는 문장이다 (3.1): 값을 버려도 그 안의 저장 함수는 실행된다
    'SET GLOBAL max_connections = fn_one();', 'SET PERSIST max_connections = fn_one() + 1;', 'SET PERSIST_ONLY max_connections = FN_ONE ();', 'SET @@global.max_connections = `fn_one`();',
    'SET @@persist.max_connections = shop.fn_one();', 'SET GLOBAL sql_mode = CONCAT(@@sql_mode, fn_one());', 'SET GLOBAL max_connections = 10, wait_timeout = fn_one();',
    'SET SESSION foreign_key_checks = 1, GLOBAL max_connections = fn_one();', '/*!40000 SET GLOBAL max_connections = fn_one() */;',
  ])('저장 함수를 부르는 무시 문장 %s 는 받고, 그 전에 저장한 사용자 변수를 뒤에서 읽는 SET 은 RE_EXPORT 로 거부한다', (sql) => {
    expect(run(`${FN}\n${sql}\n${ALTER}`)).toMatchObject({ ok: true, applied: 2 });
    const r = run(`${FN}\n${MODE}\n${sql}\n${READ}\n${ALTER}`);
    expectForgotten(r, 4, /shop\./.test(sql) ? 'shop.fn_one' : sql.match(/fn_one/i)![0]);
    expect(r).toMatchObject({ ok: false, error: { line: 4, statement: READ.slice(0, -1) } });
  });

  it('기준 버전에 있는 저장 함수(대소문자 무시)를 불러도 받고, 그 뒤 사용자 변수를 읽는 SET 은 거부한다', () => {
    const shop = (script: string) => applyScript(SHOP, script, { schemaName: 'shop' });
    for (const [sql, call] of [['SELECT tax(100);', 'tax'], ['SELECT TAX (1.5) AS x;', 'TAX'], ['INSERT INTO orders (amount) VALUES (Tax(5));', 'Tax'], ['DO `tax`(1);', 'tax'], ['SET GLOBAL max_connections = TAX(1);', 'TAX']]) {
      expect(shop(`${sql}\nALTER TABLE orders ADD COLUMN y INT;`), sql).toMatchObject({ ok: true, applied: 1 });
      expectForgotten(shop(`${MODE}\n${sql}\n${READ}\nALTER TABLE orders ADD COLUMN y INT;`), 3, call);
    }
  });

  // R7-2 재현: 저장 함수가 사용자 변수 @m 을 바꾸고, 호출 문장(call) 뒤의 SET SQL_MODE = @m 이 그 값을 읽는다. 함수 이름은 백틱으로 만든다 (숫자로 시작하는 이름 1set_m)
  const setMScript = (call: string, name = 'set_m'): string => [
    "SET @m = 'STRICT_TRANS_TABLES';", 'DELIMITER $$', `CREATE FUNCTION \`${name}\`() RETURNS INT DETERMINISTIC NO SQL`, 'BEGIN', " SET @m = 'NO_ENGINE_SUBSTITUTION';", ' RETURN 1;',
    'END$$', 'DELIMITER ;', call, 'SET SQL_MODE = @m;', PROC,
  ].join('\n');

  it.each(['SELECT set_m();', 'DO set_m();', 'INSERT INTO t VALUES (set_m());', 'SET GLOBAL max_connections = set_m();', 'SET PERSIST max_connections = set_m();'])(
    'R7-2 재현: %s 뒤의 SET SQL_MODE = @m 은 함수가 바꾼 @m 을 옛 값으로 읽지 않고 RE_EXPORT 로 거부한다',
    (call) => {
      const r = run(setMScript(call));
      expectForgotten(r, 4, 'set_m');
      expect(r).toMatchObject({ ok: false, error: { line: 10, statement: 'SET SQL_MODE = @m' } });
    },
  );

  // 리뷰 8회차 R8-2: MySQL 은 숫자로만 되지 않은 이름이면 숫자로 시작해도 식별자로 읽는다 (1set_m() 은 저장 함수 1set_m 을 부른다, 8.0.46·8.4.11 실측)
  it.each([['SELECT 1set_m();', '1set_m'], ['DO shop.1set_m();', 'shop.1set_m'], ['INSERT INTO t VALUES (1set_m());', '1set_m'], ['SET GLOBAL max_connections = 1set_m();', '1set_m'], ['SELECT `1set_m`();', '1set_m']])(
    '숫자로 시작하는 이름의 저장 함수 호출 %s 도 사용자 변수를 잊게 한다 (R8-2)',
    (call, name) => expectForgotten(run(setMScript(call, '1set_m')), 4, name),
  );

  // 리뷰 9회차 R9-2: 현재 스키마로 한정한 자리('.' 바로 뒤)는 숫자처럼 보이는 이름도 식별자다 — shop.0xface() 는 저장 함수 0xface 를 부른다 (8.0.46·8.4.11 실측).
  // 렉서는 0xface·0b101·123 을 16진수·비트·숫자 리터럴로 읽는다
  it.each([['SELECT shop.0xface();', '0xface'], ['DO shop.0b101();', '0b101'], ['INSERT INTO t VALUES (shop.123());', '123'], ['SELECT shop.`0xface`();', '0xface']])(
    '현재 스키마로 한정한 숫자처럼 보이는 이름의 저장 함수 호출 %s 도 사용자 변수를 잊게 한다 (R9-2)',
    (call, name) => expectForgotten(run(setMScript(call, name)), 4, `shop.${name}`),
  );

  // 리뷰 8회차 (Claude 참고 1): 임시 도우미 함수로 데이터를 고친 뒤 지우는 마이그레이션. 뒤에서 사용자 변수를 읽지 않으므로 받고, 최종 모델은 ALTER 만 적용한 것과 같다
  it('도우미 함수를 만들어 UPDATE 로 부른 뒤 지우는 마이그레이션을 받고, 최종 모델은 ALTER 만 적용한 모델과 같다', () => {
    const script = ['DELIMITER //', 'CREATE FUNCTION fn(x INT) RETURNS INT DETERMINISTIC BEGIN RETURN x + 1; END//', 'DELIMITER ;', 'UPDATE t SET id = fn(id);', 'DROP FUNCTION fn;', 'ALTER TABLE t ADD COLUMN c INT;'].join('\n');
    const r = run(script);
    const alterOnly = run('ALTER TABLE t ADD COLUMN c INT;');
    expect(r).toMatchObject({ ok: true, applied: 3 });
    if (!r.ok || !alterOnly.ok) return;
    expect(r.model).toEqual(alterOnly.model);
    expect(r.model.routines).toEqual([]);
    expect(r.model.tables[0].columns.map((col) => col.name)).toEqual(['id', 'c']);
  });

  // 리뷰 8회차 R8-1: MySQL 은 따옴표·스키마 없이 쓰고 바로 괄호를 붙인 내장 함수 이름을, 이름이 같은 저장 함수가 있어도 내장 함수로 읽는다 (8.0.46·8.4.11 실측).
  // 백틱(`now`())·스키마(shop.concat())·공백(NOW ())·주석(NOW/**/())을 쓴 꼴은 MySQL 이 저장 함수를 부를 수 있어 저장 함수 호출로 본다
  const COLLIDING = ['concat', 'now', 'ifnull', 'coalesce', 'json_object'].map((n) => `CREATE FUNCTION \`${n}\`() RETURNS INT DETERMINISTIC NO SQL RETURN 1;`).join('\n');
  const BUILTINS = "INSERT INTO t VALUES (CONCAT('a','b')), (NOW()), (IFNULL(NULL, 1)), (COALESCE(NULL, 2)), (JSON_OBJECT('a', 1));";

  it('이름이 같은 저장 함수가 있어도 내장 함수 호출은 사용자 변수를 그대로 둔다 — 같은 스크립트에서 만든 함수도, 기준 버전의 함수도 (R8-1)', () => {
    expect(sqlModeOfP(run(`${COLLIDING}\n${MODE}\n${BUILTINS}\n${READ}\n${PROC}`))).toBe('NO_ENGINE_SUBSTITUTION');
    const withFunctions = run(COLLIDING);
    if (!withFunctions.ok) throw new Error(withFunctions.error.reason);
    const again = applyScript(withFunctions.model, `${MODE}\n${BUILTINS}\nSET GLOBAL max_connections = COALESCE(100, 200);\n${READ}\n${PROC}`, { schemaName: 'shop' });
    expect(sqlModeOfP(again)).toBe('NO_ENGINE_SUBSTITUTION');
  });

  it.each([['SELECT `now`();', 'now'], ['SELECT shop.concat();', 'shop.concat'], ['SELECT NOW ();', 'NOW'], ['SELECT NOW/**/();', 'NOW'], ['SELECT `coalesce`();', 'coalesce']])(
    '이름이 같은 저장 함수가 있을 때 %s 는 저장 함수 호출로 본다 (R8-1 대조군)',
    (call, name) => expectForgotten(run(`${COLLIDING}\n${MODE}\n${call}\n${READ}\n${ALTER}`), 8, name),
  );

  // 리뷰 9회차 R9-1: 바로 '(' 가 붙어야 내장 함수인 이름(NOW·COUNT … 15개)이 아니면, 이름과 괄호 사이에 공백·주석을 끼워도 MySQL 은 내장 함수를 부른다 (8.0.46·8.4.11 실측)
  it('이름이 같은 저장 함수가 있어도 공백·주석을 끼운 CONCAT (…)·IFNULL/**/(…) 같은 내장 함수 호출은 사용자 변수를 그대로 둔다 (R9-1)', () => {
    const spaced = "INSERT INTO t VALUES (CONCAT ('a','b')), (IFNULL/**/(NULL, 1)), (COALESCE\n(NULL, 2)), (JSON_OBJECT ('a', 1));";
    expect(sqlModeOfP(run(`${COLLIDING}\n${MODE}\n${spaced}\n${READ}\n${PROC}`))).toBe('NO_ENGINE_SUBSTITUTION');
    // Codex 재현: @OLD_SQL_MODE 저장·복원 사이에서 이름이 같은 저장 함수가 있는 CONCAT ( 을 불러도 복원을 받는다
    const dump = ['CREATE FUNCTION `concat`() RETURNS INT DETERMINISTIC NO SQL RETURN 1;', "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';",
      "INSERT INTO t VALUES (CONCAT ('a','b'));", ALTER, 'SET SQL_MODE=@OLD_SQL_MODE;', PROC].join('\n');
    expect(sqlModeOfP(run(dump))).toBe(DEFAULT_SQL_MODE);
  });

  it("저장 함수를 부르지 않는 무시 문장(내장 함수·모델에 없는 이름·프로시저·INTO 뒤 테이블·문자열과 주석 속 글자)은 사용자 변수를 그대로 둔다", () => {
    for (const sql of [
      "INSERT INTO t VALUES (NOW(), CONCAT('a','b'));", "INSERT INTO t (id) VALUES (1), (2) ON DUPLICATE KEY UPDATE id = VALUES(id);", 'SELECT COUNT(*), MAX(id), IFNULL(NULL, 1) FROM t WHERE id IN (1, 2);',
      'SELECT fn_one FROM t;', 'SELECT unknown_fn(1);', "SELECT 'fn_one(1)' AS s;", 'SELECT 1 /* fn_one() */;', "INSERT INTO t VALUES ('x'); -- fn_one(1)", 'SELECT 1e5, 0x1F FROM t;',
      'INSERT INTO fn_one (id) VALUES (1);', 'INSERT INTO other.t (id) VALUES (1);', 'SET GLOBAL max_connections = GREATEST(10, 20);', 'SET PERSIST wait_timeout = unknown_fn(1);',
    ]) {
      const r = run(`${FN}\n${MODE}\n${sql}\n${READ}\n${PROC}`);
      expect(r, sql).toMatchObject({ ok: true, applied: 2 });
      expect(sqlModeOfP(r), sql).toBe('NO_ENGINE_SUBSTITUTION');
    }
    // 저장 함수가 아닌 프로시저는 이름이 테이블과 같아도 무시한다 (CREATE PROCEDURE t …; INSERT INTO t (id) …)
    expect(run('CREATE PROCEDURE t() SELECT 1;\nINSERT INTO t (id) VALUES (1);\nALTER TABLE t ADD COLUMN y INT;')).toMatchObject({ ok: true, applied: 2 });
    expect(applyScript(SHOP, "INSERT INTO orders (amount, status) VALUES (1, CONCAT('n', 'ew'));\nALTER TABLE orders ADD COLUMN y INT;", { schemaName: 'shop' })).toMatchObject({ ok: true, applied: 1 });
  });

  it('다른 스키마의 함수 호출(other.f())은 이 버전이 모르는 함수라 저장 함수 호출로 센다', () => {
    expectForgotten(run(`${MODE}\nSELECT other.f(1);\n${READ}\n${ALTER}`), 3, 'other.f');
  });

  it('저장 함수 호출 뒤 다시 정한 변수는 읽고, 그 전의 변수는 다른 변수에서 옮긴 값·mysqldump 의 @OLD_ 저장까지 모두 잊는다', () => {
    expect(sqlModeOfP(run(`${FN}\nSELECT fn_one();\n${MODE}\n${READ}\n${PROC}`))).toBe('NO_ENGINE_SUBSTITUTION');
    expectForgotten(run(`${FN}\n${MODE}\nSET @b = @m;\nSELECT fn_one();\nSET SQL_MODE = @b;\n${ALTER}`), 5, 'fn_one', '@b');
    expectForgotten(run(`${FN}\n${MODE}\nSELECT fn_one();\nSET @x = @m;\n${ALTER}`), 4, 'fn_one');
    expectForgotten(run(`${FN}\nSELECT fn_one();\nSET SQL_MODE = @never_saved;\n${ALTER}`), 3, 'fn_one', '@never_saved'); // 함수가 정했을 수도 있다
    const dump = ["SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';", FN, 'UPDATE t SET id = fn_one();', ALTER, 'SET SQL_MODE=@OLD_SQL_MODE;'].join('\n');
    expectForgotten(run(dump), 5, 'fn_one', '@old_sql_mode');
  });

  it('한 SET 문 안에서는 저장 함수 호출 뒤의 대입만 그 변수를 읽지 못한다 (MySQL 은 값을 차례로 계산한다)', () => {
    expectForgotten(run(`${FN}\n${MODE}\nSET GLOBAL max_connections = fn_one(), SESSION sql_mode = @m;\n${ALTER}`), 3, 'fn_one');
    expect(sqlModeOfP(run(`${FN}\n${MODE}\nSET SESSION sql_mode = @m, GLOBAL max_connections = fn_one();\n${PROC}`))).toBe('NO_ENGINE_SUBSTITUTION');
  });

  it('세션 sql_mode·FOREIGN_KEY_CHECKS 는 MySQL 이 함수에서 돌아올 때 되돌리므로 저장 함수 호출 뒤에도 그대로다 (8.0.46·8.4.11 실측)', () => {
    expect(sqlModeOfP(run(`SET SQL_MODE = 'NO_ENGINE_SUBSTITUTION';\n${FN}\nSELECT fn_one();\n${PROC}`))).toBe('NO_ENGINE_SUBSTITUTION');
    const fk = run(`SET FOREIGN_KEY_CHECKS = 0;\n${FN}\nSELECT fn_one();\nCREATE TABLE c (id INT PRIMARY KEY, p INT, FOREIGN KEY (p) REFERENCES missing (id));`);
    expect(fk).toMatchObject({ ok: true, applied: 2 });
  });

  // 함수 안의 SET GLOBAL sql_mode 는 전역 값을 바꾼다 (8.0.46·8.4.11 실측). DEFAULT 는 대입할 때 전역 값을 읽으므로 한 문장의 뒤 대입이 부르는 함수도 앞의 DEFAULT 에 걸린다
  it('저장 함수 호출 뒤(같은 SET 문의 뒤 대입 포함)의 SET sql_mode = DEFAULT 는 함수가 바꿨을 수 있는 전역 값을 읽어 RE_EXPORT 로 거부한다', () => {
    const scripts: [string, number][] = [[`${FN}\nSELECT fn_one();\nSET SESSION sql_mode = DEFAULT;\n${PROC}`, 3], [`${FN}\nSET SESSION sql_mode = DEFAULT, GLOBAL max_connections = fn_one();\n${PROC}`, 2]];
    for (const [script, index] of scripts) {
      const r = run(script);
      expect(r).toMatchObject({ ok: false, error: { index, reason: expect.stringContaining('저장 함수 호출(`fn_one`)이 전역 sql_mode 를 바꿨을 수 있') } });
      expect(!r.ok && r.error.reason.endsWith(RE_EXPORT)).toBe(true);
    }
    expect(sqlModeOfP(run(`${FN}\nSET SESSION sql_mode = DEFAULT;\nSELECT fn_one();\n${PROC}`))).toBe(DEFAULT_SQL_MODE); // 호출 전의 DEFAULT 는 처음 세션 SQL_MODE 다
  });

  // 함수 안의 SET time_zone 은 함수에서 돌아와도 남는다 (8.0.46·8.4.11 실측)
  it('UTC 로 정한 세션 time_zone 도 저장 함수 호출 뒤에는 UTC 로 보지 않고, 다시 UTC 로 정하면 TIMESTAMP 리터럴 기본값을 받는다', () => {
    const TS = "ALTER TABLE t ADD ts TIMESTAMP NULL DEFAULT '2020-01-01 09:00:00';";
    const r = run(`SET time_zone = '+00:00';\n${FN}\nSELECT fn_one();\n${TS}`);
    expect(r).toMatchObject({ ok: false, error: { index: 4, reason: expect.stringContaining('저장 함수 호출(`fn_one`)이 세션 시간대를 바꿨을 수 있어') } });
    expect(!r.ok && r.error.reason.endsWith(RE_EXPORT)).toBe(true);
    expect(run(`SET time_zone = '+00:00';\n${FN}\nSELECT fn_one();\nSET time_zone = '+00:00';\n${TS}`)).toMatchObject({ ok: true, applied: 2 });
    expect(run(`${FN}\nSELECT fn_one();\n${TS}`)).toMatchObject({ ok: false, error: { index: 3, reason: expect.stringContaining('서버의 시간대를 알 수 없어') } }); // UTC 로 정한 적이 없다
  });

  it('지운 저장 함수는 더 이상 저장 함수 호출이 아니다', () => {
    expect(sqlModeOfP(run(`${FN}\nDROP FUNCTION fn_one;\n${MODE}\nSELECT fn_one();\n${READ}\n${PROC}`))).toBe('NO_ENGINE_SUBSTITUTION');
  });

  it('없는 테이블의 DISABLE KEYS 는 1146, 다른 스키마의 테이블은 거부한다', () => {
    expect(run('ALTER TABLE nope DISABLE KEYS;')).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining('(MySQL 1146)') } });
    expect(run('ALTER TABLE other.t DISABLE KEYS;')).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining('other') } });
  });

  // MySQL 은 없는 테이블을 결과 행의 오류(Table '…' doesn't exist)로만 알린다 — 기준 버전과 스크립트가 맞지 않으니 DISABLE KEYS 처럼 거부한다
  it.each(['ANALYZE TABLE nope;', 'OPTIMIZE TABLE t, nope;', 'CHECK TABLE nope QUICK;', 'CHECKSUM TABLE nope;', 'ANALYZE TABLE T;'])('테이블 점검 문장의 없는 테이블은 1146 이다: %s', (sql) => {
    expect(run(sql)).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining('(MySQL 1146)') } });
  });

  it('테이블 점검 문장의 다른 스키마 테이블은 거부한다', () => {
    expect(run('ANALYZE TABLE other.t;')).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining('other') } });
  });

  // 있는 스키마여도 MySQL 은 옵션의 이름을 먼저 본다 (8.0.46·8.4.11 실측)
  it.each([
    ['CREATE DATABASE IF NOT EXISTS shop CHARACTER SET foo;', '1115'], ['CREATE DATABASE IF NOT EXISTS shop COLLATE foo_bin;', '1273'],
    ['CREATE DATABASE IF NOT EXISTS shop CHARACTER SET latin1 COLLATE utf8mb4_bin;', '1253'],
  ])('현재 스키마의 CREATE DATABASE IF NOT EXISTS 도 맞지 않는 문자셋·콜레이션은 MySQL 처럼 거부한다: %s', (sql, errno) => {
    expect(run(sql)).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining(`(MySQL ${errno})`) } });
  });

  // 계정 문장은 스키마를 바꾸지 않지만 비밀번호를 담을 수 있다 — 적용한 스크립트는 버전 이력에 원문 그대로 남으므로 무시하지 않고 지우라고 안내한다 (리뷰 4회차 M-3)
  it.each(["CREATE USER 'app'@'%' IDENTIFIED BY 'secret';", "ALTER USER 'app'@'%' IDENTIFIED BY 'secret';", "SET PASSWORD = 'secret';", "SET PASSWORD FOR 'app'@'%' = 'secret';"])(
    '%s 는 비밀번호가 든 계정 문장을 지우라고 안내한다', (sql) => {
      const r = run(`${sql}\nALTER TABLE t ADD COLUMN x INT;`);
      expect(r).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining('비밀번호') } });
      if (!r.ok) {
        expect(r.error.reason).toContain('지우');
        expect(r.error.reason).not.toContain('secret');
      }
    });

  it('스키마에 영향을 주는 세션 변수와 식으로 쓴 세션 SQL_MODE 는 여전히 거부한다', () => {
    expect(run('SET default_storage_engine = MyISAM;\nALTER TABLE t ADD x INT;')).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining(RE_EXPORT) } });
    expect(run("SET sql_mode = REPLACE(@@sql_mode, 'NO_ZERO_DATE', '');\nALTER TABLE t ADD x INT;")).toMatchObject({ ok: false, error: { index: 1 } });
  });
});

// 루틴이 아닌 DDL 덩어리도 문장 하나만 받는다 (리뷰 2회차 I-1·M-6). mysql 클라이언트는 덩어리의 문장을 모두 실행한다 — 8.0.46·8.4.11 실측: DELIMITER $$ 를 되돌리지 않은 파일 끝의
// 'CREATE TABLE IF NOT EXISTS member (…); ALTER TABLE member ADD COLUMN nick …; DROP TABLE orders;' 는 이미 있는 member 에 nick 을 더하고 orders 를 지우고, '… \g ALTER …' 도 둘 다 실행한다.
// 첫 문장만 읽고 돌아가면 뒤 DDL 이 조용히 사라지고, 덩어리 안의 ';' 를 처리기마다 모르는 토큰으로 거부하면 'MySQL 1064' 처럼 읽혀 고칠 곳을 알 수 없다
describe('applyScript — 구분자 덩어리 하나에 문장 하나', () => {
  const MULTI = /^한 문장 뒤에 다른 문장이 이어져 있습니다 .*DELIMITER/;
  const rejected = (r: ReturnType<typeof run>, index: number) => {
    expect(r).toMatchObject({ ok: false, error: { index, reason: expect.stringMatching(MULTI) } });
    if (!r.ok) expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
  };

  it.each([
    ['이미 있는 테이블의 CREATE TABLE IF NOT EXISTS', 'CREATE TABLE IF NOT EXISTS t (id INT); ALTER TABLE t ADD COLUMN x INT;'],
    ['없는 테이블의 DROP TABLE IF EXISTS', 'DROP TABLE IF EXISTS zz; ALTER TABLE t ADD COLUMN x INT;'],
    ['없는 뷰의 DROP VIEW IF EXISTS', 'DROP VIEW IF EXISTS v; ALTER TABLE t ADD COLUMN x INT;'],
    ['없는 프로시저의 DROP PROCEDURE IF EXISTS', 'DROP PROCEDURE IF EXISTS p; ALTER TABLE t ADD COLUMN x INT;'],
    ['없는 함수의 DROP FUNCTION IF EXISTS', 'DROP FUNCTION IF EXISTS nope; ALTER TABLE t ADD COLUMN x INT;'],
    ['ALTER TABLE 둘', 'ALTER TABLE t ADD COLUMN x INT; ALTER TABLE t ADD COLUMN y INT;'],
    ['테이블 옵션만 바꾸는 ALTER TABLE', "ALTER TABLE t COMMENT 'x'; DROP TABLE t;"],
    ['CREATE INDEX', 'CREATE INDEX ix ON t (id); DROP TABLE t;'],
    ['DROP INDEX', 'DROP INDEX `PRIMARY` ON t; DROP TABLE t;'],
    ['RENAME TABLE', 'RENAME TABLE t TO u; DROP TABLE u;'],
    ['CREATE TABLE', 'CREATE TABLE u (id INT); DROP TABLE t;'],
  ])('%s 뒤에 문장이 이어지면 DELIMITER 안내와 RE_EXPORT 로 거부한다', (_name, chunk) => {
    rejected(run(`${NO_DELIMITER_RESET}${chunk}`), 2);
  });

  it('바꾼 구분자 대신 ; 로 끝낸 문장이 다음 루틴과 한 덩어리가 되어도 같은 안내로 거부한다', () => {
    rejected(run('DELIMITER $$\nDROP PROCEDURE IF EXISTS p;\nCREATE PROCEDURE p() BEGIN SELECT 1; END $$\nDELIMITER ;'), 1);
  });

  it.each([
    'CREATE TABLE IF NOT EXISTS t (id INT) \\g ALTER TABLE t ADD COLUMN x INT;', 'ALTER TABLE t ADD COLUMN x INT \\g ALTER TABLE t ADD COLUMN y INT;',
    'DROP TABLE IF EXISTS zz \\G', 'CREATE TABLE u (id INT)\\g',
  ])('클라이언트 명령(\\g)이 든 DDL 덩어리도 거부한다: %s', (chunk) => {
    rejected(run(chunk), 1);
  });

  it('끝에 ; 만 붙은 덩어리는 그 ; 를 떼고 적용한다 (구분자를 되돌리지 않은 파일 끝의 문장도 mysql 클라이언트가 실행한다, ;; 도 같다)', () => {
    const r = run('DELIMITER $$\nCREATE PROCEDURE p0() BEGIN SELECT 1; END $$\nALTER TABLE t ADD COLUMN x INT;$$\nCREATE TABLE IF NOT EXISTS t (id INT);;$$\nUSE shop;$$\nCREATE INDEX ix ON t (x) ALGORITHM=INPLACE;$$\nALTER TABLE t ADD COLUMN y INT;\n');
    expect(r).toMatchObject({ ok: true, applied: 5 });
    if (r.ok) expect(r.model.tables[0].columns.map((c) => c.name)).toEqual(['id', 'x', 'y']);
    if (r.ok) expect(r.model.tables[0].indexes.map((i) => i.name)).toEqual(['PRIMARY', 'ix']);
  });

  it('지원하지 않는 문장은 본문의 ; 와 상관없이 지원 범위 안내로 거부한다', () => {
    const r = run('DELIMITER $$\nCREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.id = 1; END $$\nDELIMITER ;');
    expect(r).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining('지원하지 않는 문장입니다') } });
  });
});

// mysqldump 머리·꼬리의 '/*!40101 SET … */;' 꼴: 문장 나누기가 여는 표지(/*!40101)만 떼고 닫는 '*/' 를 문장 끝에 남긴다. 실행 주석 안의 문장은 MySQL 이 그대로 실행하므로
// 닫는 '*/' 를 떼고 읽는다 (SET 이면 무시/세션 값, 그 밖의 문장이면 그 문장)
describe('applyScript — 실행 주석(/*!NNNNN … */)으로 감싼 문장', () => {
  it('mysqldump 의 SET 머리·꼬리는 SET 처럼 읽고, FOREIGN_KEY_CHECKS 는 따라간다', () => {
    const script = [
      '/*!40101 SET @saved_cs_client     = @@character_set_client */;', '/*!50503 SET character_set_client = utf8mb4 */;',
      '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;',
      'CREATE TABLE u (id INT, ref INT, FOREIGN KEY (ref) REFERENCES missing (id));', // FOREIGN_KEY_CHECKS=0 이라 부모가 없어도 된다
      '/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;', '/*!40101 SET character_set_client = @saved_cs_client */;',
    ].join('\n');
    const r = run(script);
    expect(r).toMatchObject({ ok: true, applied: 1 });
    if (r.ok) expect(r.model.tables.map((t) => t.name)).toEqual(['t', 'u']);
    expect(run('/*!40014 SET FOREIGN_KEY_CHECKS=0 */;\n/*!40014 SET FOREIGN_KEY_CHECKS=1 */;\nCREATE TABLE v (id INT, ref INT, FOREIGN KEY (ref) REFERENCES missing (id));')).toMatchObject({ ok: false, error: { index: 3 } });
  });

  it('SET 이 아닌 문장도 실행 주석 안이면 그 문장으로 적용한다 (번호가 없는 /*! 도 같다)', () => {
    const r = run('/*!40000 ALTER TABLE t ADD COLUMN x INT */;\n/*! ALTER TABLE t ADD COLUMN y INT */;');
    expect(r).toMatchObject({ ok: true, applied: 2 });
    if (r.ok) expect(r.model.tables[0].columns.map((c) => c.name)).toEqual(['id', 'x', 'y']);
  });

  // 구분자를 바꾼 동안 '*/;' 로 끝낸 덩어리 (리뷰 3회차 M-2): mysql 클라이언트는 '/*!40101 ALTER … */;' 를 그대로 보내고 MySQL 은 ALTER 를 실행한다 (8.0.46·8.4.11 에서
  // mysql 클라이언트로 실측 — ';;' 도 같다). 끝의 ';' 를 먼저 떼어야 닫는 '*/' 를 찾는다
  it('구분자를 바꾼 동안 */; 로 끝낸 실행 주석 문장도 안의 문장으로 적용한다', () => {
    const r = run('DELIMITER $$\n/*!40101 ALTER TABLE t ADD COLUMN x INT */;$$\n/*!40101 ALTER TABLE t ADD COLUMN y INT */;;$$\n/*!40014 SET FOREIGN_KEY_CHECKS=0 */;$$\nDELIMITER ;');
    expect(r).toMatchObject({ ok: true, applied: 2 });
    if (r.ok) expect(r.model.tables[0].columns.map((c) => c.name)).toEqual(['id', 'x', 'y']);
  });

  it('문장 끝의 일반 주석 */ 는 건드리지 않는다', () => {
    expect(run('ALTER TABLE t ADD COLUMN x INT /* note */;')).toMatchObject({ ok: true, applied: 1 });
    expect(run('ALTER TABLE t ADD COLUMN x INT COMMENT \'a */\';')).toMatchObject({ ok: true, applied: 1 });
  });

  // MySQL 은 루틴 본문을 실행 주석 표지를 지운 글로 저장한다 (8.0.46·8.4.11 실측: '/*!80000 CREATE FUNCTION g() … RETURN 1 */' 의 본문은 'RETURN 1').
  // 루틴을 통째로 감싼 꼴은 닫는 '*/' 를 원문에서도 떼어 같게 읽는다 (리뷰 1회차 F2)
  it('루틴을 통째로 감싼 실행 주석은 닫는 */ 를 본문에 남기지 않는다', () => {
    const r = run('/*!80000 CREATE FUNCTION g() RETURNS INT DETERMINISTIC RETURN 1 */;\nDELIMITER //\n/*!50003 CREATE PROCEDURE p() BEGIN SELECT 1; END */ //\nDELIMITER ;');
    expect(r).toMatchObject({ ok: true, applied: 2 });
    if (r.ok) expect(r.model.routines.map((x) => [x.name, x.body])).toEqual([['g', 'RETURN 1'], ['p', 'BEGIN SELECT 1; END']]);
  });

  // 본문 안의 실행 주석은 MySQL 이 표지만 지운다 ('BEGIN /*!80000 SELECT 1; */ SELECT 2; END' → 'BEGIN  SELECT 1;  SELECT 2; END', 버전이 높으면 안의 글까지 —
  // 8.0.46·8.4.11 실측). 본문은 쓴 그대로 저장하므로 받지 않는다. 머리에서 열어 본문에서 닫는 꼴, 감싼 주석 뒤에 글이 더 있는 꼴도 같다
  it.each([
    ['본문 안', 'DELIMITER //\nCREATE PROCEDURE p() BEGIN /*!80000 SELECT 1; */ SELECT 2; END //\nDELIMITER ;'],
    ['번호 없는 /*! 도', 'DELIMITER //\nCREATE PROCEDURE p() BEGIN /*! SELECT 1; */ SELECT 2; END //\nDELIMITER ;'],
    ['머리에서 열고 본문에서 닫음', 'CREATE FUNCTION h() RETURNS INT DETERMINISTIC /*!80000 RETURN 1 */;'],
    ['감싼 주석 뒤에 글', '/*!80000 CREATE FUNCTION f() RETURNS INT DETERMINISTIC RETURN 1 */ + 1;'],
  ])('루틴 정의 안의 실행 주석은 RE_EXPORT 로 거부한다: %s', (_name, script) => {
    const r = run(script);
    expect(r).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringContaining('실행 주석') } });
    expect(!r.ok && r.error.reason.endsWith(RE_EXPORT)).toBe(true);
  });
});

// 4바이트 문자(이모지 등, U+10000 이상): MySQL 8.0.46·8.4.11 의 SHOW CREATE 는 COMMENT·ENUM·SET 값의 그 문자를 '?' 로, 문자열 DEFAULT 는 통째로 16진수(0xF09F9880)로 바꿔 찍는다.
// 그대로 저장하면 재추출한 덤프와 달라지므로 RE_EXPORT 로 거부한다. 루틴 본문은 쓴 그대로 찍히니 상관없고, 루틴 COMMENT 는 '?' 로 찍힌다
describe('applyScript — 4바이트 문자', () => {
  it.each([
    ["ALTER TABLE t ADD COLUMN c VARCHAR(10) DEFAULT '😀';"],
    ["ALTER TABLE t ADD COLUMN c VARCHAR(10) DEFAULT '한글😀';"],
    ["ALTER TABLE t ADD COLUMN c INT COMMENT '😀 상태';"],
    ["ALTER TABLE t COMMENT = '😀';"],
    ["ALTER TABLE t ADD COLUMN c ENUM('a','😀');"],
    ["ALTER TABLE t ADD INDEX ix (id) COMMENT '😀';"],
    ["CREATE TABLE u (id INT) COMMENT='😀';"],
    ["CREATE TABLE u (id INT COMMENT '😀');"],
    ["CREATE FUNCTION f() RETURNS INT DETERMINISTIC COMMENT '😀' RETURN 1;"],
  ])('%s 는 RE_EXPORT 로 끝나는 안내로 거부', (script) => {
    const r = run(script);
    expect(r).toMatchObject({ ok: false, error: { index: 1 } });
    if (!r.ok) {
      expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
      expect(r.error.reason).toContain('4바이트');
    }
  });

  it('BMP 문자(한글·유럽 문자·€·U+FFFF)와 루틴 본문 속 이모지는 받는다', () => {
    expect(run("ALTER TABLE t ADD COLUMN c VARCHAR(10) DEFAULT 'é한€\uffff' COMMENT 'ǆ 설명';")).toMatchObject({ ok: true, applied: 1 });
    const r = run("CREATE FUNCTION g() RETURNS VARCHAR(5) DETERMINISTIC RETURN '😀';");
    expect(r).toMatchObject({ ok: true, applied: 1 });
    if (r.ok) expect(r.model.routines[0].body).toBe("RETURN '😀'");
  });
});

const NO_STATEMENT = { ok: false, error: { index: 0, line: 1, statement: '', reason: '적용할 DDL 문장이 없습니다' } };

describe('resolveDefaults — 스키마 기본 문자셋·콜레이션', () => {
  it('안 준 값(undefined 포함)은 MySQL 기본값이다', () => {
    expect(resolveDefaults(undefined)).toEqual(MYSQL_DEFAULTS);
    expect(resolveDefaults({})).toEqual(MYSQL_DEFAULTS);
    expect(resolveDefaults({ charset: undefined })).toEqual(MYSQL_DEFAULTS);
    expect(resolveDefaults({ charset: undefined, collation: undefined })).toEqual(MYSQL_DEFAULTS);
  });

  it('문자셋만 주면 그 문자셋의 기본 콜레이션, 콜레이션만 주면 그 콜레이션의 문자셋을 쓴다', () => {
    expect(resolveDefaults({ charset: 'latin1' })).toEqual({ charset: 'latin1', collation: 'latin1_swedish_ci' });
    expect(resolveDefaults({ charset: 'UTF8' })).toEqual({ charset: 'utf8mb3', collation: 'utf8mb3_general_ci' });
    expect(resolveDefaults({ charset: 'utf8mb4', collation: undefined })).toEqual({ charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' });
    expect(resolveDefaults({ collation: 'latin1_bin' })).toEqual({ charset: 'latin1', collation: 'latin1_bin' });
    expect(resolveDefaults({ charset: undefined, collation: 'utf8_general_ci' })).toEqual({ charset: 'utf8mb3', collation: 'utf8mb3_general_ci' });
  });

  it('둘 다 주면 이름을 MySQL 표기로 맞추고 서로 맞는지 본다', () => {
    expect(resolveDefaults({ charset: 'LATIN1', collation: 'Latin1_Bin' })).toEqual({ charset: 'latin1', collation: 'latin1_bin' });
    expect(() => resolveDefaults({ charset: 'latin1', collation: 'utf8mb4_bin' })).toThrow(/\(MySQL 1253\)/);
    expect(() => resolveDefaults({ charset: 'nope' })).toThrow(/\(MySQL 1115\)/);
    expect(() => resolveDefaults({ collation: 'nope_ci' })).toThrow(/\(MySQL 1273\)/);
    expect(() => resolveDefaults({ charset: 'latin1', collation: 'nope_ci' })).toThrow(ApplyFailure);
  });

  it('applyScript 는 undefined 가 든 defaults 로도 던지지 않고, 문자셋만 줘도 맞는 콜레이션을 쓴다', () => {
    expect(applyScript(base, 'SET NAMES utf8mb4;', { schemaName: 'shop', defaults: { charset: undefined } })).toEqual(NO_STATEMENT);
    expect(applyScript(base, 'SET NAMES utf8mb4;', { schemaName: 'shop', defaults: { charset: 'latin1' } })).toEqual(NO_STATEMENT);
    expect(applyScript(base, 'SET NAMES utf8mb4;', { schemaName: 'shop', defaults: { collation: 'latin1_bin' } })).toEqual(NO_STATEMENT);
  });
});
