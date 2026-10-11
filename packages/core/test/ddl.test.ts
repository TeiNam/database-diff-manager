import { describe, expect, it } from 'vitest';
import { isLosslessConversion } from '../src/charset-ddl';
import { keyLimit, oversizedIndexes } from '../src/convert-keys';
import { generateDdl, objectStatements, renderDdl } from '../src/ddl';
import { diffSchemas } from '../src/diff';
import { parseSqlDump } from '../src/parse-dump';
import { parseMdDump } from '../src/parse-md';
import { fixture, MD_SCENARIOS, mdScenario, sample, scenario, SCENARIOS } from './helpers';

describe.each(SCENARIOS)('골든: %s', (name) => {
  it('expected.sql과 같은 DDL을 생성한다', () => {
    const { base, target, renames } = scenario(name);
    const d = diffSchemas(base, target, renames);
    expect(renderDdl(generateDdl(d), d.partial)).toBe(fixture(`scenarios/${name}/expected.sql`));
  });
});

describe.each(MD_SCENARIOS)('골든(MD TARGET): %s', (name) => {
  it('expected.sql과 같은 DDL을 생성한다', () => {
    const { base, target } = mdScenario(name);
    const d = diffSchemas(base, target);
    expect(renderDdl(generateDdl(d), d.partial)).toBe(fixture(`scenarios-md/${name}/expected.sql`));
  });
});

const MD_HEAD = '# s\n\n## Table List\n- [t ()](#t)\n\n## t\n**Information**\n|Table type|Engine|Row format|Collate|Comment|\n|---|---|---|---|---|\n' +
  '|BASE TABLE|InnoDB|Dynamic|utf8mb4_0900_ai_ci||\n\n**Columns**\n|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|\n|---|---|---|---|---|---|---|---|---|\n';
const mdTable = (rows: string) => parseMdDump(MD_HEAD + rows).model;
const sqlTable = (cols: string) =>
  parseSqlDump(`CREATE TABLE \`t\` (\n${cols}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`).model;

describe('generateDdl: partial(MD) TARGET', () => {
  it('변경 컬럼의 알 수 없는 속성(문자셋·기본값)을 BASE 값으로 채운다', () => {
    const base = sqlTable("  `a` varchar(10) CHARACTER SET latin1 NOT NULL DEFAULT ''");
    const [s] = generateDdl(diffSchemas(base, mdTable('|a|varchar(20)|NO||latin1|latin1_swedish_ci||||\n')));
    expect(s).toMatchObject({ comment: false, sql: "ALTER TABLE `t`\n  MODIFY COLUMN `a` varchar(20) CHARACTER SET latin1 NOT NULL DEFAULT ''" });
    expect(s.notes).toBeUndefined();
  });

  it('BASE 생성 컬럼의 표현식으로 채운다', () => {
    const base = sqlTable('  `a` int NOT NULL,\n  `b` int GENERATED ALWAYS AS ((`a` + 1)) STORED');
    const [s] = generateDdl(diffSchemas(base, mdTable('|a|int|NO|||||||\n|b|bigint|YES|||||STORED GENERATED||\n')));
    expect(s.sql).toContain('MODIFY COLUMN `b` bigint GENERATED ALWAYS AS ((`a` + 1)) STORED');
  });

  it('채울 수 없는 생성 컬럼은 주석 처리한 수동 확인 문장, 미확인 속성은 notes', () => {
    const base = sqlTable('  `a` int NOT NULL');
    const stmts = generateDdl(diffSchemas(base, mdTable('|a|int|NO|||||||\n|v|int|YES|||||VIRTUAL GENERATED||\n|n|varchar(5)|YES||||||\n')));
    expect(stmts).toHaveLength(1);
    const [s] = stmts;
    expect(s.comment).toBe(true);
    expect(s.sql.split('\n').every((l) => l.startsWith('--'))).toBe(true);
    expect(s.sql).toContain('GENERATED ALWAYS AS (/* 표현식 미상 */) VIRTUAL');
    expect(s.notes).toEqual(['[MD 기반 미확인] 컬럼 `n`: charset, collation, default']);
    expect(renderDdl([s])).toMatch(/^-- \[~\] TABLE t\n-- \[MD 기반 미확인\] 컬럼 `n`: charset, collation, default\n-- \[수동 확인 필요\]/);
    expect(renderDdl([s]).endsWith(';\n')).toBe(false);
  });
});

const charsetTable = (cols: string, opts: string) => parseSqlDump(`CREATE TABLE \`t\` (\n${cols}\n) ENGINE=InnoDB ${opts};`).model;
const UTF8MB3 = 'DEFAULT CHARSET=utf8mb3';
const UTF8MB4 = 'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci';

