import { describe, expect, it } from 'vitest';
import { applyScript } from '../../src/apply';
import type { SchemaModel, Table } from '../../src/model';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

const BASE = parseSqlDump(tdExport([
  "CREATE TABLE `member` (\n  `id` int unsigned NOT NULL AUTO_INCREMENT,\n  `email` varchar(100) NOT NULL,\n  `name` varchar(50) DEFAULT NULL,\n  `age` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `email` (`email`),\n  KEY `name_age` (`name`,`age`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='회원';",
  'CREATE TABLE `orders` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `member_id` int unsigned NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `member_id` (`member_id`),\n  CONSTRAINT `orders_ibfk_1` FOREIGN KEY (`member_id`) REFERENCES `member` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
].join('\n\n'))).model;
const apply = (script: string) => applyScript(BASE, script, { schemaName: 'shop' });
const ok = (script: string) => {
  const r = apply(script);
  if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
  return r;
};
const tbl = (r: { model: SchemaModel }, name: string): Table => r.model.tables.find((t) => t.name === name)!;
const col = (r: { model: SchemaModel }, table: string, name: string) => tbl(r, table).columns.find((c) => c.name === name)!;

describe('ALTER TABLE — 컬럼', () => {
  it('ADD 여러 개·FIRST·AFTER, 새 컬럼은 정규화된다', () => {
    const r = ok("ALTER TABLE member ADD COLUMN nick VARCHAR(20) NOT NULL DEFAULT '' AFTER email, ADD (score INT DEFAULT 0, memo TEXT), ADD seq INT FIRST;");
    expect(tbl(r, 'member').columns.map((c) => c.name)).toEqual(['seq', 'id', 'email', 'nick', 'name', 'age', 'score', 'memo']);
    expect(col(r, 'member', 'score')).toMatchObject({ type: 'int', default: "'0'" });
    expect(col(r, 'member', 'memo').default).toBeUndefined();
  });

  it('MODIFY 는 정의 전체를 바꾸고, 대소문자만 다른 이름은 거부한다', () => {
    const r = ok('ALTER TABLE member MODIFY name VARCHAR(80) NOT NULL;');
    expect(col(r, 'member', 'name')).toEqual({ name: 'name', type: 'varchar(80)', nullable: false, invisible: false, autoIncrement: false });
    expect(apply('ALTER TABLE member MODIFY NAME VARCHAR(80);')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('CHANGE') } });
  });

  it('CHANGE·RENAME COLUMN 은 인덱스를 따라 바꾸고 rename 매핑을 남긴다, 한 문장 맞바꾸기', () => {
    const r = ok('ALTER TABLE member CHANGE name full_name VARCHAR(50) DEFAULT NULL, RENAME COLUMN age TO years;');
    expect(tbl(r, 'member').indexes.find((i) => i.name === 'name_age')!.parts.map((p) => p.column)).toEqual(['full_name', 'years']);
    expect(r.renames).toEqual([{ kind: 'column', table: 'member', from: 'name', to: 'full_name' }, { kind: 'column', table: 'member', from: 'age', to: 'years' }]);
    const swap = ok('ALTER TABLE member RENAME COLUMN name TO age, RENAME COLUMN age TO name;');
    expect(tbl(swap, 'member').columns.map((c) => `${c.name}:${c.type}`)).toEqual(['id:int unsigned', 'email:varchar(100)', 'age:varchar(50)', 'name:int']);
  });

  it('DROP COLUMN 은 인덱스에서 빠지고, FK 컬럼·참조되는 컬럼은 거부한다', () => {
    const r = ok('ALTER TABLE member DROP COLUMN age;');
    expect(tbl(r, 'member').indexes.find((i) => i.name === 'name_age')!.parts.map((p) => p.column)).toEqual(['name']);
    expect(apply('ALTER TABLE orders DROP COLUMN member_id;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1828') } });
    expect(apply('ALTER TABLE member DROP COLUMN id;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1829') } });
  });

  it('ALTER COLUMN SET/DROP DEFAULT·SET INVISIBLE', () => {
    const r = ok('ALTER TABLE member ALTER COLUMN age SET DEFAULT 20, ALTER name DROP DEFAULT, ALTER COLUMN email SET INVISIBLE;');
    expect(col(r, 'member', 'age').default).toBe("'20'");
    expect(col(r, 'member', 'name').default).toBe('NULL');
    expect(col(r, 'member', 'email').invisible).toBe(true);
  });

  it.each([
    ['ALTER TABLE member MODIFY nope INT;', '1054'],
    ['ALTER TABLE member ADD email INT;', '1060'],
    ['ALTER TABLE member DROP COLUMN nope;', '1091'],
    ['ALTER TABLE member MODIFY age INT, ALTER COLUMN age SET DEFAULT 1;', '두 번'],
    ['ALTER TABLE member CONVERT TO CHARACTER SET latin1;', '문자셋'],
    ['ALTER TABLE member ADD PARTITION (PARTITION p1 VALUES LESS THAN (10));', '파티션'],
    ['ALTER TABLE member MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;', 'FK 로 이어진'],
    ['ALTER TABLE nope ADD x INT;', '1146'],
    ['ALTER TABLE other.member ADD x INT;', '다른 스키마'],
    ['ALTER TABLE member ADD COLUMN g INT AS (age + 1);', '생성 컬럼'],
    ['ALTER TABLE member ADD x INT,;', '쉼표'],
    ['ALTER TABLE member ADD (x INT, y INT,);', '쉼표'],
  ])('%s → %s', (script, needle) => {
    expect(apply(script)).toMatchObject({ ok: false, error: { reason: expect.stringContaining(needle) } });
  });
});

