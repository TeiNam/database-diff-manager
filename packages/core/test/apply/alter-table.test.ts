import { describe, expect, it } from 'vitest';
import { applyScript } from '../../src/apply';
import { RE_EXPORT } from '../../src/apply/types';
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
    expect(col(r, 'member', 'name').default).toBeUndefined(); // MySQL 8.0.46·8.4.11 실측: DROP DEFAULT 는 NULL 허용 컬럼에도 DEFAULT 절을 남기지 않는다 (코디네이터 승인으로 'NULL' 에서 바꿈)
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

  // 이 문장이 더한 컬럼은 기준(before)에 없다. PRIMARY KEY 가 FK 보다 뒤에 오면 FK 를 붙일 때는 NULL 허용이라 문장 끝 검사가 잡아야 한다 (MySQL 8.0.46·8.4.11 실측: 순서와 상관없이 1830)
  describe('이 문장이 더한 컬럼', () => {
    const NOPK = 'CREATE TABLE nopk (k int unsigned);\n';
    const FK = 'ADD FOREIGN KEY (x) REFERENCES parent (id) ON DELETE SET NULL';
    it.each([
      [`ALTER TABLE nopk ADD COLUMN x int unsigned, ${FK}, ADD PRIMARY KEY (x);`], // FK 가 먼저 — 예전에는 받아들였다
      [`ALTER TABLE nopk ADD COLUMN x int unsigned, ADD PRIMARY KEY (x), ${FK};`], // PRIMARY KEY 가 먼저
      [`ALTER TABLE nopk ADD COLUMN x int unsigned PRIMARY KEY, ${FK};`],
      [`ALTER TABLE nopk ${FK}, ADD COLUMN x int unsigned PRIMARY KEY;`], // FK 절이 컬럼 절보다 앞
      ['ALTER TABLE nopk ADD FOREIGN KEY (k) REFERENCES parent (id) ON DELETE SET NULL, ADD PRIMARY KEY (k);'], // 기존 컬럼
      ['ALTER TABLE nopk ADD FOREIGN KEY (k) REFERENCES parent (id) ON UPDATE SET NULL, MODIFY k int unsigned PRIMARY KEY;'],
      [`ALTER TABLE nopk ADD COLUMN x int unsigned NOT NULL, ${FK};`], // 직접 쓴 NOT NULL
    ])('거부: %s', (script) => {
      rejected(`${NOPK}${script}`, '1830');
    });

    it('PRIMARY KEY 가 없으면 받는다 (UNIQUE 는 컬럼을 NOT NULL 로 만들지 않는다)', () => {
      expect(col(okKeys(`${NOPK}ALTER TABLE nopk ADD COLUMN x int unsigned, ${FK};`), 'nopk', 'x').nullable).toBe(true);
      expect(col(okKeys(`${NOPK}ALTER TABLE nopk ADD COLUMN x int unsigned, ${FK}, ADD UNIQUE (x);`), 'nopk', 'x').nullable).toBe(true);
    });
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

// MySQL 8.0.46·8.4.11 실측: ALTER COLUMN … DROP DEFAULT 는 컬럼 종류와 상관없이 DEFAULT 절을 없앤다 (NULL 허용 컬럼도 `DEFAULT NULL` 이 사라진다).
// 그 뒤 SET DEFAULT NULL 이면 `DEFAULT NULL` 이 다시 보인다
describe('ALTER TABLE — ALTER COLUMN … DROP DEFAULT', () => {
  const DEFAULTS_BASE = parseSqlDump(tdExport(
    "CREATE TABLE `d` (\n  `id` int NOT NULL,\n  `n1` varchar(10) DEFAULT NULL,\n  `n2` varchar(10) NOT NULL,\n  `n3` text,\n  `n4` int DEFAULT '5',\n  `n5` int NOT NULL AUTO_INCREMENT,\n  `n6` json DEFAULT NULL,\n  `n7` datetime DEFAULT CURRENT_TIMESTAMP,\n  `n9` int NOT NULL DEFAULT '7',\n  `n10` varchar(5) DEFAULT 'x',\n  `n11` timestamp NULL DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `n5` (`n5`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;",
  )).model;
  const run = (script: string) => {
    const r = applyScript(DEFAULTS_BASE, script, { schemaName: 'shop' });
    if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
    return r;
  };

  it.each([
    ['n1', 'varchar(10)'], ['n3', 'text'], ['n4', 'int'], ['n6', 'json'], ['n7', 'datetime'], ['n10', 'varchar(5)'], ['n11', 'timestamp'],
  ])('NULL 허용·기본값 있는 컬럼 %s 는 DEFAULT 절이 없어진다 (키 자체가 없다)', (name, type) => {
    const c = col(run(`ALTER TABLE d ALTER COLUMN ${name} DROP DEFAULT;`), 'd', name);
    expect(c.type).toBe(type);
    expect(c.nullable).toBe(true);
    expect('default' in c).toBe(false);
  });

  it('NOT NULL 컬럼은 기본값만 없어지고, AUTO_INCREMENT 컬럼은 그대로다', () => {
    const r = run('ALTER TABLE d ALTER COLUMN n9 DROP DEFAULT, ALTER COLUMN n2 DROP DEFAULT, ALTER COLUMN n5 DROP DEFAULT;');
    expect(col(r, 'd', 'n9')).toMatchObject({ nullable: false });
    expect('default' in col(r, 'd', 'n9')).toBe(false);
    expect(col(r, 'd', 'n5')).toMatchObject({ nullable: false, autoIncrement: true });
    expect('default' in col(r, 'd', 'n5')).toBe(false);
  });

  it('DROP DEFAULT 뒤 SET DEFAULT NULL 은 DEFAULT NULL 을 되살린다', () => {
    const r = run('ALTER TABLE d ALTER COLUMN n1 DROP DEFAULT;\nALTER TABLE d ALTER COLUMN n1 SET DEFAULT NULL;');
    expect(col(r, 'd', 'n1').default).toBe('NULL');
  });
});

// MySQL 8.0.46·8.4.11 실측: PRIMARY KEY 에 든 컬럼은 문장이 끝났을 때 NOT NULL 이다 (`DEFAULT NULL` 은 없어지고 다른 기본값은 남는다).
// 컬럼 정의가 NULL 이나 DEFAULT NULL 을 명시했는데 PRIMARY KEY 에 있으면 1171. AUTO_INCREMENT 컬럼은 NULL 을 써도 NOT NULL
describe('ALTER TABLE — 암묵적 NOT NULL (PRIMARY KEY·AUTO_INCREMENT)', () => {
  const PK_BASE = parseSqlDump(tdExport([
    'CREATE TABLE `pk1` (\n  `id` int NOT NULL,\n  `v` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `v` (`v`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
    'CREATE TABLE `pk2` (\n  `a` int NOT NULL,\n  `b` int NOT NULL,\n  `v` int DEFAULT NULL,\n  PRIMARY KEY (`a`,`b`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
    "CREATE TABLE `np` (\n  `c` int DEFAULT NULL,\n  `d` int DEFAULT '5',\n  `v` int DEFAULT NULL,\n  UNIQUE KEY `uq_c` (`c`),\n  KEY `v` (`v`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;",
  ].join('\n\n'))).model;
  const run = (script: string) => applyScript(PK_BASE, script, { schemaName: 'shop' });
  const runOk = (script: string) => {
    const r = run(script);
    if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
    return r;
  };
  const rejects = (script: string, errno: string) => expect(run(script)).toMatchObject({ ok: false, error: { reason: expect.stringContaining(errno) } });
  const notNullNoDefault = (r: { model: SchemaModel }, table: string, name: string) => {
    const c = col(r, table, name);
    expect(c.nullable).toBe(false);
    expect('default' in c).toBe(false);
  };

  it('PRIMARY KEY 컬럼을 NOT NULL 없이 MODIFY·CHANGE 하면 NOT NULL 로 남고, 명시한 다른 기본값은 남는다', () => {
    notNullNoDefault(runOk('ALTER TABLE pk1 MODIFY id bigint;'), 'pk1', 'id');
    notNullNoDefault(runOk('ALTER TABLE pk2 MODIFY b bigint;'), 'pk2', 'b');
    expect(col(runOk('ALTER TABLE pk1 MODIFY id int DEFAULT 5;'), 'pk1', 'id')).toMatchObject({ nullable: false, default: "'5'" });
    const changed = runOk('ALTER TABLE pk1 CHANGE id id2 bigint;');
    notNullNoDefault(changed, 'pk1', 'id2');
    expect(tbl(changed, 'pk1').indexes[0]).toMatchObject({ kind: 'PRIMARY', parts: [{ column: 'id2' }] });
  });

  it.each([
    ['ALTER TABLE pk1 MODIFY id int NULL;'],
    ['ALTER TABLE pk1 CHANGE id id2 int NULL;'],
    ['ALTER TABLE pk1 MODIFY id int DEFAULT NULL;'], // DEFAULT NULL 도 NULL 을 명시한 것
    ['ALTER TABLE pk1 MODIFY id int NULL DEFAULT NULL;'],
    ['ALTER TABLE pk2 MODIFY b int NULL;'],
    ['ALTER TABLE pk1 MODIFY id int NULL AUTO_INCREMENT;'], // AUTO_INCREMENT 가 NOT NULL 을 만들어도 PK 에서는 명시한 NULL 이 먼저 걸린다
    ['ALTER TABLE pk1 MODIFY id int DEFAULT NULL AUTO_INCREMENT;'],
  ])('PRIMARY KEY 컬럼에 NULL 을 명시하면 1171: %s', (script) => {
    rejects(script, '1171');
  });

  it('새 PRIMARY KEY 도 같다: NULL 을 명시한 컬럼은 1171 (절 순서·MODIFY/ADD COLUMN 무관), 명시하지 않았으면 NOT NULL', () => {
    rejects('ALTER TABLE np MODIFY c INT NULL, ADD PRIMARY KEY (c);', '1171');
    rejects('ALTER TABLE np ADD PRIMARY KEY (c), MODIFY c INT NULL;', '1171');
    rejects('ALTER TABLE np MODIFY c INT DEFAULT NULL, ADD PRIMARY KEY (c);', '1171');
    rejects('ALTER TABLE np ADD COLUMN x INT NULL, ADD PRIMARY KEY (x);', '1171');
    rejects('ALTER TABLE np ADD COLUMN x INT DEFAULT NULL, ADD PRIMARY KEY (x);', '1171');
    rejects('ALTER TABLE np ADD COLUMN x INT NULL AUTO_INCREMENT, ADD PRIMARY KEY (x);', '1171');
    notNullNoDefault(runOk('ALTER TABLE np MODIFY c INT, ADD PRIMARY KEY (c);'), 'np', 'c');
    notNullNoDefault(runOk('ALTER TABLE np ADD COLUMN x INT, ADD PRIMARY KEY (x);'), 'np', 'x');
    notNullNoDefault(runOk('ALTER TABLE np ADD PRIMARY KEY (c);'), 'np', 'c'); // 문장에 쓰지 않은 기존 컬럼은 NULL 허용이었어도 조용히 NOT NULL
    expect(col(runOk('ALTER TABLE np ADD PRIMARY KEY (d);'), 'np', 'd')).toMatchObject({ nullable: false, default: "'5'" });
  });

  it('컬럼 정의 안의 PRIMARY KEY: NULL 은 1171, DEFAULT NULL 은 1067 (표 수준 PRIMARY KEY 와 번호가 다르다)', () => {
    rejects('ALTER TABLE np ADD COLUMN x INT NULL PRIMARY KEY;', '1171');
    rejects('ALTER TABLE np ADD COLUMN x INT DEFAULT NULL PRIMARY KEY;', '1067');
    rejects('ALTER TABLE np ADD COLUMN x INT DEFAULT NULL AUTO_INCREMENT PRIMARY KEY;', '1171'); // AUTO_INCREMENT 가 있으면 1171
    notNullNoDefault(runOk('ALTER TABLE np ADD COLUMN x INT PRIMARY KEY;'), 'np', 'x');
  });

  it('같은 문장에서 PRIMARY KEY 를 지우면 NULL 을 명시해도 된다 (절 순서 무관), 다시 더하면 1171', () => {
    const a = runOk('ALTER TABLE pk1 MODIFY id int NULL, DROP PRIMARY KEY;');
    expect(col(a, 'pk1', 'id')).toMatchObject({ nullable: true, default: 'NULL' });
    expect(col(runOk('ALTER TABLE pk1 DROP PRIMARY KEY, MODIFY id int NULL;'), 'pk1', 'id').nullable).toBe(true);
    rejects('ALTER TABLE pk1 MODIFY id int NULL, DROP PRIMARY KEY, ADD PRIMARY KEY (id);', '1171');
    const other = runOk('ALTER TABLE pk1 MODIFY id int NULL, DROP PRIMARY KEY, ADD PRIMARY KEY (v);');
    expect(col(other, 'pk1', 'id').nullable).toBe(true);
    notNullNoDefault(other, 'pk1', 'v');
  });

  it('UNIQUE 키 컬럼은 NULL 허용으로 남는다', () => {
    expect(col(runOk('ALTER TABLE np MODIFY c bigint;'), 'np', 'c')).toMatchObject({ nullable: true, default: 'NULL' });
  });

  it('AUTO_INCREMENT 컬럼은 NULL·DEFAULT NULL 을 써도 NOT NULL 이고 기본값이 없다 (PRIMARY KEY 가 아니어도)', () => {
    notNullNoDefault(runOk('ALTER TABLE np MODIFY v int AUTO_INCREMENT;'), 'np', 'v');
    notNullNoDefault(runOk('ALTER TABLE np MODIFY v int NULL AUTO_INCREMENT;'), 'np', 'v');
    notNullNoDefault(runOk('ALTER TABLE np MODIFY v int DEFAULT NULL AUTO_INCREMENT;'), 'np', 'v');
    notNullNoDefault(runOk('ALTER TABLE np MODIFY v int NOT NULL DEFAULT NULL AUTO_INCREMENT;'), 'np', 'v');
    notNullNoDefault(runOk('ALTER TABLE np ADD COLUMN x int AUTO_INCREMENT UNIQUE;'), 'np', 'x');
    notNullNoDefault(runOk('ALTER TABLE pk1 MODIFY id bigint AUTO_INCREMENT;'), 'pk1', 'id');
    rejects('ALTER TABLE np MODIFY v int DEFAULT 5 AUTO_INCREMENT;', '1067');
  });

  it('NOT NULL 로 바꾸면 암묵적 DEFAULT NULL 은 없어진다', () => {
    notNullNoDefault(runOk('ALTER TABLE np MODIFY v int NOT NULL;'), 'np', 'v');
  });
});

// MySQL 8.0.46·8.4.11 실측: SHOW CREATE 는 FK 를 이름 순(소문자 코드 포인트 순)으로 찍고, 이름 없는 FK 의 번호는 문장 앞의 FK 이름 중 가장 큰 번호 + 1 부터다
describe('ALTER TABLE — FK 목록 순서와 자동 번호', () => {
  const fkNames = (r: { model: SchemaModel }, table = 'child') => tbl(r, table).foreignKeys.map((f) => f.name);
  const ADD_RID = 'ADD COLUMN rid int unsigned';

  it('직접 이름을 붙인 FK 는 이름 순 자리에 들어간다 (끝에 붙지 않는다)', () => {
    expect(fkNames(okKeys(`ALTER TABLE child ${ADD_RID}, ADD CONSTRAINT child_fk FOREIGN KEY (rid) REFERENCES parent (id);`))).toEqual(['child_fk', 'child_ibfk_1', 'child_ibfk_2']);
    expect(fkNames(okKeys(`ALTER TABLE child ${ADD_RID}, ADD CONSTRAINT Child_ZZ FOREIGN KEY (rid) REFERENCES parent (id);`))).toEqual(['child_ibfk_1', 'child_ibfk_2', 'Child_ZZ']);
    expect(fkNames(okKeys(`ALTER TABLE child ${ADD_RID}, ADD CONSTRAINT CHILD_A FOREIGN KEY (rid) REFERENCES parent (id);`))).toEqual(['CHILD_A', 'child_ibfk_1', 'child_ibfk_2']);
  });

  it('이름 없는 FK 는 문장 앞 번호 다음이다: 지우는 FK 의 번호도 센다, 빈 번호는 되쓰지 않는다', () => {
    expect(fkNames(okKeys(`ALTER TABLE child DROP FOREIGN KEY child_ibfk_2, ${ADD_RID}, ADD FOREIGN KEY (rid) REFERENCES parent (id);`))).toEqual(['child_ibfk_1', 'child_ibfk_3']);
    expect(fkNames(okKeys(`ALTER TABLE child DROP FOREIGN KEY child_ibfk_1, DROP FOREIGN KEY child_ibfk_2, ${ADD_RID}, ADD FOREIGN KEY (rid) REFERENCES parent (id);`))).toEqual(['child_ibfk_3']);
    expect(fkNames(okKeys(`ALTER TABLE child DROP CONSTRAINT child_ibfk_2, ${ADD_RID}, ADD FOREIGN KEY (rid) REFERENCES parent (id);`))).toEqual(['child_ibfk_1', 'child_ibfk_3']);
    expect(fkNames(okKeys(`ALTER TABLE child ${ADD_RID}, ADD FOREIGN KEY (rid) REFERENCES parent (id), DROP FOREIGN KEY child_ibfk_1;`))).toEqual(['child_ibfk_2', 'child_ibfk_3']);
    // 앞 문장에서 지운 번호는 문장이 끝났으니 센다 → 그 뒤 문장은 남은 FK 기준
    expect(fkNames(okKeys(`ALTER TABLE child DROP FOREIGN KEY child_ibfk_2;\nALTER TABLE child ${ADD_RID}, ADD FOREIGN KEY (rid) REFERENCES parent (id);`))).toEqual(['child_ibfk_1', 'child_ibfk_2']);
  });

  it('번호에 빈 자리가 있어도 가장 큰 번호 + 1, 한 문장에서 이름 없이 여러 개 더하면 차례로', () => {
    const gap = 'ALTER TABLE child ADD COLUMN r1 int unsigned, ADD CONSTRAINT child_ibfk_5 FOREIGN KEY (r1) REFERENCES parent (id);\n';
    expect(fkNames(okKeys(`${gap}ALTER TABLE child ${ADD_RID}, ADD FOREIGN KEY (rid) REFERENCES parent (id);`))).toEqual(['child_ibfk_1', 'child_ibfk_2', 'child_ibfk_5', 'child_ibfk_6']);
    expect(fkNames(okKeys('ALTER TABLE child ADD COLUMN r1 int unsigned, ADD COLUMN r2 int unsigned, ADD FOREIGN KEY (r1) REFERENCES parent (id), ADD FOREIGN KEY (r2) REFERENCES parent (id);'))).toEqual(['child_ibfk_1', 'child_ibfk_2', 'child_ibfk_3', 'child_ibfk_4']);
  });

  it('같은 문장에서 직접 쓴 이름은 번호에 영향을 주지 않는다: 이름 없는 FK 는 앞 번호 + 1, 이름이 겹치면 1826', () => {
    expect(fkNames(okKeys('ALTER TABLE child ADD COLUMN r1 int unsigned, ADD COLUMN r2 int unsigned, ADD CONSTRAINT child_ibfk_7 FOREIGN KEY (r1) REFERENCES parent (id), ADD FOREIGN KEY (r2) REFERENCES parent (id);')))
      .toEqual(['child_ibfk_1', 'child_ibfk_2', 'child_ibfk_3', 'child_ibfk_7']);
    expect(applyKeys('ALTER TABLE child ADD COLUMN r1 int unsigned, ADD COLUMN r2 int unsigned, ADD FOREIGN KEY (r1) REFERENCES parent (id), ADD CONSTRAINT child_ibfk_3 FOREIGN KEY (r2) REFERENCES parent (id);'))
      .toMatchObject({ ok: false, error: { reason: expect.stringContaining('1826') } });
  });

  it('테이블 이름을 바꾸면 자동 이름이 바뀌어 순서도 다시 정해진다 (RENAME TO 와 같은 문장에서 더한 FK 는 바뀐 이름으로 번호만 이어간다)', () => {
    const named = `ALTER TABLE child ${ADD_RID}, ADD CONSTRAINT fk_m FOREIGN KEY (rid) REFERENCES parent (id);\n`;
    expect(fkNames(okKeys(named), 'child')).toEqual(['child_ibfk_1', 'child_ibfk_2', 'fk_m']);
    expect(fkNames(okKeys(`${named}ALTER TABLE child RENAME TO zzz;`), 'zzz')).toEqual(['fk_m', 'zzz_ibfk_1', 'zzz_ibfk_2']);
    expect(fkNames(okKeys(`ALTER TABLE child ${ADD_RID}, ADD FOREIGN KEY (rid) REFERENCES parent (id), RENAME TO zzz;`), 'zzz')).toEqual(['zzz_ibfk_1', 'zzz_ibfk_2', 'zzz_ibfk_3']);
    expect(fkNames(okKeys(`${named}ALTER TABLE child RENAME TO bbb;`), 'bbb')).toEqual(['bbb_ibfk_1', 'bbb_ibfk_2', 'fk_m']);
  });

  it('FK 를 더하거나 이름을 바꾸지 않는 문장은 순서를 건드리지 않는다', () => {
    const r = okKeys("ALTER TABLE child COMMENT = 'x';");
    expect(fkNames(r)).toEqual(['child_ibfk_1', 'child_ibfk_2']);
  });
});

// MySQL 8.0.46·8.4.11 실측: 컬럼을 더하거나 FIRST·AFTER 를 준 MODIFY·CHANGE 는 절 순서대로 하나씩 목록에 들어간다.
// AFTER 는 그때까지 목록에 든 컬럼(바뀐 컬럼은 새 이름)만 보므로, 뒤 절에서 더하거나 옮기는 컬럼을 앞서 가리키면 1054
describe('ALTER TABLE — 컬럼 위치(FIRST·AFTER)는 절 순서대로', () => {
  const POS_BASE = parseSqlDump(tdExport(
    'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `a` int DEFAULT NULL,\n  `b` int DEFAULT NULL,\n  `c` int DEFAULT NULL,\n  `d` int DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  )).model;
  const order = (script: string) => {
    const r = applyScript(POS_BASE, script, { schemaName: 'shop' });
    if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
    return tbl(r, 't').columns.map((c) => c.name).join(' ');
  };

  it.each([
    ['ALTER TABLE t ADD x INT AFTER b, MODIFY a INT AFTER x;', 'id b x a c d'], // 앞 절이 더한 컬럼은 뒤 절의 AFTER 가 본다
    ['ALTER TABLE t MODIFY a INT AFTER c, MODIFY b INT AFTER a;', 'id c a b d'],
    ['ALTER TABLE t MODIFY b INT AFTER a, MODIFY a INT AFTER c;', 'id b c a d'], // 옮기기 전 위치의 a 를 b 가 본다
    ['ALTER TABLE t ADD x INT, ADD y INT AFTER x;', 'id a b c d x y'],
    ['ALTER TABLE t ADD x INT FIRST, ADD y INT FIRST;', 'y x id a b c d'],
    ['ALTER TABLE t MODIFY c INT FIRST, MODIFY d INT FIRST;', 'd c id a b'],
    ['ALTER TABLE t CHANGE b b2 INT, MODIFY a INT AFTER b2;', 'id b2 a c d'], // 위치 없는 CHANGE 는 제자리에서 새 이름이 된다
    ['ALTER TABLE t CHANGE b b2 INT AFTER d, ADD y INT AFTER b2;', 'id a c d b2 y'],
    ['ALTER TABLE t ADD y INT AFTER b2, CHANGE b b2 INT AFTER d;', 'id a y c d b2'], // 옮기기 전 자리의 b2 를 y 가 본다
    ['ALTER TABLE t MODIFY a INT AFTER d, ADD x INT;', 'id b c d a x'],
    ['ALTER TABLE t ADD x INT, MODIFY a INT AFTER x;', 'id b c d x a'],
    ['ALTER TABLE t RENAME COLUMN a TO a2, ADD y INT AFTER a2;', 'id a2 y b c d'],
    ['ALTER TABLE t MODIFY b INT FIRST, ADD x INT AFTER b;', 'b x id a c d'],
    ['ALTER TABLE t ADD x INT AFTER b, MODIFY b INT FIRST;', 'b id a x c d'],
    ['ALTER TABLE t MODIFY d INT AFTER a, MODIFY c INT AFTER a;', 'id a c d b'],
    ['ALTER TABLE t ADD (x INT, y INT), MODIFY a INT AFTER y;', 'id b c d x y a'],
    ['ALTER TABLE t MODIFY a BIGINT, MODIFY b INT AFTER a;', 'id a b c d'],
    ['ALTER TABLE t MODIFY a INT FIRST, MODIFY b INT AFTER a;', 'a b id c d'],
    ['ALTER TABLE t MODIFY b INT AFTER a, MODIFY a INT FIRST;', 'a id b c d'],
  ])('%s → %s', (script, expected) => {
    expect(order(script)).toBe(expected);
  });

  it.each([
    ['ALTER TABLE t MODIFY a INT AFTER x, ADD x INT AFTER b;'], // 뒤 절이 더하는 컬럼
    ['ALTER TABLE t ADD y INT AFTER x, ADD x INT;'],
    ['ALTER TABLE t MODIFY a INT AFTER a;'], // 자기 자신
    ['ALTER TABLE t CHANGE b b2 INT, MODIFY a INT AFTER b;'], // 옛 이름
    ['ALTER TABLE t RENAME COLUMN a TO a2, ADD y INT AFTER a;'],
    ['ALTER TABLE t DROP COLUMN b, ADD y INT AFTER b;'], // 지운 컬럼
    ['ALTER TABLE t ADD y INT AFTER nope;'],
  ])('AFTER 가 아직 목록에 없는 컬럼을 가리키면 1054: %s', (script) => {
    expect(applyScript(POS_BASE, script, { schemaName: 'shop' })).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1054') } });
  });
});

// MySQL 8.0.46·8.4.11 실측: 같은 컬럼을 두 번 지우면 1091, 같은 문장의 두 번째 참조(MODIFY·ALTER COLUMN·RENAME COLUMN 의 어떤 짝이든)는 1054
describe('ALTER TABLE — 컬럼 중복 절', () => {
  it.each([
    ['ALTER TABLE member DROP COLUMN age, DROP COLUMN age;', '1091'],
    ['ALTER TABLE member DROP COLUMN age, DROP COLUMN AGE;', '1091'],
    ['ALTER TABLE member MODIFY age INT, ALTER COLUMN age SET DEFAULT 1;', '1054'],
    ['ALTER TABLE member MODIFY age INT, MODIFY age BIGINT;', '1054'],
    ['ALTER TABLE member ALTER COLUMN age SET DEFAULT 1, ALTER COLUMN age DROP DEFAULT;', '1054'],
    ['ALTER TABLE member ALTER COLUMN age SET INVISIBLE, ALTER COLUMN age SET DEFAULT 1;', '1054'],
    ['ALTER TABLE member MODIFY age INT, RENAME COLUMN age TO a2;', '1054'],
    ['ALTER TABLE member RENAME COLUMN age TO a2, RENAME COLUMN a2 TO a3;', '1054'], // a2 는 이 문장 앞에는 없는 이름
    ['ALTER TABLE member DROP COLUMN age, MODIFY age INT;', '1054'],
  ])('%s → %s', (script, errno) => {
    expect(apply(script)).toMatchObject({ ok: false, error: { reason: expect.stringContaining(`(MySQL ${errno})`) } });
  });
});

// InnoDB 테이블만 지원한다 (사용자 결정): ENGINE 을 InnoDB 가 아닌 것으로 바꾸는 절은 FK 가 있든 없든 거부하고 (RE_EXPORT 안내),
// InnoDB 가 아닌 엔진의 기존 테이블에는 ALTER TABLE·CREATE INDEX·DROP INDEX 를 쓸 수 없다. DROP TABLE·RENAME TABLE 은 된다 (table-stmt.test.ts)
describe('ALTER TABLE — InnoDB 테이블만 지원', () => {
  const engineOf = (r: { model: SchemaModel }, table: string) => tbl(r, table).options.find((o) => o.key === 'ENGINE')!.value;
  const rejectsInnodbOnly = (base: SchemaModel, script: string) => {
    const r = applyScript(base, script, { schemaName: 'shop' });
    expect(r, script).toMatchObject({ ok: false, error: { reason: expect.stringContaining('InnoDB 테이블만 지원합니다') } });
    if (!r.ok) expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
  };

  it.each([
    ['ALTER TABLE doc ENGINE=MyISAM;'], // FK 가 없어도
    ['ALTER TABLE doc ENGINE=myisam;'],
    ['ALTER TABLE child ENGINE=MyISAM;'], // 자기 FK
    ['ALTER TABLE parent ENGINE=MyISAM;'], // 다른 테이블 FK 가 참조
    ['ALTER TABLE child ENGINE=MEMORY;'],
    ['ALTER TABLE child DROP FOREIGN KEY child_ibfk_1, DROP FOREIGN KEY child_ibfk_2, ENGINE=MyISAM;'], // 같은 문장에서 FK 를 지워도
    ['SET FOREIGN_KEY_CHECKS = 0; ALTER TABLE parent ENGINE=MyISAM;'],
    ['SET FOREIGN_KEY_CHECKS = 0; ALTER TABLE child ENGINE=CSV;'],
    ['ALTER TABLE doc ADD COLUMN pid int, ADD FOREIGN KEY (pid) REFERENCES doc (id);\nALTER TABLE doc ENGINE=MyISAM;'], // 자기 참조 FK
    ['ALTER TABLE doc ENGINE=ARCHIVE;'],
    ['ALTER TABLE doc ENGINE=BLACKHOLE;'],
    ['ALTER TABLE doc ENGINE=NoSuchEngine;'], // 모르는 이름도 같은 안내
    ['ALTER TABLE doc ENGINE = MyISAM, COMMENT = \'x\';'],
  ])('ENGINE 을 InnoDB 가 아닌 것으로 바꾸면 RE_EXPORT 로 거부: %s', (script) => {
    rejectsInnodbOnly(KEYS_BASE, script);
  });

  it('ENGINE=InnoDB 는 그대로 받는다 (바뀌는 것이 없다), 이름은 MySQL 표기', () => {
    expect(engineOf(okKeys('ALTER TABLE child ENGINE=InnoDB;'), 'child')).toBe('InnoDB');
    expect(engineOf(okKeys('ALTER TABLE parent ENGINE=innodb;'), 'parent')).toBe('InnoDB');
    expect(okKeys('ALTER TABLE doc ENGINE=InnoDB;').model).toEqual(KEYS_BASE);
  });

  // InnoDB 가 아닌 엔진의 기존 테이블 (기준 덤프에 있다)
  const MYISAM_BASE = parseSqlDump(tdExport([
    'CREATE TABLE `legacy` (\n  `id` int NOT NULL,\n  `name` varchar(20) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix_name` (`name`)\n) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
    'CREATE TABLE `modern` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  ].join('\n\n'))).model;

  it.each([
    ['ALTER TABLE legacy ADD COLUMN x INT;'],
    ['ALTER TABLE legacy COMMENT = \'x\';'],
    ['ALTER TABLE legacy RENAME TO legacy2;'],
    ['ALTER TABLE legacy ENGINE=InnoDB;'], // InnoDB 로 바꾸는 절도 (기준 테이블이 InnoDB 가 아니다)
    ['CREATE INDEX ix_id ON legacy (id);'],
    ['CREATE UNIQUE INDEX uq_name ON legacy (name);'],
    ['DROP INDEX ix_name ON legacy;'],
  ])('InnoDB 가 아닌 엔진의 기존 테이블에는 RE_EXPORT 로 거부: %s', (script) => {
    rejectsInnodbOnly(MYISAM_BASE, script);
  });

  it('InnoDB 테이블은 같은 스크립트 안에 InnoDB 가 아닌 테이블이 있어도 바꾼다', () => {
    const r = applyScript(MYISAM_BASE, 'ALTER TABLE modern ADD COLUMN x INT;', { schemaName: 'shop' });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(tbl(r, 'modern').columns.map((c) => c.name)).toEqual(['id', 'x']);
  });

  it('없는 테이블은 엔진보다 먼저 1146 이다', () => {
    expect(applyScript(MYISAM_BASE, 'ALTER TABLE nope ADD COLUMN x INT;', { schemaName: 'shop' })).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1146') } });
  });
});

// MySQL 8.0.46·8.4.11 실측: 같은 문장에서 컬럼을 지우고 같은 이름으로 다시 더하면 그 컬럼을 쓰던 키 파트가 새 컬럼에 남는다 (컬럼은 목록 끝으로 간다).
// 같은 타입이면 키는 그대로이고, 타입이 다르면 MySQL 이 옛 키 파트의 바이트 길이를 prefix 로 넘겨 결과가 갈린다 (모델에서 재현하지 않고 거부한다)
describe('ALTER TABLE — 컬럼을 지우고 같은 이름으로 다시 더하기', () => {
  const RE_BASE = parseSqlDump(tdExport([
    'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `name` varchar(50) DEFAULT NULL,\n  `age` int DEFAULT NULL,\n  `title` varchar(20) DEFAULT NULL,\n  `code` varchar(10) NOT NULL,\n  `v` varchar(20) DEFAULT NULL,\n  `note` text,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_age` (`age`),\n  KEY `name_age` (`name`,`age`),\n  KEY `ix_title` (`title`(10)),\n  KEY `ix_code` (`code`),\n  FULLTEXT KEY `ft` (`v`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  ].join('\n\n'))).model;
  const runRe = (script: string) => applyScript(RE_BASE, script, { schemaName: 'shop' });
  const okRe = (script: string) => {
    const r = runRe(script);
    if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
    return r;
  };
  const keyOf = (r: { model: SchemaModel }, name: string) => tbl(r, 't').indexes.find((i) => i.name === name);
  const names = (r: { model: SchemaModel }) => tbl(r, 't').columns.map((c) => c.name).join(' ');

  it('같은 타입으로 다시 더하면 키 파트가 따라온다: 컬럼은 끝으로 가고 UNIQUE·복합 키·PRIMARY KEY 가 그대로다', () => {
    const r = okRe('ALTER TABLE t DROP COLUMN age, ADD age INT;');
    expect(names(r)).toBe('id name title code v note age');
    expect(keyOf(r, 'uq_age')).toMatchObject({ kind: 'UNIQUE', parts: [{ column: 'age' }] });
    expect(keyOf(r, 'name_age')!.parts.map((p) => p.column)).toEqual(['name', 'age']);
    const reversed = okRe('ALTER TABLE t ADD age INT, DROP COLUMN age;'); // 절 순서와 상관없다
    expect(names(reversed)).toBe('id name title code v note age');
    expect(keyOf(reversed, 'uq_age')).toBeDefined();
    const pk = okRe('ALTER TABLE t DROP COLUMN id, ADD id INT;');
    expect(names(pk)).toBe('name age title code v note id');
    expect(col(pk, 't', 'id')).toMatchObject({ nullable: false });
    expect(tbl(pk, 't').indexes[0]).toMatchObject({ kind: 'PRIMARY', parts: [{ column: 'id' }] });
  });

  it('타입 모양이 같으면(정수 부호·문자셋·NULL 허용·위치는 상관없다) 받는다, prefix 도 그대로다', () => {
    expect(col(okRe('ALTER TABLE t DROP COLUMN age, ADD age INT UNSIGNED;'), 't', 'age').type).toBe('int unsigned');
    expect(names(okRe('ALTER TABLE t DROP COLUMN age, ADD age INT NOT NULL FIRST;'))).toBe('age id name title code v note');
    expect(keyOf(okRe('ALTER TABLE t DROP COLUMN title, ADD title varchar(20) CHARACTER SET latin1;'), 'ix_title')!.parts).toEqual([{ column: 'title', length: 10, desc: false }]);
    expect(keyOf(okRe('ALTER TABLE t DROP COLUMN v, ADD v varchar(30);'), 'ft')).toMatchObject({ kind: 'FULLTEXT' }); // FULLTEXT 는 길이와 상관없다
  });

  it('키를 같은 문장에서 지우면 그 키만 없어지고, 다른 컬럼 이름이 바뀌어 같은 이름이 된 경우는 따라오지 않는다', () => {
    const dropped = okRe('ALTER TABLE t DROP COLUMN age, ADD age INT, DROP INDEX name_age;');
    expect(keyOf(dropped, 'name_age')).toBeUndefined();
    expect(keyOf(dropped, 'uq_age')).toBeDefined();
    const renamedOnto = okRe('ALTER TABLE t DROP COLUMN age, CHANGE name age VARCHAR(50);'); // 지운 age 의 파트만 빠지고 name 의 파트는 이름을 따라간다
    expect(keyOf(renamedOnto, 'uq_age')).toBeUndefined();
    expect(keyOf(renamedOnto, 'name_age')!.parts.map((p) => p.column)).toEqual(['age']);
    const swapped = okRe('ALTER TABLE t DROP COLUMN name, RENAME COLUMN age TO name;');
    expect(keyOf(swapped, 'uq_age')!.parts.map((p) => p.column)).toEqual(['name']);
    expect(keyOf(swapped, 'name_age')!.parts.map((p) => p.column)).toEqual(['name']);
  });

  it('키에 든 컬럼을 다른 타입으로 다시 더하면 거부한다 (재추출 안내), 키에 없는 컬럼은 무엇으로든 다시 더한다', () => {
    for (const script of [
      'ALTER TABLE t DROP COLUMN age, ADD age VARCHAR(5);', // MySQL: KEY (age(4))
      'ALTER TABLE t DROP COLUMN age, ADD age SMALLINT;', // MySQL: 1089
      'ALTER TABLE t DROP COLUMN id, ADD id BIGINT;', // MySQL: 1089
      'ALTER TABLE t DROP COLUMN title, ADD title varchar(5);', // MySQL: 1089 (prefix 10)
      'ALTER TABLE t DROP COLUMN title, ADD title varchar(30);', // MySQL: KEY (title(10)) 유지 — 타입 문자열이 달라 거부
      'ALTER TABLE t DROP COLUMN code, ADD code text;', // MySQL: KEY (code(10))
      'ALTER TABLE t DROP COLUMN code, ADD code varchar(300);', // MySQL: KEY (code(10))
    ]) {
      expect(runRe(script), script).toMatchObject({ ok: false, error: { reason: expect.stringContaining(RE_EXPORT) } });
    }
    expect(col(okRe('ALTER TABLE t DROP COLUMN note, ADD note int;'), 't', 'note').type).toBe('int');
  });

  it('FULLTEXT 컬럼을 문자열이 아닌 타입으로 다시 더하면 1283, PRIMARY KEY 에 NULL 을 명시하면 1171, FK 컬럼이면 1828·1829', () => {
    expect(runRe('ALTER TABLE t DROP COLUMN v, ADD v int;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1283') } });
    expect(runRe('ALTER TABLE t DROP COLUMN id, ADD id INT NULL;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1171') } });
    expect(applyKeys('ALTER TABLE child DROP COLUMN pid, ADD pid int unsigned;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1828') } });
    expect(applyKeys('ALTER TABLE parent DROP COLUMN id, ADD id int unsigned;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1829') } });
  });
});