describe('generateDdl: 테이블 문자셋 변경', () => {
  it('손실 없는 변환 판정', () => {
    expect(['latin1', 'ascii', 'utf8mb3', 'utf8mb4'].map((c) => isLosslessConversion(c, 'utf8mb4'))).toEqual([true, true, true, true]);
    expect(isLosslessConversion('ascii', 'latin1')).toBe(true);
    expect(isLosslessConversion('utf8mb4', 'latin1')).toBe(false);
    expect(isLosslessConversion('utf8mb4', 'utf8mb3')).toBe(false);
    expect(isLosslessConversion('latin1', 'utf8mb3')).toBe(false);
    expect(isLosslessConversion(undefined, 'utf8mb4')).toBe(false);
  });

  it('모든 컬럼이 상속하고 넓어지는 변환이면 CONVERT TO', () => {
    const cols = "  `a` varchar(10) NOT NULL DEFAULT ''";
    const stmts = generateDdl(diffSchemas(charsetTable(cols, UTF8MB3), charsetTable(cols, UTF8MB4)));
    expect(stmts.map((s) => s.sql)).toEqual(['ALTER TABLE `t` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci']);
  });

  it('좁아지는 변환은 CONVERT 대신 옵션 변경과 MODIFY, 데이터 확인 안내', () => {
    const cols = "  `a` varchar(10) NOT NULL DEFAULT '',\n  `n` int NOT NULL";
    const [s, ...rest] = generateDdl(diffSchemas(charsetTable(cols, UTF8MB4), charsetTable(cols, UTF8MB3)));
    expect(rest).toEqual([]);
    expect(s.sql).toBe("ALTER TABLE `t`\n  MODIFY COLUMN `a` varchar(10) NOT NULL DEFAULT '',\n  DEFAULT CHARSET=utf8mb3");
    expect(s.notes).toEqual([expect.stringMatching(/^\[데이터 확인\] 문자셋이 좁아지는 컬럼: `a`\(utf8mb4 → utf8mb3\)/)]);
  });

  it('명시 문자셋 컬럼이 남으면 넓어지는 변환도 CONVERT를 쓰지 않는다', () => {
    const base = charsetTable("  `a` varchar(10) DEFAULT NULL,\n  `b` varchar(10) CHARACTER SET latin1 DEFAULT NULL", UTF8MB3);
    const target = charsetTable("  `a` varchar(10) DEFAULT NULL,\n  `b` varchar(10) CHARACTER SET latin1 DEFAULT NULL", UTF8MB4);
    const [s, ...rest] = generateDdl(diffSchemas(base, target));
    expect(rest).toEqual([]);
    expect(s.sql).toBe('ALTER TABLE `t`\n  MODIFY COLUMN `a` varchar(10) DEFAULT NULL,\n  DEFAULT CHARSET=utf8mb4,\n  COLLATE=utf8mb4_0900_ai_ci');
    expect(s.notes).toBeUndefined();
  });

  it('CONVERT 로 키 한도를 넘는 인덱스는 같은 ALTER 에서 CONVERT 앞에 DROP, 뒤에 ADD (8회차 4)', () => {
    const base = charsetTable('  `a` varchar(1000) NOT NULL,\n  KEY `ix` (`a`)', 'DEFAULT CHARSET=latin1');
    const target = charsetTable('  `a` varchar(1000) NOT NULL,\n  KEY `ix` (`a`(191))', UTF8MB4);
    expect(generateDdl(diffSchemas(base, target)).map((s) => s.sql)).toEqual([
      'ALTER TABLE `t`\n  DROP INDEX `ix`,\n  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,\n  ADD INDEX `ix` (`a`(191))',
    ]);
  });

  it('새·바뀌는 컬럼을 쓰는 인덱스가 있으면 인덱스 절을 옮기지 않는다 (8회차 4)', () => {
    const base = charsetTable('  `a` varchar(10) NOT NULL,\n  KEY `ix` (`a`)', 'DEFAULT CHARSET=latin1');
    const target = charsetTable('  `a` varchar(10) NOT NULL,\n  `b` int NOT NULL,\n  KEY `ix` (`a`,`b`)', UTF8MB4);
    expect(generateDdl(diffSchemas(base, target)).map((s) => s.sql)).toEqual([
      'ALTER TABLE `t` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      'ALTER TABLE `t`\n  DROP INDEX `ix`,\n  ADD COLUMN `b` int NOT NULL,\n  ADD INDEX `ix` (`a`,`b`)',
    ]);
  });

  it('본 ALTER가 수동 확인이면 CONVERT도 수동 확인', () => {
    const base = sqlTable('  `a` int NOT NULL');
    const md = (MD_HEAD + '|a|int|NO|||||||\n|v|int|YES|||||VIRTUAL GENERATED||\n').replace('|utf8mb4_0900_ai_ci||', '|utf8mb4_unicode_ci||');
    const stmts = generateDdl(diffSchemas(base, parseMdDump(md).model));
    expect(stmts.map((s) => [s.comment, s.sql.split('\n')[1]])).toEqual([
      [true, '-- ALTER TABLE `t` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'],
      [true, '-- ALTER TABLE `t`'],
    ]);
  });
});

