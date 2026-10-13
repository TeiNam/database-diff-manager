import { describe, expect, it } from 'vitest';
import { applyScript } from '../../src/apply';
import { RE_EXPORT } from '../../src/apply/types';
import type { SchemaModel, Table } from '../../src/model';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

const BASE = parseSqlDump(tdExport([
  'CREATE TABLE `member` (\n  `id` int unsigned NOT NULL AUTO_INCREMENT,\n  `email` varchar(100) NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  'CREATE TABLE `orders` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `member_id` int unsigned NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `member_id` (`member_id`),\n  CONSTRAINT `orders_ibfk_1` FOREIGN KEY (`member_id`) REFERENCES `member` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
].join('\n\n'))).model;
const apply = (script: string, defaults?: { charset: string; collation: string }) => applyScript(BASE, script, { schemaName: 'shop', ...(defaults ? { defaults } : {}) });
const ok = (script: string, defaults?: { charset: string; collation: string }) => {
  const r = apply(script, defaults);
  if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
  return r;
};
const tbl = (r: { model: SchemaModel }, name: string): Table => r.model.tables.find((t) => t.name === name)!;

describe('CREATE TABLE', () => {
  it('사람이 쓴 정의를 SHOW CREATE 모양으로: 백틱 없는 이름·INT(11)·BOOL·컬럼 안 PRIMARY KEY·UNIQUE·REFERENCES 무시·스키마 기본 문자셋', () => {
    const r = ok("CREATE TABLE tag (\n  tag_id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  label VARCHAR(30) NOT NULL UNIQUE,\n  active BOOL NOT NULL DEFAULT TRUE,\n  member_id INT UNSIGNED REFERENCES member (id),\n  note TEXT\n) COMMENT='태그';", { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' });
    const t = tbl(r, 'tag');
    expect(t.columns.map((c) => `${c.name} ${c.type}`)).toEqual(['tag_id int', 'label varchar(30)', 'active tinyint(1)', 'member_id int unsigned', 'note text']);
    expect(t.columns.find((c) => c.name === 'label')!.collation).toBe('utf8mb4_general_ci');
    expect(t.indexes.map((i) => `${i.kind} ${i.name}`)).toEqual(['PRIMARY PRIMARY', 'UNIQUE label']);
    expect(t.foreignKeys).toEqual([]); // 컬럼 안 REFERENCES 는 MySQL 이 무시한다
    expect(t.options).toEqual([{ key: 'ENGINE', value: 'InnoDB' }, { key: 'DEFAULT CHARSET', value: 'utf8mb4' }, { key: 'COLLATE', value: 'utf8mb4_general_ci' }, { key: 'COMMENT', value: "'태그'" }]);
  });

  it('표 수준 FK·자기 참조 FK 와 자동 인덱스, 문자셋만 쓴 옵션은 그 문자셋 기본 콜레이션', () => {
    const r = ok('CREATE TABLE coupon (id INT UNSIGNED NOT NULL AUTO_INCREMENT, member_id INT UNSIGNED, parent_id INT UNSIGNED, PRIMARY KEY (id), CONSTRAINT fk_cm FOREIGN KEY (member_id) REFERENCES member (id), FOREIGN KEY (parent_id) REFERENCES coupon (id)) ENGINE=InnoDB DEFAULT CHARSET=latin1;');
    const t = tbl(r, 'coupon');
    expect(t.foreignKeys.map((f) => f.name)).toEqual(['coupon_ibfk_1', 'fk_cm']); // SHOW CREATE 는 FK 를 이름(소문자) 순으로 찍는다
    expect(t.indexes.map((i) => i.name)).toEqual(['PRIMARY', 'fk_cm', 'parent_id']);
    expect(t.options.find((o) => o.key === 'COLLATE')!.value).toBe('latin1_swedish_ci');
  });

  it('PRIMARY KEY 컬럼: 직접 쓴 NULL 은 1171 (컬럼 안 DEFAULT NULL PRIMARY KEY 만 1067), 안 쓰면 NOT NULL 이고 DEFAULT NULL 이 없다', () => {
    expect(apply('CREATE TABLE n1 (c INT NULL, PRIMARY KEY (c));')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1171') } });
    expect(apply('CREATE TABLE n2 (c INT DEFAULT NULL, PRIMARY KEY (c));')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1171') } });
    expect(apply('CREATE TABLE n3 (c INT NULL PRIMARY KEY);')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1171') } });
    expect(apply('CREATE TABLE n4 (c INT DEFAULT NULL PRIMARY KEY);')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1067') } });
    const c = tbl(ok('CREATE TABLE n5 (c INT, PRIMARY KEY (c));'), 'n5').columns[0];
    expect(c).toMatchObject({ name: 'c', type: 'int', nullable: false });
    expect(c.default).toBeUndefined();
  });

  it('이름 없는 FK 번호는 1 부터, 직접 쓴 같은 이름과 겹치면 1826', () => {
    const r = ok('CREATE TABLE f0 (a INT UNSIGNED, b INT UNSIGNED, FOREIGN KEY (a) REFERENCES member (id), CONSTRAINT f0_ibfk_7 FOREIGN KEY (b) REFERENCES member (id));');
    expect(tbl(r, 'f0').foreignKeys.map((f) => f.name)).toEqual(['f0_ibfk_1', 'f0_ibfk_7']);
    expect(apply('CREATE TABLE f1 (a INT UNSIGNED, b INT UNSIGNED, FOREIGN KEY (a) REFERENCES member (id), CONSTRAINT f1_ibfk_1 FOREIGN KEY (b) REFERENCES member (id));')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1826') } });
  });

  it('IF NOT EXISTS 는 있는 테이블을 그대로 두고, 없는 IF NOT EXISTS·LIKE·파티션·중복은 거부', () => {
    expect(tbl(ok('CREATE TABLE IF NOT EXISTS member (x INT);'), 'member').columns.map((c) => c.name)).toEqual(['id', 'email']);
    expect(apply('CREATE TABLE member (x INT);')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1050') } });
    expect(apply('CREATE TABLE copy LIKE member;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('LIKE') } });
    expect(apply('CREATE TABLE p (id INT) PARTITION BY HASH (id) PARTITIONS 2;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('파티션') } });
    expect(apply('CREATE TABLE d (a INT, A INT);')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1060') } });
    expect(apply('CREATE TABLE e (a INT,);')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('쉼표') } });
  });
});

describe('DROP·RENAME TABLE', () => {
  it('FK 가 참조하는 테이블은 FOREIGN_KEY_CHECKS=1 이면 지울 수 없고, 함께 지우거나 0 이면 지운다', () => {
    expect(apply('DROP TABLE member;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('3730') } });
    expect(ok('DROP TABLE orders, member;').model.tables).toEqual([]);
    expect(ok('SET FOREIGN_KEY_CHECKS = 0; DROP TABLE member;').model.tables.map((t) => t.name)).toEqual(['orders']);
    expect(ok('DROP TABLE IF EXISTS nope, orders;').model.tables.map((t) => t.name)).toEqual(['member']);
    expect(apply('DROP TABLE nope;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1051') } });
  });

  it('RENAME TABLE 맞바꾸기: FK 참조·자동 FK 이름이 따라가고 rename 매핑이 남는다', () => {
    const r = ok('RENAME TABLE member TO tmp, orders TO member, tmp TO orders;');
    expect(tbl(r, 'member').foreignKeys[0]).toMatchObject({ name: 'member_ibfk_1', refTable: 'orders' });
    expect(r.renames).toEqual(expect.arrayContaining([{ kind: 'table', from: 'member', to: 'orders' }, { kind: 'table', from: 'orders', to: 'member' }]));
    expect(apply('RENAME TABLE member TO orders;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1050') } });
  });
});

// ── 아래는 브리프 테스트 뒤에 덧붙인 Task 6 규칙 (MySQL 8.0.46·8.4.11 실측은 각 describe 머리에 적는다) ──
const reasonOf = (script: string, base: SchemaModel = BASE): string => {
  const r = applyScript(base, script, { schemaName: 'shop' });
  if (r.ok) throw new Error(`적용되어 버렸다: ${script}`);
  return r.error.reason;
};
const endsWithReExport = (reason: string): boolean => reason.endsWith(RE_EXPORT);

// MySQL 8.0.46·8.4.11 실측: FK 이름은 스키마 안에서 유일하고 대소문자를 구분하지 않는다. 다른 테이블의 FK 와 겹치면 1826 —
// CREATE TABLE (직접 쓴 이름·자동 이름 '<테이블>_ibfk_N')과 RENAME TABLE·ALTER TABLE … RENAME TO (바뀐 자동 이름) 모두
describe('FK 이름은 스키마 안에서 유일하다 (1826)', () => {
  const has1826 = (script: string) => expect(reasonOf(script)).toContain('(MySQL 1826)');
  const CHILD = (name: string) => `CREATE TABLE c (y INT UNSIGNED, CONSTRAINT ${name} FOREIGN KEY (y) REFERENCES member (id));\n`;

  it('CREATE TABLE: 다른 테이블이 쓰는 이름은 직접 쓴 이름이든 자동 이름이든 (대소문자 무시) 거부', () => {
    has1826('CREATE TABLE d (z INT UNSIGNED, CONSTRAINT orders_ibfk_1 FOREIGN KEY (z) REFERENCES member (id));'); // 기준 테이블 orders 의 FK
    has1826('CREATE TABLE d (z INT UNSIGNED, CONSTRAINT ORDERS_IBFK_1 FOREIGN KEY (z) REFERENCES member (id));');
    has1826(`${CHILD('x_ibfk_1')}CREATE TABLE x (z INT UNSIGNED, FOREIGN KEY (z) REFERENCES member (id));`); // 이름 없는 FK 의 자동 이름 x_ibfk_1
    has1826(`${CHILD('X_IBFK_1')}CREATE TABLE x (z INT UNSIGNED, FOREIGN KEY (z) REFERENCES member (id));`);
    has1826(`${CHILD('x_ibfk_2')}CREATE TABLE x (z INT UNSIGNED, w INT UNSIGNED, FOREIGN KEY (z) REFERENCES member (id), FOREIGN KEY (w) REFERENCES member (id));`); // 두 번째 자동 이름
  });

  it('CREATE TABLE: 겹치지 않으면 받는다 (다른 번호·다른 이름)', () => {
    const r = ok(`${CHILD('x_ibfk_9')}CREATE TABLE x (z INT UNSIGNED, FOREIGN KEY (z) REFERENCES member (id));`);
    expect(tbl(r, 'x').foreignKeys.map((f) => f.name)).toEqual(['x_ibfk_1']);
  });

  it('RENAME TABLE: 바뀐 자동 이름이 다른 테이블의 FK 이름과 겹치면 거부 (대소문자 무시)', () => {
    has1826(`${CHILD('zzz_ibfk_1')}RENAME TABLE orders TO zzz;`);
    has1826(`${CHILD('ZZZ_IBFK_1')}RENAME TABLE orders TO zzz;`);
    has1826(`${CHILD('zzz_ibfk_1')}ALTER TABLE orders RENAME TO zzz;`);
    has1826(`${CHILD('zzz_ibfk_1')}ALTER TABLE orders RENAME AS zzz;`);
  });

  it('RENAME TABLE: 같은 테이블의 다른 FK 이름과도 대소문자 없이 비교한다', () => {
    const setup = 'ALTER TABLE orders ADD COLUMN m2 INT UNSIGNED, ADD CONSTRAINT ZZZ_IBFK_1 FOREIGN KEY (m2) REFERENCES member (id);\n';
    has1826(`${setup}RENAME TABLE orders TO zzz;`);
    has1826(`${setup}ALTER TABLE orders RENAME TO zzz;`);
  });

  it('RENAME TABLE: 겹치지 않으면 받고, 맞바꾸기처럼 이름이 비는 순서면 받는다', () => {
    const r = ok(`${CHILD('zzz_ibfk_9')}RENAME TABLE orders TO zzz;`);
    expect(tbl(r, 'zzz').foreignKeys.map((f) => f.name)).toEqual(['zzz_ibfk_1']);
    const swap = ok('CREATE TABLE a (y INT UNSIGNED, FOREIGN KEY (y) REFERENCES member (id));\nRENAME TABLE a TO tmp, orders TO a, tmp TO orders;');
    expect(tbl(swap, 'a').foreignKeys.map((f) => f.name)).toEqual(['a_ibfk_1']);
    expect(tbl(swap, 'orders').foreignKeys.map((f) => f.name)).toEqual(['orders_ibfk_1']);
  });
});

// MySQL 8.0.46·8.4.11 실측: PRIMARY KEY 가 컬럼을 NOT NULL 로 만드는 것은 FK 를 붙인 뒤에 정해지지만 SET NULL FK 가 그 컬럼에 있으면 1830 이다 (FK·PRIMARY KEY 의 순서와 상관없다).
// 직접 쓴 NULL 이 PRIMARY KEY 에 들어가면 1171 이 먼저다. UNIQUE 는 컬럼을 NOT NULL 로 만들지 않으니 된다
describe('CREATE TABLE — PRIMARY KEY 컬럼의 SET NULL FK (1830)', () => {
  const has1830 = (script: string) => expect(reasonOf(script)).toContain('(MySQL 1830)');
  const PAR = 'CREATE TABLE pp (a INT, b INT, PRIMARY KEY (a, b));\n';

  it.each([
    ['CREATE TABLE d (pid INT UNSIGNED, PRIMARY KEY (pid), FOREIGN KEY (pid) REFERENCES member (id) ON DELETE SET NULL);'],
    ['CREATE TABLE d (pid INT UNSIGNED, FOREIGN KEY (pid) REFERENCES member (id) ON DELETE SET NULL, PRIMARY KEY (pid));'], // FK 가 먼저 — addForeignKey 는 아직 NULL 허용으로 본다
    ['CREATE TABLE d (pid INT UNSIGNED, FOREIGN KEY (pid) REFERENCES member (id) ON UPDATE SET NULL, PRIMARY KEY (pid));'],
    ['CREATE TABLE d (pid INT UNSIGNED PRIMARY KEY, FOREIGN KEY (pid) REFERENCES member (id) ON DELETE SET NULL);'],
    ['CREATE TABLE d (pid INT UNSIGNED, CONSTRAINT fk FOREIGN KEY (pid) REFERENCES member (id) ON DELETE CASCADE ON UPDATE SET NULL, PRIMARY KEY (pid));'],
    ['CREATE TABLE d (pid INT UNSIGNED NOT NULL, FOREIGN KEY (pid) REFERENCES member (id) ON DELETE SET NULL);'], // 직접 쓴 NOT NULL
    ['CREATE TABLE d (pid INT UNSIGNED AUTO_INCREMENT, KEY (pid), FOREIGN KEY (pid) REFERENCES member (id) ON DELETE SET NULL);'], // AUTO_INCREMENT 는 NOT NULL
    [`${PAR}CREATE TABLE d (a INT, b INT, FOREIGN KEY (a, b) REFERENCES pp (a, b) ON DELETE SET NULL, PRIMARY KEY (a));`], // 여러 컬럼 중 하나만 PRIMARY KEY
  ])('거부: %s', (script) => {
    has1830(script);
  });

  it('직접 쓴 NULL 이 PRIMARY KEY 에 들어가면 1171 이 먼저이고, UNIQUE·SET NULL 이 아닌 FK 는 받는다', () => {
    expect(reasonOf('CREATE TABLE d (pid INT UNSIGNED NULL, FOREIGN KEY (pid) REFERENCES member (id) ON DELETE SET NULL, PRIMARY KEY (pid));')).toContain('(MySQL 1171)');
    const uq = ok('CREATE TABLE d1 (pid INT UNSIGNED, UNIQUE (pid), FOREIGN KEY (pid) REFERENCES member (id) ON DELETE SET NULL);');
    expect(tbl(uq, 'd1').columns[0].nullable).toBe(true);
    expect(tbl(uq, 'd1').foreignKeys[0].onDelete).toBe('SET NULL');
    const cascade = ok('CREATE TABLE d2 (pid INT UNSIGNED, FOREIGN KEY (pid) REFERENCES member (id) ON DELETE CASCADE, PRIMARY KEY (pid));');
    expect(tbl(cascade, 'd2').columns[0]).toMatchObject({ nullable: false });
    const apart = ok(`${PAR}CREATE TABLE d3 (a INT, b INT, id0 INT, FOREIGN KEY (a, b) REFERENCES pp (a, b) ON DELETE SET NULL, PRIMARY KEY (id0));`); // PRIMARY KEY 가 FK 컬럼과 다르다
    expect(tbl(apart, 'd3').columns.map((c) => c.nullable)).toEqual([true, true, false]);
  });
});

// 식이 들어가는 정의(CHECK·생성 컬럼)는 MySQL 이 식을 다시 써서 저장하므로 모델에서 만들 수 없다 — 스펙 3.2. CREATE TABLE 도 RE_EXPORT 로 거부한다
describe('CREATE TABLE — CHECK·생성 컬럼은 범위 밖', () => {
  it.each([
    ['CREATE TABLE k1 (a INT CHECK (a > 0));'],
    ['CREATE TABLE k2 (a INT, CHECK (a > 0));'],
    ['CREATE TABLE k3 (a INT, CONSTRAINT chk_a CHECK (a > 0));'],
    ['CREATE TABLE k4 (a INT, CONSTRAINT CHECK (a > 0));'],
    ['CREATE TABLE k5 (a INT, b INT GENERATED ALWAYS AS (a + 1) VIRTUAL);'],
    ['CREATE TABLE k6 (a INT, b INT GENERATED ALWAYS AS (a + 1) STORED);'],
    ['CREATE TABLE k7 (a INT, b INT AS (a + 1));'],
    ['CREATE TABLE k8 (a INT, b INT NOT NULL AS (a + 1) STORED);'],
    ['CREATE TABLE k9 (a INT, b INT AS (a + 1) VIRTUAL COMMENT \'x\');'],
  ])('RE_EXPORT 로 끝나는 메시지로 거부: %s', (script) => {
    const reason = reasonOf(script);
    expect(endsWithReExport(reason), reason).toBe(true);
  });
});

describe('CREATE TABLE — 컬럼 없는 정의와 모르는 옵션', () => {
  it('컬럼 없이 키만 쓰면 1072 (MySQL 8.0.46·8.4.11 실측), 빈 괄호는 문법 오류', () => {
    expect(reasonOf('CREATE TABLE t (PRIMARY KEY (a));')).toContain('(MySQL 1072)');
    expect(reasonOf('CREATE TABLE t (KEY (a));')).toContain('(MySQL 1072)');
    expect(reasonOf('CREATE TABLE t ();')).toContain('(MySQL 1064)');
  });

  it.each([
    ['CREATE TABLE t (a INT) STATS_PERSISTENT=1;'],
    ['CREATE TABLE t (a INT) SELECT 1 AS b;'],
    ['CREATE TABLE t (a INT) AS SELECT 1 AS b;'],
  ])('모델에 없는 옵션·SELECT 는 RE_EXPORT 로 거부: %s', (script) => {
    const reason = reasonOf(script);
    expect(endsWithReExport(reason), reason).toBe(true);
  });
});

describe('CREATE TABLE — 기본 문자셋 binary 는 범위 밖', () => {
  it.each([
    ['CREATE TABLE b1 (a VARCHAR(10)) CHARSET=binary;'],
    ['CREATE TABLE b2 (a INT) DEFAULT CHARACTER SET binary;'],
    ['CREATE TABLE b3 (a TEXT) COLLATE=binary;'],
  ])('MySQL 이 문자열 컬럼을 BINARY 계열로 바꾸므로 RE_EXPORT 로 거부: %s', (script) => {
    const reason = reasonOf(script);
    expect(reason).toContain('binary');
    expect(endsWithReExport(reason), reason).toBe(true);
  });

  it('스키마 기본 문자셋이 binary 여도 문자셋 없이 쓴 CREATE TABLE 은 같다', () => {
    const r = applyScript(BASE, 'CREATE TABLE b4 (a INT);', { schemaName: 'shop', defaults: { charset: 'binary' } });
    expect(r).toMatchObject({ ok: false, error: { reason: expect.stringContaining(RE_EXPORT) } });
  });
});

// 계약 (Task 5 재검토): addKeys 는 st.origins.provenance 에 인덱스 출처를 적으므로 모델에 들어가는 테이블에만 부르고,
// moveOrigins 는 from 항목이 없는 표를 건너뛰므로 DROP TABLE 이 forgetOrigins 로 옛 항목을 지워야 같은 이름을 다시 쓸 때 낡은 출처가 남지 않는다
describe('인덱스 출처(provenance) 계약', () => {
  // ref: FK 가 없는 기준 테이블 — 직접 만든 KEY pid 가 있다 (출처 표에 항목이 없다)
  const PROV = parseSqlDump(tdExport([
    'CREATE TABLE `member` (\n  `id` int unsigned NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
    'CREATE TABLE `ref` (\n  `id` int NOT NULL,\n  `pid` int unsigned DEFAULT NULL,\n  `x` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `pid` (`pid`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
    'CREATE TABLE `orders` (\n  `id` int NOT NULL,\n  `member_id` int unsigned NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `member_id` (`member_id`),\n  CONSTRAINT `orders_ibfk_1` FOREIGN KEY (`member_id`) REFERENCES `member` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  ].join('\n\n'))).model;
  const indexNames = (script: string, table: string): string[] => {
    const r = applyScript(PROV, script, { schemaName: 'shop' });
    if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
    return r.model.tables.find((t) => t.name === table)!.indexes.map((i) => i.name);
  };

  it('이미 있는 테이블의 CREATE TABLE IF NOT EXISTS 는 출처를 적지 않는다: 알 수 없는 인덱스는 이어서 알 수 없다', () => {
    // orders.member_id 는 덤프만으로 FK 의 자동 인덱스인지 알 수 없다 (FK 이름 orders_ibfk_1 + 첫 컬럼 이름 인덱스). 이 인덱스를 버리게 되는 문장은 거부된다
    const alter = 'ALTER TABLE orders DROP FOREIGN KEY orders_ibfk_1, ADD INDEX k (member_id, id);';
    const control = reasonOf(alter, PROV);
    expect(control).toContain('member_id');
    expect(endsWithReExport(control)).toBe(true);
    // 아무것도 안 하는 문장이 member_id 를 "직접 만든 인덱스"로 적어 두면 위 문장이 받아들여진다
    expect(reasonOf(`CREATE TABLE IF NOT EXISTS orders (id INT, member_id INT UNSIGNED, KEY member_id (member_id));\n${alter}`, PROV)).toBe(control);
  });

  it('DROP TABLE 뒤 같은 이름을 다시 만들면 새 테이블의 출처가 따른다 (옛 출처가 아니다)', () => {
    // 옛 t: FK 의 자동 인덱스 a. 새 t: 직접 만든 KEY a 가 FK 를 받친다 → a 는 직접 만든 것이라 새 키 k (a, b) 가 있어도 남는다
    const user = 'CREATE TABLE t (a INT UNSIGNED, b INT, KEY a (a), FOREIGN KEY (a) REFERENCES member (id));';
    expect(indexNames(`CREATE TABLE t (a INT UNSIGNED, b INT, FOREIGN KEY (a) REFERENCES member (id));\nDROP TABLE t;\n${user}\nALTER TABLE t ADD INDEX k (a, b);`, 't')).toEqual(['a', 'k']);
    // 반대: 옛 t 의 직접 만든 KEY a, 새 t 의 이름 없는 FK 가 만든 자동 인덱스 a → 새 키 k (a, b) 가 대신한다
    const auto = 'CREATE TABLE t (a INT UNSIGNED, b INT, FOREIGN KEY (a) REFERENCES member (id));';
    expect(indexNames(`CREATE TABLE t (a INT UNSIGNED, b INT, KEY a (a));\nDROP TABLE t;\n${auto}\nALTER TABLE t ADD INDEX k (a, b);`, 't')).toEqual(['k']);
  });

  it('지운 테이블의 출처는 그 이름으로 옮겨 온 다른 테이블에 남지 않는다 (RENAME TABLE 은 from 항목이 없으면 건너뛴다)', () => {
    // t: FK 의 자동 인덱스 pid (출처 auto) → DROP → 출처 표에 항목이 없는 기준 테이블 ref 를 t 로 바꾼다. ref 의 KEY pid 는 직접 만든 것이다
    const script = 'CREATE TABLE t (pid INT UNSIGNED, x INT, FOREIGN KEY (pid) REFERENCES member (id));\nDROP TABLE t;\nRENAME TABLE ref TO t;\nALTER TABLE t ADD INDEX k (pid, x);';
    expect(indexNames(script, 't')).toEqual(['PRIMARY', 'pid', 'k']);
  });
});