describe('ALTER TABLE — 키·옵션·이름', () => {
  it('ADD INDEX 이름 없음·RENAME INDEX·ALTER INDEX, rename 매핑(index)', () => {
    const r = ok('ALTER TABLE member ADD INDEX (age), RENAME INDEX name_age TO ix_name_age, ALTER INDEX email INVISIBLE;');
    const t = tbl(r, 'member');
    expect(t.indexes.map((i) => i.name)).toEqual(['PRIMARY', 'email', 'ix_name_age', 'age']);
    expect(t.indexes.find((i) => i.name === 'email')!.invisible).toBe(true);
    expect(r.renames).toEqual([{ kind: 'index', table: 'member', from: 'name_age', to: 'ix_name_age' }]);
  });

  it('FK 추가는 이름·자동 인덱스를 MySQL 규칙으로, DROP FOREIGN KEY', () => {
    const r = ok('ALTER TABLE orders ADD COLUMN ref_id INT UNSIGNED, ADD FOREIGN KEY (ref_id) REFERENCES member (id) ON DELETE SET NULL;');
    const t = tbl(r, 'orders');
    expect(t.foreignKeys.at(-1)).toEqual({ name: 'orders_ibfk_2', columns: ['ref_id'], refTable: 'member', refColumns: ['id'], onDelete: 'SET NULL' });
    expect(t.indexes.map((i) => i.name)).toEqual(['PRIMARY', 'member_id', 'ref_id']);
    expect(tbl(ok('ALTER TABLE orders DROP FOREIGN KEY orders_ibfk_1;'), 'orders').foreignKeys).toEqual([]);
  });

  it('부모 컬럼 이름을 바꾸면 자식 FK 참조가 따라간다', () => {
    expect(tbl(ok('ALTER TABLE member RENAME COLUMN id TO member_no;'), 'orders').foreignKeys[0].refColumns).toEqual(['member_no']);
  });

  it('FK 를 받치는 인덱스 삭제는 1553, PRIMARY KEY 바꾸기', () => {
    expect(apply('ALTER TABLE orders DROP INDEX member_id;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1553') } });
    const r = ok('ALTER TABLE orders DROP PRIMARY KEY, ADD PRIMARY KEY (id, member_id);');
    expect(tbl(r, 'orders').indexes[0].parts.map((p) => p.column)).toEqual(['id', 'member_id']);
  });

  it('테이블 옵션: COMMENT·ROW_FORMAT, ROW_FORMAT=DEFAULT 는 옵션을 지운다, AUTO_INCREMENT·ALGORITHM 은 무시', () => {
    const r = ok("ALTER TABLE member COMMENT = '회원(v2)' ROW_FORMAT=DYNAMIC, ALGORITHM=INPLACE, AUTO_INCREMENT=100;");
    expect(tbl(r, 'member').options).toEqual([
      { key: 'ENGINE', value: 'InnoDB' }, { key: 'DEFAULT CHARSET', value: 'utf8mb4' }, { key: 'COLLATE', value: 'utf8mb4_0900_ai_ci' },
      { key: 'ROW_FORMAT', value: 'DYNAMIC' }, { key: 'COMMENT', value: "'회원(v2)'" },
    ]);
    expect(tbl(ok('ALTER TABLE member ROW_FORMAT=DYNAMIC; ALTER TABLE member ROW_FORMAT=DEFAULT;'), 'member').options.some((o) => o.key === 'ROW_FORMAT')).toBe(false);
  });

  it('CREATE INDEX … ON (ALGORITHM·LOCK 무시)·DROP INDEX … ON', () => {
    const r = ok('CREATE UNIQUE INDEX uq_name ON member (name) ALGORITHM=INPLACE LOCK=NONE;\nDROP INDEX name_age ON member;');
    expect(tbl(r, 'member').indexes.map((i) => i.name)).toEqual(['PRIMARY', 'email', 'uq_name']);
  });

  it('ALTER TABLE … RENAME TO 는 자식 FK 참조·자동 FK 이름을 바꾼다', () => {
    const r = ok('ALTER TABLE orders RENAME TO purchase; ALTER TABLE member RENAME TO person;');
    expect(tbl(r, 'purchase').foreignKeys[0]).toMatchObject({ name: 'purchase_ibfk_1', refTable: 'person' });
    expect(r.renames).toEqual(expect.arrayContaining([{ kind: 'table', from: 'orders', to: 'purchase' }, { kind: 'table', from: 'member', to: 'person' }]));
  });
});