describe('generateDdl', () => {
  it('역방향(target → base)도 생성한다', () => {
    const { base, target } = scenario('columns');
    const sql = renderDdl(generateDdl(diffSchemas(target, base)));
    expect(sql).toContain('ADD COLUMN `memo` varchar(100) DEFAULT NULL AFTER `status`');
    expect(sql).toContain('DROP COLUMN `discount_amt`');
  });

  it('실데이터: 타입 변경만 반영하고 AUTO_INCREMENT 차이는 무시한다', () => {
    const v1 = sample('sql');
    const v2 = v1
      .replace('`feature` varchar(50) NOT NULL', '`feature` varchar(80) NOT NULL')
      .replace('AUTO_INCREMENT=15 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci', 'AUTO_INCREMENT=999 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    const d = diffSchemas(parseSqlDump(v1).model, parseSqlDump(v2).model);
    expect(renderDdl(generateDdl(d))).toBe(
      "-- [~] TABLE ai_usage_log\nALTER TABLE `ai_usage_log`\n  MODIFY COLUMN `feature` varchar(80) NOT NULL COMMENT 'youtube_summary, sentence_ai, exam_feedback, diary_ai 등';\n",
    );
  });

  it('변경이 없으면 빈 문자열', () => {
    const m = parseSqlDump(sample('sql')).model;
    expect(renderDdl(generateDdl(diffSchemas(m, m)))).toBe('');
  });

  it('주석 문장은 comment=true, 실행 문장은 comment=false', () => {
    const { base, target } = scenario('partitions');
    const stmts = generateDdl(diffSchemas(base, target));
    for (const s of stmts) expect(s.comment).toBe(s.sql.startsWith('--'));
  });

  it('파싱 실패 객체는 수동 확인 주석', () => {
    const a = parseSqlDump('CREATE TABLE `x` (`a` int NOT NULL FOO);').model;
    const b = parseSqlDump('CREATE TABLE `x` (`a` int NOT NULL BAR);').model;
    expect(renderDdl(generateDdl(diffSchemas(a, b)))).toBe(
      '-- [~] TABLE x\n-- [수동 확인 필요] x: 파싱할 수 없는 DDL이 변경되었습니다. 원문을 비교하세요\n',
    );
  });
});

describe('테이블 rename 이름 충돌', () => {
  const { base, target } = scenario('table-replace');

  it('교체의 한쪽 매핑만 있으면(log→log_2025, TARGET 에 새 log) 관련 테이블 문장을 모두 수동 확인으로 낸다', () => {
    const d = diffSchemas(base, target, [{ kind: 'table', from: 'log', to: 'log_2025' }]);
    expect(d.ignoredRenames.map((r) => r.reason)).toEqual(['이름 충돌']);
    const stmts = generateDdl(d);
    const related = stmts.filter((s) => s.object === 'log' || s.object === 'log_2025');
    expect(related.length).toBeGreaterThan(0);
    expect(related.filter((s) => !s.comment)).toEqual([]);
    expect(related.every((s) => s.notes?.some((n) => n.includes('log→log_2025')))).toBe(true);
    // 상관없는 log_new 삭제는 그대로 실행 SQL 이다
    expect(stmts.filter((s) => s.object === 'log_new').map((s) => s.comment)).toEqual([false]);
  });

  it('얽힌 rename 묶음 문장은 related 에 모든 테이블을 담는다', () => {
    const stmts = generateDdl(diffSchemas(base, target, scenario('table-replace').renames));
    expect(stmts.map((s) => [s.object, s.related])).toEqual([['log_2025', ['log_2025', 'log']]]);
  });
});

describe('맞바꾸기 임시 이름', () => {
  const { base, target, renames } = scenario('table-swap');
  const extra = (sql: string) => parseSqlDump(sql).model;

  it('변경 없는 테이블·뷰가 이미 쓰는 __tdm_tmp_N 은 피한다', () => {
    const t = extra('CREATE TABLE `__tdm_tmp_1` (`id` int NOT NULL) ENGINE=InnoDB;\nCREATE VIEW `__tdm_tmp_2` AS select 1 AS `x`;');
    const withExtra = (m: typeof base) => ({ ...m, tables: [...m.tables, ...t.tables], views: [...m.views, ...t.views] });
    const [st] = generateDdl(diffSchemas(withExtra(base), withExtra(target), renames));
    expect(st.sql).toBe('RENAME TABLE `coupon` TO `__tdm_tmp_3`, `voucher` TO `coupon`, `__tdm_tmp_3` TO `voucher`');
  });
});

describe('뷰 DEFINER 안내', () => {
  it('뷰 CREATE 에도 루틴과 같은 DEFINER 안내를 붙인다', () => {
    const { base, target } = scenario('order-view');
    const views = generateDdl(diffSchemas(base, target)).filter((s) => s.kind === 'view' && !s.sql.startsWith('DROP'));
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) expect(v.notes).toEqual(['DEFINER 없이 생성합니다 — 실행한 사용자가 DEFINER 가 됩니다']);
  });
});

describe('생성 컬럼 저장 방식 변경', () => {
  it('VIRTUAL ↔ STORED 는 MODIFY 로 바꿀 수 없어 수동 확인 문장으로 낸다', () => {
    const t = (kind: string) => parseSqlDump(`CREATE TABLE \`t\` (\n  \`a\` int NOT NULL,\n  \`g\` int GENERATED ALWAYS AS ((\`a\` * 2)) ${kind}\n) ENGINE=InnoDB;`).model;
    const [st] = generateDdl(diffSchemas(t('VIRTUAL'), t('STORED')));
    expect(st.comment).toBe(true);
    expect(st.sql).toContain('-- [수동 확인 필요] t: 생성 컬럼(`g`)의 VIRTUAL↔STORED 변경은 MODIFY 로 할 수 없습니다');
  });

  // MySQL 8.0/8.4 실측: 일반 ↔ VIRTUAL 은 error 3106, 일반 ↔ STORED 는 MODIFY 로 된다 (5회차 3)
  const g = (def: string) => parseSqlDump(`CREATE TABLE \`t\` (\n  \`a\` int NOT NULL,\n  \`g\` ${def}\n) ENGINE=InnoDB;`).model;
  const VIRTUAL = 'int GENERATED ALWAYS AS ((`a` * 2)) VIRTUAL';
  const STORED = 'int GENERATED ALWAYS AS ((`a` * 2)) STORED';

  it('일반 ↔ VIRTUAL 생성 컬럼 전환은 수동 확인 문장으로 낸다', () => {
    for (const [from, to] of [['int DEFAULT NULL', VIRTUAL], [VIRTUAL, 'int DEFAULT NULL']]) {
      const [st] = generateDdl(diffSchemas(g(from), g(to)));
      expect(st.comment).toBe(true);
      expect(st.sql).toContain('-- [수동 확인 필요] t: 생성 컬럼(`g`)의 일반↔VIRTUAL 변경은 MODIFY 로 할 수 없습니다');
    }
  });

  it('일반 ↔ STORED 생성 컬럼 전환은 그대로 MODIFY', () => {
    for (const [from, to] of [['int DEFAULT NULL', STORED], [STORED, 'int DEFAULT NULL']]) {
      const [st] = generateDdl(diffSchemas(g(from), g(to)));
      expect(st).toMatchObject({ comment: false, sql: `ALTER TABLE \`t\`\n  MODIFY COLUMN \`g\` ${to}` });
    }
  });
});

describe('FK 로 묶인 컬럼 타입·문자셋 변경 (5회차 1)', () => {
  const dump = (coll: string, childColl: string) => parseSqlDump([
    `CREATE TABLE \`p\` (\n  \`code\` varchar(10) COLLATE ${coll} NOT NULL,\n  PRIMARY KEY (\`code\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,
    `CREATE TABLE \`c\` (\n  \`id\` int NOT NULL,\n  \`code\` varchar(10) COLLATE ${childColl} NOT NULL,\n  PRIMARY KEY (\`id\`),\n  KEY \`fk_c\` (\`code\`),\n  CONSTRAINT \`fk_c\` FOREIGN KEY (\`code\`) REFERENCES \`p\` (\`code\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,
  ].join('\n')).model;

  it('참조 컬럼의 콜레이션만 바뀌어도 자식 FK 를 1단계 DROP, 마지막 ADD', () => {
    const d = diffSchemas(dump('utf8mb4_0900_ai_ci', 'utf8mb4_bin'), dump('utf8mb4_bin', 'utf8mb4_bin'));
    expect(d.tables.find((t) => t.name === 'c')?.foreignKeys.map((f) => [f.op, f.name, f.fields])).toEqual([['modify', 'fk_c', ['columnType']]]);
    const sql = generateDdl(d).map((s) => s.sql);
    expect(sql[0]).toBe('ALTER TABLE `c`\n  DROP FOREIGN KEY `fk_c`');
    expect(sql[sql.length - 1]).toBe('ALTER TABLE `c`\n  ADD CONSTRAINT `fk_c` FOREIGN KEY (`code`) REFERENCES `p` (`code`)');
  });

  it('묶인 컬럼의 타입이 그대로면 FK 를 건드리지 않는다', () => {
    const d = diffSchemas(dump('utf8mb4_bin', 'utf8mb4_bin'), dump('utf8mb4_bin', 'utf8mb4_bin'));
    expect(d.tables).toEqual([]);
  });
});

describe('파티션 키 컬럼 rename·삭제 (5회차 2)', () => {
  const t = (cols: string, key: string, part: string) => parseSqlDump(`CREATE TABLE \`t\` (\n  \`id\` int NOT NULL,\n${cols},\n  PRIMARY KEY (\`id\`,${key})\n) ENGINE=InnoDB\n/*!50100 ${part} */;`).model;

  it('삭제·REMOVE PARTITIONING 도 같은 ALTER 에 넣는다 (MySQL 8.0/8.4 실측)', () => {
    const base = t('  `a` int NOT NULL,\n  `b` int NOT NULL', '`a`,`b`', 'PARTITION BY HASH ((`id` + `a`))\nPARTITIONS 2');
    const [drop] = generateDdl(diffSchemas(base, t('  `b` int NOT NULL', '`b`', 'PARTITION BY HASH (`id`)\nPARTITIONS 2')));
    expect(drop.sql).toBe('ALTER TABLE `t`\n  DROP PRIMARY KEY,\n  DROP COLUMN `a`,\n  ADD PRIMARY KEY (`id`,`b`)\n  PARTITION BY HASH (`id`)\nPARTITIONS 2');
    const target = parseSqlDump('CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `a2` int NOT NULL,\n  `b` int NOT NULL,\n  PRIMARY KEY (`id`,`a2`,`b`)\n) ENGINE=InnoDB;').model;
    const stmts = generateDdl(diffSchemas(base, target, [{ kind: 'column', table: 't', from: 'a', to: 'a2' }]));
    expect(stmts.map((s) => s.sql)).toEqual(['ALTER TABLE `t`\n  RENAME COLUMN `a` TO `a2`\n  REMOVE PARTITIONING']);
  });

  it('RANGE COLUMNS 의 따옴표 없는 컬럼 이름도 파티션 키로 본다', () => {
    const part = (c: string) => `PARTITION BY RANGE  COLUMNS(${c})\n(PARTITION p1 VALUES LESS THAN ('2026-01-01') ENGINE = InnoDB,\n PARTITION p2 VALUES LESS THAN (MAXVALUE) ENGINE = InnoDB)`;
    const stmts = generateDdl(diffSchemas(t('  `d` date NOT NULL', '`d`', part('d')), t('  `d2` date NOT NULL', '`d2`', part('d2')), [{ kind: 'column', table: 't', from: 'd', to: 'd2' }]));
    expect(stmts).toHaveLength(1);
    expect(stmts[0].sql).toMatch(/^ALTER TABLE `t`\n {2}RENAME COLUMN `d` TO `d2`\n {2}PARTITION BY RANGE {2}COLUMNS\(d2\)/);
  });
});

describe('맞바꾸기 묶음의 이름 충돌 전파', () => {
  const t = (name: string, cols: string) => `CREATE TABLE \`${name}\` (\n  \`id\` int NOT NULL,\n${cols},\n  PRIMARY KEY (\`id\`)\n) ENGINE=InnoDB;`;
  const base = parseSqlDump([t('a', '  `x` int NOT NULL,\n  `payload` varchar(10) NOT NULL'), t('b', '  `x` int NOT NULL,\n  `y` int NOT NULL'),
    'CREATE TABLE `ref` (\n  `id` int NOT NULL,\n  `a_id` int NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fk_ref_a` (`a_id`),\n  CONSTRAINT `fk_ref_a` FOREIGN KEY (`a_id`) REFERENCES `a` (`id`)\n) ENGINE=InnoDB;'].join('\n')).model;
  const target = parseSqlDump([t('a', '  `y` int NOT NULL'), t('b', '  `x` int NOT NULL'),
    'CREATE TABLE `ref` (\n  `id` int NOT NULL,\n  `a_id` int NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fk_ref_a` (`a_id`),\n  CONSTRAINT `fk_ref_a` FOREIGN KEY (`a_id`) REFERENCES `b` (`id`) ON DELETE CASCADE\n) ENGINE=InnoDB;'].join('\n')).model;
  const renames = [
    { kind: 'table' as const, from: 'a', to: 'b' },
    { kind: 'table' as const, from: 'b', to: 'a' },
    { kind: 'column' as const, table: 'a', from: 'x', to: 'y' },
  ];

  it('a↔b 와 a 의 컬럼 rename 충돌이 함께 있으면 묶음의 모든 테이블 문장을 실행하지 않는다', () => {
    const d = diffSchemas(base, target, renames);
    expect(d.ignoredRenames.map((r) => [r.mapping.kind, r.reason])).toEqual([['column', '이름 충돌']]);
    const stmts = generateDdl(d);
    const ofGroup = stmts.filter((s) => s.kind === 'table' && (s.related ?? [s.object]).some((n) => n === 'a' || n === 'b'));
    expect(ofGroup.length).toBeGreaterThan(0);
    expect(ofGroup.filter((s) => !s.comment).map((s) => s.sql)).toEqual([]);
    // 기존 b(새 a 가 될 테이블)의 컬럼 삭제도 주석이다
    expect(stmts.some((s) => s.comment && s.sql.includes('-- ALTER TABLE `b`'))).toBe(true);
  });

  it('묶음 테이블을 참조하는 다른 테이블의 FK 문장도 실행하지 않는다', () => {
    const stmts = generateDdl(diffSchemas(base, target, renames));
    expect(stmts.filter((s) => s.object === 'ref').map((s) => s.comment)).toEqual([true, true]);
  });
});

describe('FK 재생성 시 FK 가 만든 인덱스 이름 고정', () => {
  const c = (act: string, extra = '') => parseSqlDump(`CREATE TABLE \`c\` (\n  \`id\` int NOT NULL,\n  \`pid\` int NOT NULL,\n  PRIMARY KEY (\`id\`),\n  KEY \`pid\` (\`pid\`),${extra}\n  CONSTRAINT \`c_ibfk_1\` FOREIGN KEY (\`pid\`) REFERENCES \`p\` (\`id\`)${act}\n) ENGINE=InnoDB;`).model;

  it('이름 없는 FK 를 바꾸면 1단계에서 RENAME INDEX pid TO pid 로 인덱스 이름을 고정한다', () => {
    const [drop, add] = generateDdl(diffSchemas(c(''), c(' ON DELETE CASCADE')));
    expect(drop.sql).toBe('ALTER TABLE `c`\n  DROP FOREIGN KEY `c_ibfk_1`,\n  RENAME INDEX `pid` TO `pid`');
    expect(drop.notes?.[0]).toMatch(/^RENAME INDEX x TO x:/);
    expect(add.sql).toBe('ALTER TABLE `c`\n  ADD CONSTRAINT `c_ibfk_1` FOREIGN KEY (`pid`) REFERENCES `p` (`id`) ON DELETE CASCADE');
  });

  it('FK 삭제만 하거나 인덱스 이름이 FK 이름과 같으면 고정하지 않는다', () => {
    const named = (act: string) => parseSqlDump(`CREATE TABLE \`c\` (\n  \`id\` int NOT NULL,\n  \`pid\` int NOT NULL,\n  KEY \`fk_c\` (\`pid\`),\n  CONSTRAINT \`fk_c\` FOREIGN KEY (\`pid\`) REFERENCES \`p\` (\`id\`)${act}\n) ENGINE=InnoDB;`).model;
    expect(generateDdl(diffSchemas(named(''), named(' ON DELETE CASCADE')))[0].sql).toBe('ALTER TABLE `c`\n  DROP FOREIGN KEY `fk_c`');
    const noFk = parseSqlDump('CREATE TABLE `c` (\n  `id` int NOT NULL,\n  `pid` int NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `pid` (`pid`)\n) ENGINE=InnoDB;').model;
    expect(generateDdl(diffSchemas(c(''), noFk))[0].sql).toBe('ALTER TABLE `c`\n  DROP FOREIGN KEY `c_ibfk_1`');
  });
});

describe('ALTER 단위 수동 확인의 전파 (6회차 4)', () => {
  const parent = (g: string, extra = '') => `CREATE TABLE \`t\` (\n  \`id\` int NOT NULL,\n  \`a\` int NOT NULL,\n  \`g\` int GENERATED ALWAYS AS ((\`a\` * 2)) ${g},\n${extra}  PRIMARY KEY (\`id\`)\n) ENGINE=InnoDB;`;
  const OLD_CHILD = 'CREATE TABLE `old_child` (\n  `id` int NOT NULL,\n  `t_id` int NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fk_old_t` (`t_id`),\n  CONSTRAINT `fk_old_t` FOREIGN KEY (`t_id`) REFERENCES `t` (`id`)\n) ENGINE=InnoDB;';
  const OTHER = (n: string) => `CREATE TABLE \`other\` (\n  \`id\` int NOT NULL,\n  \`n\` varchar(${n}) NOT NULL,\n  PRIMARY KEY (\`id\`)\n) ENGINE=InnoDB;`;
  const NEW_CHILD = 'CREATE TABLE `child` (\n  `id` int NOT NULL,\n  `t_k` int NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fk_child_t` (`t_k`),\n  CONSTRAINT `fk_child_t` FOREIGN KEY (`t_k`) REFERENCES `t` (`k`)\n) ENGINE=InnoDB;';
  const VIEW = (table: string, col: string) => `CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW \`v_${table}\` AS select \`${table}\`.\`${col}\` AS \`${col}\` from \`${table}\`;`;
  const base = parseSqlDump([parent('VIRTUAL'), OLD_CHILD, OTHER('10')].join('\n')).model;
  const target = parseSqlDump([parent('STORED', '  `k` int NOT NULL,\n  UNIQUE KEY `uq_k` (`k`),\n'), OLD_CHILD, OTHER('20'), NEW_CHILD, VIEW('t', 'k'), VIEW('other', 'n')].join('\n')).model;
  const stmts = generateDdl(diffSchemas(base, target));
  const of = (object: string) => stmts.filter((s) => s.object === object);

  it('막힌 ALTER 의 테이블을 참조하는 새 FK·읽는 뷰는 수동 확인으로 돌린다', () => {
    const fk = of('child').find((s) => s.sql.includes('ADD CONSTRAINT'));
    expect(fk?.comment).toBe(true);
    expect(fk?.sql).toMatch(/^-- \[수동 확인 필요\] child: 참조하는 테이블의 문장이 수동 확인이라 FK 변경을 실행하지 않습니다/);
    const [view] = of('v_t');
    expect(view.comment).toBe(true);
    expect(view.sql).toMatch(/^-- \[수동 확인 필요\] v_t: 읽는 객체\(t\)의 문장이 수동 확인이라/);
  });

  it('막힌 테이블 자신의 다른 문장·무관한 테이블·뷰·변경 없는 FK 는 그대로 실행', () => {
    expect(of('other').every((s) => !s.comment)).toBe(true);
    expect(of('v_other').every((s) => !s.comment)).toBe(true);
    expect(of('old_child')).toEqual([]);
    expect(of('t').filter((s) => s.comment)).toHaveLength(1);
  });

  it('실데이터 일상 변경(컬럼 확대·추가, 인덱스 추가, 새 뷰)에는 수동 확인이 없다', () => {
    const v1 = sample('sql');
    const v2 = `${v1
      .replace('`feature` varchar(50) NOT NULL', '`feature` varchar(80) NOT NULL')
      .replace('  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`log_id`),', '  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `memo` varchar(20) DEFAULT NULL,\n  PRIMARY KEY (`log_id`),\n  KEY `ix_memo` (`memo`),')}\n${VIEW('ai_usage_log', 'memo')}`;
    const stmts = generateDdl(diffSchemas(parseSqlDump(v1).model, parseSqlDump(v2).model));
    expect(stmts.length).toBeGreaterThanOrEqual(2);
    expect(renderDdl(stmts)).not.toContain('수동 확인');
  });
});

describe('objectStatements: 객체 카드 복사 묶음 (6회차 2)', () => {
  it('FK 묶인 컬럼 타입 변경은 부모 카드에 자식 FK 해제·변경·재추가를 전체 순서대로 포함한다', () => {
    const { base, target } = scenario('fk-type-widen');
    const stmts = generateDdl(diffSchemas(base, target));
    const { statements, dependencies } = objectStatements(stmts, 'table', 'member');
    expect(statements).toEqual(stmts);
    expect(dependencies).toEqual(['comment', 'post']);
  });

  it('상속 문자셋 변경도 부모·자식 문장을 묶는다', () => {
    const { base, target } = scenario('fk-charset-convert');
    const stmts = generateDdl(diffSchemas(base, target));
    expect(objectStatements(stmts, 'table', 'orders')).toEqual({ statements: stmts, dependencies: ['member'] });
  });

  const cardOf = (name: string, kind: Parameters<typeof objectStatements>[1], object: string) => {
    const { base, target, renames } = scenario(name);
    const stmts = generateDdl(diffSchemas(base, target, renames));
    return { stmts, ...objectStatements(stmts, kind, object) };
  };

  it('부모·자식 동시 삭제: 부모 카드는 자식 FK 해제를 먼저 포함하고 자식 DROP TABLE 은 넣지 않는다 (7회차 1)', () => {
    const { statements, dependencies } = cardOf('drop-fk-tables', 'table', 'a');
    expect(statements.map((s) => s.sql)).toEqual(['ALTER TABLE `b`\n  DROP FOREIGN KEY `fk_b_a`', 'DROP TABLE `a`']);
    expect(dependencies).toEqual(['b']);
    expect(cardOf('drop-fk-tables', 'table', 'b').dependencies).toEqual([]);
  });

  it('자식 FK 삭제 + 부모 PK 확장: 부모 카드는 자식 FK 해제를 포함한다 (7회차 1)', () => {
    const { stmts, statements, dependencies } = cardOf('fk-drop-parent-widen', 'table', 'member');
    expect(statements).toEqual(stmts);
    expect(dependencies).toEqual(['comment']);
    expect(cardOf('fk-drop-parent-widen', 'table', 'comment').dependencies).toEqual([]);
  });

  it('FK 이름 변경 + 타입 확장: 부모·자식 카드 모두 서로의 문장을 포함한다 (7회차 1)', () => {
    for (const [object, other] of [['member', 'comment'], ['comment', 'member']]) {
      const { stmts, statements, dependencies } = cardOf('fk-rename-widen', 'table', object);
      expect(statements).toEqual(stmts);
      expect(dependencies).toEqual([other]);
    }
  });

  it('뷰 카드는 본문이 부르는 새 함수의 생성 문장을 포함한다 (7회차 1)', () => {
    const { statements, dependencies } = cardOf('routines', 'view', 'order_net');
    expect(dependencies).toContain('net');
    expect(statements.at(-1)?.object).toBe('order_net');
  });

  it('같은 이름을 다른 종류로 바꾸면 카드에 옛 객체 삭제를 넣는다: 테이블→뷰, 뷰→테이블, 뷰 삭제 + rename into (8회차 1)', () => {
    const sqls = (name: string, kind: 'table' | 'view') => cardOf(name, kind, 'x').statements.map((s) => s.sql.split('\n')[0]);
    expect(sqls('table-to-view', 'view')).toEqual(['DROP TABLE `x`', expect.stringMatching(/^CREATE OR REPLACE .* VIEW `x`/)]);
    expect(sqls('view-to-table', 'table')).toEqual(['DROP VIEW `x`', 'CREATE TABLE `x` (']);
    expect(sqls('view-drop-rename-into', 'table')).toEqual(['DROP VIEW `x`', 'RENAME TABLE `y` TO `x`']);
    // 반대 방향 카드는 새 객체 문장을 끌어오지 않는다
    expect(cardOf('table-to-view', 'table', 'x').statements.map((s) => s.sql)).toEqual(['DROP TABLE `x`']);
  });

  it('이름을 비우는 테이블 rename 도 그 이름을 차지하는 뷰 카드에 넣는다 (8회차 1)', () => {
    const base = parseSqlDump('CREATE TABLE `x` (\n  `a` int NOT NULL\n) ENGINE=InnoDB;').model;
    const target = parseSqlDump('CREATE TABLE `z` (\n  `a` int NOT NULL\n) ENGINE=InnoDB;\nCREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `x` AS select 1 AS `a`;').model;
    const stmts = generateDdl(diffSchemas(base, target, [{ kind: 'table', from: 'x', to: 'z' }]));
    expect(objectStatements(stmts, 'view', 'x').statements.map((s) => s.sql.split('\n')[0])).toEqual(['RENAME TABLE `x` TO `z`', expect.stringMatching(/VIEW `x`/)]);
  });

  it('뷰 의존은 FROM/JOIN 테이블과 함수 호출만: 별칭·컬럼명·문자열의 같은 이름은 빼고 실제 참조는 넣는다 (8회차 2)', () => {
    const table = (name: string, cols: string) => `CREATE TABLE \`${name}\` (\n${cols}\n) ENGINE=InnoDB;\n`;
    const view = (body: string) => `CREATE ALGORITHM=UNDEFINED DEFINER=\`root\`@\`%\` SQL SECURITY DEFINER VIEW \`report\` AS ${body};`;
    const base = parseSqlDump(table('chat_log', '  `a` int NOT NULL,\n  `b` int') + table('t', '  `chat_log` int') + view('select 1 AS `a`')).model;
    const body = "select 1 AS `chat_log`,`t`.`chat_log` AS `c`,'`chat_log`' AS `s` from `t` /* `chat_log` */";
    const target = parseSqlDump(table('chat_log', '  `a` int NOT NULL') + table('t', '  `chat_log` int,\n  `d` int') + view(body)).model;
    const stmts = generateDdl(diffSchemas(base, target));
    const { dependencies, statements } = objectStatements(stmts, 'view', 'report');
    expect(dependencies).toEqual(['t']);
    expect(statements.some((s) => s.sql.includes('DROP COLUMN'))).toBe(false);
  });

  it('이름 비우기 의존은 같은 이름 공간(테이블↔뷰)끼리만: 테이블 p 삭제 + 프로시저 p 추가 카드에 DROP TABLE 을 넣지 않는다 (9회차 1)', () => {
    const { statements, dependencies } = cardOf('card-table-proc-same-name', 'procedure', 'p');
    expect(statements.map((s) => s.kind)).toEqual(['procedure']);
    expect(dependencies).toEqual([]);
  });

  it('같은 이름의 함수를 부르는 뷰 카드는 그 함수 생성을 포함한다 — 자기 자신(같은 종류·이름)만 뺀다 (9회차 2)', () => {
    const { statements } = cardOf('card-function-view-same-name', 'view', 'v');
    expect(statements.map((s) => s.kind)).toEqual(['function', 'view']);
  });

  it('함수 호출은 함수 문장만, FROM/JOIN 참조는 테이블·뷰 문장만 묶는다 — 함수 f() 만 부르는 뷰에 테이블 f 의 변경을 넣지 않고, 함수 이름은 대소문자 무시 (10회차 2)', () => {
    const { statements, dependencies } = cardOf('card-function-table-same-name', 'view', 'v');
    expect(statements.map((s) => `${s.kind} ${s.object}`)).toEqual(['function Gx', 'view v']);
    expect(dependencies).toEqual(['Gx']);
  });

  it('막힌 테이블과 같은 이름의 함수만 부르는 뷰는 막지 않는다 (10회차 2)', () => {
    const fn = 'DELIMITER ;;\nCREATE DEFINER=`root`@`%` FUNCTION `pe`() RETURNS int\n    NO SQL\nRETURN 1;;\nDELIMITER ;';
    const view = 'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v` AS select `pe`() AS `n`;';
    const pe = "CREATE TABLE `pe` (\n  `id` int NOT NULL,\n  `a` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix` (`a`) /*!80021 SECONDARY_ENGINE_ATTRIBUTE '{\"y\": 2}' */\n) ENGINE=InnoDB;";
    const stmts = generateDdl(diffSchemas(parseSqlDump(fn).model, parseSqlDump(`${pe}\n${view}\n${fn}`).model));
    expect(stmts.find((s) => s.kind === 'table')?.comment).toBe(true);
    expect(stmts.find((s) => s.kind === 'view')?.comment).toBe(false);
  });

  it('뷰 카드와 뷰 생성 순서는 같은 토큰 기반 참조를 쓴다: 별칭 `z` 는 뷰 z 참조가 아니다 (9회차 3)', () => {
    const { stmts, statements } = cardOf('view-order-alias', 'view', 'a');
    expect(stmts.map((s) => s.object)).toEqual(['a', 'z']);
    expect(statements.map((s) => s.object)).toEqual(['a']);
    expect(cardOf('view-order-alias', 'view', 'z').statements.map((s) => s.object)).toEqual(['a', 'z']);
  });

  it('의존이 없으면 자기 문장만', () => {
    const { base, target } = scenario('columns');
    const stmts = generateDdl(diffSchemas(base, target));
    const name = stmts[0].object;
    const { statements, dependencies } = objectStatements(stmts, 'table', name);
    expect(statements).toEqual(stmts.filter((s) => s.kind === 'table' && (s.object === name || s.related?.includes(name))));
    expect(dependencies).toEqual([]);
  });
});

describe('CONVERT 직후 키 길이 일반 판정 (9회차 4)', () => {
  const t = (name: string, cols: string, opts: string) => `CREATE TABLE \`${name}\` (\n${cols}\n) ENGINE=InnoDB ${opts};`;
  const ddl = (base: string, target: string) => generateDdl(diffSchemas(parseSqlDump(base).model, parseSqlDump(target).model));
  const UTF8MB4 = 'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci';

  it('키 바이트 = 문자 길이(prefix 반영) × 새 문자셋 maxlen, 한도는 TARGET 행 저장 형식 (COMPACT 키 파트 767·전체 3072)', () => {
    const cols = [{ name: 'a', type: 'varchar(250)', nullable: true, invisible: false, autoIncrement: false }, { name: 'b', type: 'varbinary(800)', nullable: true, invisible: false, autoIncrement: false }];
    const ix = (parts: { column: string; length?: number }[]) => ({ name: 'ix', kind: 'INDEX' as const, parts: parts.map((p) => ({ ...p, desc: false })), invisible: false });
    expect(oversizedIndexes([ix([{ column: 'a' }])], cols, 4, keyLimit('COMPACT'))).toEqual(['ix']);
    expect(oversizedIndexes([ix([{ column: 'a' }])], cols, 4, keyLimit(undefined))).toEqual([]);
    expect(oversizedIndexes([ix([{ column: 'a', length: 191 }])], cols, 4, keyLimit('REDUNDANT'))).toEqual([]);
    expect(oversizedIndexes([ix([{ column: 'b' }])], cols, 4, keyLimit('COMPACT'))).toEqual(['ix']);
    expect(oversizedIndexes([ix([{ column: 'a' }, { column: 'a' }, { column: 'a' }, { column: 'b' }])], cols, 4, keyLimit('DYNAMIC'))).toEqual(['ix']);
  });

  it('DYNAMIC→COMPACT + CONVERT: 767 한도를 넘는 인덱스 교체를 CONVERT 와 같은 ALTER 에 넣는다', () => {
    const stmts = ddl(t('t', '  `a` varchar(250) DEFAULT NULL,\n  KEY `ix` (`a`)', 'DEFAULT CHARSET=latin1'),
      t('t', '  `a` varchar(250) DEFAULT NULL,\n  KEY `ix` (`a`(191))', `${UTF8MB4} ROW_FORMAT=COMPACT`));
    expect(stmts.map((s) => s.sql)).toEqual(['ALTER TABLE `t`\n  DROP INDEX `ix`,\n  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,\n  ROW_FORMAT=COMPACT,\n  ADD INDEX `ix` (`a`(191))']);
  });

  it('합쳐도 한도를 넘으면(판정 불가) 수동 확인, 그 테이블을 참조하는 새 FK 도 막는다', () => {
    const base = t('t', '  `id` int NOT NULL,\n  `a` varchar(1000) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix` (`a`)', 'DEFAULT CHARSET=latin1');
    const target = t('t', '  `id` int NOT NULL,\n  `a` varchar(1000) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix` (`a`)', UTF8MB4)
      + t('c', '  `t_id` int NOT NULL,\n  KEY `fk_c_t` (`t_id`),\n  CONSTRAINT `fk_c_t` FOREIGN KEY (`t_id`) REFERENCES `t` (`id`)', UTF8MB4);
    const stmts = ddl(base, target);
    expect(stmts.filter((s) => !s.comment)).toEqual([]);
    expect(stmts.find((s) => s.object === 't')!.sql).toMatch(/^-- \[수동 확인 필요\] t: CONVERT 뒤 인덱스\(`ix`\) 키 길이가 한도를 넘는/);
  });

  it('한도를 넘지 않으면 CONVERT 를 따로 둔다 (기존 동작)', () => {
    const stmts = ddl(t('t', '  `a` varchar(100) DEFAULT NULL,\n  KEY `ix` (`a`)', 'DEFAULT CHARSET=latin1'),
      t('t', '  `a` varchar(100) NOT NULL,\n  KEY `ix` (`a`)', UTF8MB4));
    expect(stmts.map((s) => s.sql)).toEqual(['ALTER TABLE `t` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci', 'ALTER TABLE `t`\n  MODIFY COLUMN `a` varchar(100) NOT NULL']);
  });
});