// 키 파트 길이(prefix)·FULLTEXT·SET NULL FK 를 가진 테이블 (SHOW CREATE 모양, 키 순서는 MySQL 저장 순서)
const KEYS_BASE = parseSqlDump(tdExport([
  'CREATE TABLE `parent` (\n  `id` int unsigned NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  'CREATE TABLE `doc` (\n  `id` int NOT NULL,\n  `title` varchar(20) DEFAULT NULL,\n  `body` text,\n  `tag` varchar(20) DEFAULT NULL,\n  `code` varchar(10) NOT NULL,\n  `memo` text,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_tag_code` (`tag`(5),`code`),\n  KEY `ix_title` (`title`(10)),\n  KEY `ix_body` (`body`(10)),\n  KEY `ix_code` (`code`),\n  FULLTEXT KEY `ft_memo` (`memo`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  'CREATE TABLE `child` (\n  `id` int NOT NULL,\n  `pid` int unsigned DEFAULT NULL,\n  `qid` int unsigned DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `pid` (`pid`),\n  KEY `qid` (`qid`),\n  CONSTRAINT `child_ibfk_1` FOREIGN KEY (`pid`) REFERENCES `parent` (`id`) ON DELETE SET NULL,\n  CONSTRAINT `child_ibfk_2` FOREIGN KEY (`qid`) REFERENCES `parent` (`id`) ON UPDATE SET NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
].join('\n\n'))).model;
const applyKeys = (script: string) => applyScript(KEYS_BASE, script, { schemaName: 'shop' });
const okKeys = (script: string) => {
  const r = applyKeys(script);
  if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
  return r;
};
const partsOf = (r: { model: SchemaModel }, table: string, index: string) => tbl(r, table).indexes.find((i) => i.name === index)!.parts;
const rejected = (script: string, needle: string) => expect(applyKeys(script)).toMatchObject({ ok: false, error: { reason: expect.stringContaining(needle) } });
const WHOLE_TITLE = [{ column: 'title', desc: false }]; // 길이 없는 키 파트 (length 키 자체가 없다)

// 아래 기대값은 MySQL 8.0.46·8.4.11 에서 같은 문장을 돌려 SHOW CREATE TABLE 로 확인한 결과다 (두 버전이 같다)
describe('ALTER TABLE — 컬럼을 바꾼 뒤 기존 키 파트 길이', () => {
  it('MODIFY: 새 길이가 prefix 이하이면 prefix 는 오류 없이 없어지고, 더 길면 남는다', () => {
    expect(partsOf(okKeys('ALTER TABLE doc MODIFY title varchar(10);'), 'doc', 'ix_title')).toStrictEqual(WHOLE_TITLE); // 같은 길이: SHOW CREATE 가 전체 컬럼으로 찍는다
    expect(partsOf(okKeys('ALTER TABLE doc MODIFY title varchar(9);'), 'doc', 'ix_title')).toStrictEqual(WHOLE_TITLE); // 더 짧아도 MySQL 은 거부하지 않는다 (1089 아님)
    expect(partsOf(okKeys('ALTER TABLE doc MODIFY title varchar(5);'), 'doc', 'ix_title')).toStrictEqual(WHOLE_TITLE);
    expect(partsOf(okKeys('ALTER TABLE doc MODIFY title varchar(11);'), 'doc', 'ix_title')).toStrictEqual([{ column: 'title', length: 10, desc: false }]);
    expect(partsOf(okKeys('ALTER TABLE doc MODIFY title varchar(20) NOT NULL;'), 'doc', 'ix_title')).toStrictEqual([{ column: 'title', length: 10, desc: false }]);
  });

  it('MODIFY: prefix 를 가질 수 없는 타입(INT·ENUM)이면 없어지고, TEXT 로 바꾸면 남는다', () => {
    expect(partsOf(okKeys('ALTER TABLE doc MODIFY title int;'), 'doc', 'ix_title')).toStrictEqual(WHOLE_TITLE);
    expect(partsOf(okKeys("ALTER TABLE doc MODIFY title enum('a','b');"), 'doc', 'ix_title')).toStrictEqual(WHOLE_TITLE);
    expect(partsOf(okKeys('ALTER TABLE doc MODIFY title text;'), 'doc', 'ix_title')).toStrictEqual([{ column: 'title', length: 10, desc: false }]);
    expect(partsOf(okKeys('ALTER TABLE doc MODIFY body mediumtext;'), 'doc', 'ix_body')).toStrictEqual([{ column: 'body', length: 10, desc: false }]);
  });

  it('TEXT 를 VARCHAR 로 바꿔도 같은 규칙 (10 이하는 없어지고 더 길면 남는다)', () => {
    expect(partsOf(okKeys('ALTER TABLE doc MODIFY body varchar(10);'), 'doc', 'ix_body')).toStrictEqual([{ column: 'body', desc: false }]);
    expect(partsOf(okKeys('ALTER TABLE doc MODIFY body char(5);'), 'doc', 'ix_body')).toStrictEqual([{ column: 'body', desc: false }]);
    expect(partsOf(okKeys('ALTER TABLE doc MODIFY body varchar(20);'), 'doc', 'ix_body')).toStrictEqual([{ column: 'body', length: 10, desc: false }]);
  });

  it('CHANGE 는 이름을 따라 바꾸면서 같은 규칙을 적용하고, RENAME COLUMN 은 길이를 그대로 둔다', () => {
    const changed = okKeys('ALTER TABLE doc CHANGE title heading varchar(10);');
    expect(partsOf(changed, 'doc', 'ix_title')).toStrictEqual([{ column: 'heading', desc: false }]);
    expect(partsOf(okKeys('ALTER TABLE doc RENAME COLUMN title TO heading;'), 'doc', 'ix_title')).toStrictEqual([{ column: 'heading', length: 10, desc: false }]);
  });

  it('키 파트마다 따로 보고, UNIQUE 종류·DESC 방향은 그대로 둔다', () => {
    const r = okKeys('ALTER TABLE doc ADD INDEX ix_d (title(10) DESC, code);\nALTER TABLE doc MODIFY title varchar(10), MODIFY tag varchar(5);');
    expect(partsOf(r, 'doc', 'ix_d')).toStrictEqual([{ column: 'title', desc: true }, { column: 'code', desc: false }]);
    expect(tbl(r, 'doc').indexes.find((i) => i.name === 'uq_tag_code')).toMatchObject({ kind: 'UNIQUE', parts: [{ column: 'tag', desc: false }, { column: 'code', desc: false }] });
    const partial = okKeys('ALTER TABLE doc MODIFY tag varchar(6);');
    expect(partsOf(partial, 'doc', 'uq_tag_code')).toStrictEqual([{ column: 'tag', length: 5, desc: false }, { column: 'code', desc: false }]);
  });

  it('같은 문장에서 새로 쓴 prefix 는 새 정의로 검사한다 (1089), 새 길이와 같으면 전체 컬럼 키가 된다', () => {
    rejected('ALTER TABLE doc MODIFY title varchar(5), ADD INDEX ix2 (title(10));', '1089');
    const r = okKeys('ALTER TABLE doc MODIFY title varchar(5), ADD INDEX ix2 (title(5));');
    expect(partsOf(r, 'doc', 'ix2')).toStrictEqual(WHOLE_TITLE);
    expect(partsOf(r, 'doc', 'ix_title')).toStrictEqual(WHOLE_TITLE);
  });

  it('입력 모델은 그대로 둔다', () => {
    const before = JSON.stringify(KEYS_BASE);
    okKeys('ALTER TABLE doc MODIFY title varchar(5);');
    expect(JSON.stringify(KEYS_BASE)).toBe(before);
  });
});

describe('ALTER TABLE — 컬럼을 바꾼 뒤 기존 키가 새 타입에 맞는지', () => {
  it.each([
    ['ALTER TABLE doc MODIFY code text;', '1170'], // 길이 없는 키 파트가 TEXT 가 되면
    ['ALTER TABLE doc MODIFY code blob;', '1170'],
    ['ALTER TABLE doc MODIFY id text NOT NULL;', '1170'], // PRIMARY KEY 도 같다
    ['ALTER TABLE doc MODIFY code json;', '3152'],
    ['ALTER TABLE doc MODIFY title json;', '3152'], // prefix 가 있어도 JSON 은 키에 쓸 수 없다
    ['ALTER TABLE doc MODIFY memo int;', '1283'], // FULLTEXT 는 문자열 컬럼만
  ])('%s → %s', (script, needle) => {
    rejected(script, needle);
  });

  it('맞는 변경은 받는다: FULLTEXT 컬럼을 다른 문자열 타입으로, 길이 없는 키 컬럼을 INT 나 더 긴 VARCHAR 로', () => {
    expect(tbl(okKeys('ALTER TABLE doc MODIFY memo varchar(10);'), 'doc').indexes.find((i) => i.name === 'ft_memo')!.kind).toBe('FULLTEXT');
    expect(col(okKeys('ALTER TABLE doc MODIFY code int NOT NULL;'), 'doc', 'code').type).toBe('int');
    expect(col(okKeys('ALTER TABLE doc MODIFY code varchar(300) NOT NULL;'), 'doc', 'code').type).toBe('varchar(300)');
  });
});

describe('ALTER TABLE — SET NULL FK 컬럼은 NOT NULL 이 될 수 없다 (MySQL 1830)', () => {
  it.each([
    ['ALTER TABLE child MODIFY pid int unsigned NOT NULL;'], // ON DELETE SET NULL
    ['ALTER TABLE child MODIFY qid int unsigned NOT NULL;'], // ON UPDATE SET NULL
    ['ALTER TABLE child MODIFY pid int unsigned NOT NULL DEFAULT 5;'],
    ['ALTER TABLE child CHANGE pid owner int unsigned NOT NULL;'], // CHANGE 로 이름을 바꾸면서
    ['ALTER TABLE child ADD COLUMN z int, MODIFY pid int unsigned NOT NULL AFTER z;'],
    ['ALTER TABLE child DROP PRIMARY KEY, ADD PRIMARY KEY (pid);'], // PRIMARY KEY 는 컬럼을 암묵적으로 NOT NULL 로 만든다
  ])('%s', (script) => {
    rejected(script, '1830');
  });

  it('그 FK 를 같은 문장에서 지우면 NOT NULL 로 바꿀 수 있고, SET NULL 이 아닌 FK·FK 없는 컬럼은 상관없다', () => {
    expect(col(okKeys('ALTER TABLE child DROP FOREIGN KEY child_ibfk_1, MODIFY pid int unsigned NOT NULL;'), 'child', 'pid').nullable).toBe(false);
    expect(col(okKeys('ALTER TABLE child MODIFY pid int unsigned NOT NULL, DROP FOREIGN KEY child_ibfk_1;'), 'child', 'pid').nullable).toBe(false);
    const cascade = okKeys('ALTER TABLE child ADD COLUMN rid int unsigned, ADD FOREIGN KEY (rid) REFERENCES parent (id) ON DELETE CASCADE;\nALTER TABLE child MODIFY rid int unsigned NOT NULL;');
    expect(col(cascade, 'child', 'rid').nullable).toBe(false);
    expect(col(okKeys('ALTER TABLE child ADD COLUMN z int;\nALTER TABLE child MODIFY z int NOT NULL;'), 'child', 'z').nullable).toBe(false);
  });

  it('NULL 을 유지하는 변경·SET DEFAULT 는 받는다', () => {
    expect(col(okKeys('ALTER TABLE child MODIFY pid int unsigned NULL;'), 'child', 'pid')).toMatchObject({ nullable: true, default: 'NULL' });
    expect(col(okKeys('ALTER TABLE child MODIFY pid int unsigned;'), 'child', 'pid').nullable).toBe(true);
    expect(col(okKeys('ALTER TABLE child ALTER COLUMN pid SET DEFAULT 5;'), 'child', 'pid')).toMatchObject({ nullable: true, default: "'5'" });
  });

  it('메시지에 컬럼·FK 이름이 있다', () => {
    rejected('ALTER TABLE child MODIFY pid int unsigned NOT NULL;', 'child_ibfk_1');
    rejected('ALTER TABLE child CHANGE pid owner int unsigned NOT NULL;', 'owner');
  });
});

// 컬럼 정의 안의 PRIMARY KEY·UNIQUE [KEY]·KEY 는 MySQL 이 그 컬럼의 인덱스로 바꾼다 (MySQL 8.0.46·8.4.11 실측)
describe('ALTER TABLE — 컬럼 정의 안의 PRIMARY KEY·UNIQUE', () => {
  const indexNames = (r: { model: SchemaModel }, table: string) => tbl(r, table).indexes.map((i) => `${i.kind} ${i.name}`);

  it('ADD COLUMN … UNIQUE [KEY] 는 컬럼 이름의 UNIQUE 인덱스를 만든다 (NULL 허용 UNIQUE 는 NOT NULL UNIQUE 뒤, 일반 인덱스 앞)', () => {
    const r = ok('ALTER TABLE member ADD COLUMN nick VARCHAR(20) UNIQUE, ADD COLUMN c2 INT UNIQUE KEY;');
    expect(indexNames(r, 'member')).toEqual(['PRIMARY PRIMARY', 'UNIQUE email', 'UNIQUE nick', 'UNIQUE c2', 'INDEX name_age']);
    expect(tbl(r, 'member').indexes.find((i) => i.name === 'nick')!.parts).toEqual([{ column: 'nick', desc: false }]);
  });

  it('MODIFY·CHANGE 의 UNIQUE 도 인덱스를 더한다 (같은 컬럼에 이미 있으면 _2)', () => {
    expect(indexNames(ok('ALTER TABLE member MODIFY email VARCHAR(100) NOT NULL UNIQUE;'), 'member')).toEqual(['PRIMARY PRIMARY', 'UNIQUE email', 'UNIQUE email_2', 'INDEX name_age']);
    expect(indexNames(ok('ALTER TABLE member MODIFY age INT UNIQUE;'), 'member')).toContain('UNIQUE age');
    expect(indexNames(ok('ALTER TABLE member CHANGE age years INT UNIQUE;'), 'member')).toContain('UNIQUE years');
  });

  it('여러 컬럼을 한 번에 더하는 ADD (…) 도 같다', () => {
    expect(indexNames(ok('ALTER TABLE member ADD (a1 INT UNIQUE, a2 INT);'), 'member')).toEqual(['PRIMARY PRIMARY', 'UNIQUE email', 'UNIQUE a1', 'INDEX name_age']);
  });

  it('컬럼 안 REFERENCES 는 무시하지만 UNIQUE 는 인덱스가 된다', () => {
    const r = ok('ALTER TABLE orders ADD COLUMN ref INT UNSIGNED UNIQUE REFERENCES member (id);');
    expect(tbl(r, 'orders').foreignKeys.map((f) => f.name)).toEqual(['orders_ibfk_1']);
    expect(indexNames(r, 'orders')).toContain('UNIQUE ref');
  });

  it('키 절과 같은 차례로 처리한다: 먼저 쓴 쪽이 이름을 차지한다 (뒤의 같은 명시 이름은 1061, 뒤의 자동 이름은 _2)', () => {
    expect(apply('ALTER TABLE member ADD COLUMN a1 INT UNIQUE, ADD UNIQUE INDEX a1 (age);')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1061') } });
    expect(indexNames(ok('ALTER TABLE member ADD UNIQUE INDEX a1 (age), ADD COLUMN a1 INT UNIQUE;'), 'member')).toEqual(['PRIMARY PRIMARY', 'UNIQUE email', 'UNIQUE a1', 'UNIQUE a1_2', 'INDEX name_age']);
  });

  it('PRIMARY KEY·KEY 는 PRIMARY KEY 가 없을 때만 (1068), DROP PRIMARY KEY 와 함께면 새 PK 가 되고 컬럼은 NOT NULL', () => {
    expect(apply('ALTER TABLE member ADD COLUMN x INT KEY;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1068') } });
    expect(apply('ALTER TABLE member MODIFY id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1068') } });
    const r = okKeys('ALTER TABLE doc DROP PRIMARY KEY, ADD COLUMN x INT PRIMARY KEY;');
    expect(tbl(r, 'doc').indexes[0]).toMatchObject({ kind: 'PRIMARY', name: 'PRIMARY', parts: [{ column: 'x', desc: false }] });
    expect(col(r, 'doc', 'x')).toMatchObject({ nullable: false });
    expect(col(r, 'doc', 'x').default).toBeUndefined();
  });
});
