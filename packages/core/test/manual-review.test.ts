import { describe, expect, it } from 'vitest';
import { generateDdl, renderDdl, type Statement } from '../src/ddl';
import { diffSchemas, type RenameMapping } from '../src/diff';
import { parseSqlDump } from '../src/parse-dump';
import { parseMdDump } from '../src/parse-md';
import { scenario } from './helpers';

const dump = (...sqls: string[]) => parseSqlDump(sqls.join('\n')).model;
const tbl = (name: string, body: string) => `CREATE TABLE \`${name}\` (\n${body}\n) ENGINE=InnoDB;`;
const touches = (s: Statement, names: string[]) => (s.related ?? [s.object]).some((n) => names.includes(n));
const runnable = (stmts: Statement[], names: string[]) => stmts.filter((s) => !s.comment && touches(s, names)).map((s) => s.sql);

describe('수동 확인 전파 고정점 (4회차 1)', () => {
  // a 의 컬럼 rename 충돌 → c(옛 b)의 FK 가 a 를 참조 → b↔c 맞바꾸기 묶음 → b(옛 c)의 DROP COLUMN, c 를 읽는 뷰 v
  const base = dump(
    tbl('a', '  `id` int NOT NULL,\n  `x` int NOT NULL,\n  `y` int NOT NULL,\n  PRIMARY KEY (`id`)'),
    tbl('b', '  `id` int NOT NULL,\n  `payload` varchar(10) NOT NULL,\n  `a_id` int NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fk_b_a` (`a_id`),\n  CONSTRAINT `fk_b_a` FOREIGN KEY (`a_id`) REFERENCES `a` (`id`)'),
    tbl('c', '  `id` int NOT NULL,\n  `payload` varchar(10) NOT NULL,\n  PRIMARY KEY (`id`)'),
    tbl('z', '  `id` int NOT NULL,\n  PRIMARY KEY (`id`)'),
  );
  const target = dump(
    tbl('a', '  `id` int NOT NULL,\n  `y` int NOT NULL,\n  PRIMARY KEY (`id`)'),
    tbl('b', '  `id` int NOT NULL,\n  PRIMARY KEY (`id`)'),
    tbl('c', '  `id` int NOT NULL,\n  `payload` varchar(10) NOT NULL,\n  `a_id` int NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fk_b_a` (`a_id`),\n  CONSTRAINT `fk_b_a` FOREIGN KEY (`a_id`) REFERENCES `a` (`id`) ON DELETE CASCADE'),
    tbl('z', '  `id` int NOT NULL,\n  `n` int NOT NULL,\n  PRIMARY KEY (`id`)'),
    'CREATE VIEW `v` AS select `c`.`id` AS `id` from `c`;',
  );
  const renames: RenameMapping[] = [
    { kind: 'table', from: 'b', to: 'c' },
    { kind: 'table', from: 'c', to: 'b' },
    { kind: 'column', table: 'a', from: 'x', to: 'y' },
  ];

  it('FK 로 번진 충돌이 맞바꾸기 묶음에 닿으면 묶음 전체·그 테이블을 읽는 뷰까지 실행 문장 0', () => {
    const stmts = generateDdl(diffSchemas(base, target, renames));
    expect(runnable(stmts, ['a', 'b', 'c'])).toEqual([]);
    expect(stmts.some((s) => s.comment && s.sql.includes('-- ALTER TABLE `b`'))).toBe(true);
    const views = stmts.filter((s) => s.kind === 'view');
    expect(views.map((s) => [s.object, s.comment])).toEqual([['v', true]]);
    // 무관한 테이블은 그대로 실행한다
    expect(runnable(stmts, ['z'])).toEqual(['ALTER TABLE `z`\n  ADD COLUMN `n` int NOT NULL']);
  });
});

describe('삭제 컬럼 이름을 rename 이 재사용할 때 외부 의존성 (4회차 3)', () => {
  const reuse: RenameMapping[] = [{ kind: 'column', table: 'p', from: 'k', to: 'y', allowOverlap: true }];
  const target = (extra = '') => tbl('p', `  \`id\` int NOT NULL,\n  \`y\` int NOT NULL,\n  PRIMARY KEY (\`id\`)${extra}`);
  const other = tbl('z', '  `id` int NOT NULL,\n  PRIMARY KEY (`id`)');
  const otherTarget = tbl('z', '  `id` int NOT NULL,\n  `n` int NOT NULL,\n  PRIMARY KEY (`id`)');

  it('식 인덱스가 삭제 컬럼을 쓰면 그 테이블 문장을 실행하지 않는다', () => {
    const base = dump(tbl('p', '  `id` int NOT NULL,\n  `k` int NOT NULL,\n  `y` int NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_abs` ((abs(`y`)))'), other);
    const stmts = generateDdl(diffSchemas(base, dump(target(',\n  KEY `idx_abs` ((abs(`y`)))'), otherTarget), reuse));
    expect(stmts.filter((s) => s.object === 'p').length).toBeGreaterThan(0);
    expect(runnable(stmts, ['p'])).toEqual([]);
    expect(runnable(stmts, ['z'])).toEqual(['ALTER TABLE `z`\n  ADD COLUMN `n` int NOT NULL']);
  });

  it('생성 컬럼 식이 삭제 컬럼을 쓰면 수동 확인', () => {
    const base = dump(tbl('p', '  `id` int NOT NULL,\n  `k` int NOT NULL,\n  `y` int NOT NULL,\n  `g` int GENERATED ALWAYS AS ((`y` + 1)) VIRTUAL,\n  PRIMARY KEY (`id`)'));
    const t = dump(tbl('p', '  `id` int NOT NULL,\n  `y` int NOT NULL,\n  `g` int GENERATED ALWAYS AS ((`y` + 1)) VIRTUAL,\n  PRIMARY KEY (`id`)'));
    expect(runnable(generateDdl(diffSchemas(base, t, reuse)), ['p'])).toEqual([]);
  });

  it('다른 테이블 FK 가 삭제 컬럼을 참조하면 그 테이블과 바뀌는 자식 테이블 문장을 실행하지 않는다', () => {
    const child = (extra: string) => tbl('ch', `  \`id\` int NOT NULL,\n  \`py\` int NOT NULL,${extra}\n  PRIMARY KEY (\`id\`),\n  KEY \`fk_ch_p\` (\`py\`),\n  CONSTRAINT \`fk_ch_p\` FOREIGN KEY (\`py\`) REFERENCES \`p\` (\`y\`)`);
    const base = dump(tbl('p', '  `id` int NOT NULL,\n  `k` int NOT NULL,\n  `y` int NOT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_y` (`y`)'), child(''), other);
    const t = dump(target(',\n  UNIQUE KEY `uq_y` (`y`)'), child('\n  `m` int NOT NULL,'), otherTarget);
    const stmts = generateDdl(diffSchemas(base, t, reuse));
    expect(stmts.filter((s) => s.object === 'ch').length).toBeGreaterThan(0);
    expect(runnable(stmts, ['p', 'ch'])).toEqual([]);
    expect(runnable(stmts, ['z'])).toEqual(['ALTER TABLE `z`\n  ADD COLUMN `n` int NOT NULL']);
  });
});

describe('FK 자동 이름 보정이 다른 FK 이름과 겹칠 때 (4회차 5)', () => {
  const p = tbl('p', '  `id` int NOT NULL,\n  PRIMARY KEY (`id`)');
  const c = (name: string, second: string) => tbl(name, [
    '  `id` int NOT NULL,\n  `x` int NOT NULL,\n  `y` int NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `x` (`x`),\n  KEY `y` (`y`),',
    `  CONSTRAINT \`${name}_ibfk_1\` FOREIGN KEY (\`x\`) REFERENCES \`p\` (\`id\`),`,
    `  CONSTRAINT \`${second}\` FOREIGN KEY (\`y\`) REFERENCES \`p\` (\`id\`)`,
  ].join('\n'));

  it('보정명이 겹치면 보정하지 않고 그 테이블 FK 문장을 수동 확인으로', () => {
    const d = diffSchemas(dump(p, c('c', 'c2_ibfk_1')), dump(p, c('c2', 'fk_y')), [{ kind: 'table', from: 'c', to: 'c2' }]);
    const c2 = d.tables.find((t) => t.name === 'c2')!;
    // 원래 식별자 그대로 비교한다 (c_ibfk_1 은 c2_ibfk_1 로 바꾸지 않는다)
    expect(c2.foreignKeys.map((f) => `${f.op}:${f.name}`).sort()).toEqual(['add:fk_y', 'drop:c_ibfk_1', 'modify:c2_ibfk_1']);
    const stmts = generateDdl(d);
    expect(stmts.filter((s) => s.object === 'c2').length).toBeGreaterThan(0);
    expect(runnable(stmts, ['c2'])).toEqual([]);
  });
});

describe('MD 출처 CHECK 안내 (4회차 6)', () => {
  const md = '# s\n\n## Table List\n- [t ()](#t)\n\n## t\n**Information**\n|Table type|Engine|Row format|Collate|Comment|\n|---|---|---|---|---|\n'
    + '|BASE TABLE|InnoDB|Dynamic|utf8mb4_0900_ai_ci||\n\n**Columns**\n|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|\n|---|---|---|---|---|---|---|---|---|\n'
    + '|id|int|NO||||PRI|||\n|b|int|NO||||||\n\n \n';
  const base = dump(tbl('t', '  `id` int NOT NULL,\n  `a` int NOT NULL,\n  PRIMARY KEY (`id`)'));

  it('컬럼 rename 이 있으면 CHECK 오류 3959 가능성을 한 줄 덧붙인다', () => {
    const d = diffSchemas(base, parseMdDump(md).model, [{ kind: 'column', table: 't', from: 'a', to: 'b' }]);
    const ddl = renderDdl(generateDdl(d), d.partial);
    expect(ddl).toContain('RENAME COLUMN `a` TO `b`');
    expect(ddl).toContain('3959');
  });

  it('컬럼 rename 이 없으면 덧붙이지 않는다', () => {
    const d = diffSchemas(base, parseMdDump(md.replace('|b|int|', '|a|bigint|')).model);
    expect(renderDdl(generateDdl(d), d.partial)).not.toContain('3959');
  });
});

describe('충돌로 막힌 테이블을 참조하는 새 테이블 (5회차 5)', () => {
  const base = dump(tbl('a', '  `id` int NOT NULL,\n  `x` int NOT NULL,\n  `y` int NOT NULL,\n  PRIMARY KEY (`id`)'));
  const target = dump(
    tbl('a', '  `id` int NOT NULL,\n  `y` int NOT NULL,\n  PRIMARY KEY (`id`)'),
    tbl('child', '  `id` int NOT NULL,\n  `a_id` int NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fk_child_a` (`a_id`),\n  CONSTRAINT `fk_child_a` FOREIGN KEY (`a_id`) REFERENCES `a` (`id`)'),
  );

  it('새 테이블의 FK 가 막힌 테이블을 참조하면 그 새 테이블 문장도 실행하지 않는다', () => {
    const stmts = generateDdl(diffSchemas(base, target, [{ kind: 'column', table: 'a', from: 'x', to: 'y' }]));
    expect(runnable(stmts, ['a', 'child'])).toEqual([]);
    expect(stmts.some((s) => s.object === 'child' && s.comment && s.sql.includes('-- ALTER TABLE `child`'))).toBe(true);
  });
});

describe('식별자 토큰 기준 참조 판정 (5회차 6)', () => {
  it('막힌 테이블 이름이 뷰 본문에서 컬럼 별칭으로만 나오면 뷰를 막지 않는다', () => {
    const base = dump(tbl('a', '  `id` int NOT NULL,\n  `x` int NOT NULL,\n  `y` int NOT NULL,\n  PRIMARY KEY (`id`)'), tbl('z', '  `id` int NOT NULL,\n  PRIMARY KEY (`id`)'));
    const target = dump(
      tbl('a', '  `id` int NOT NULL,\n  `y` int NOT NULL,\n  PRIMARY KEY (`id`)'), tbl('z', '  `id` int NOT NULL,\n  PRIMARY KEY (`id`)'),
      'CREATE VIEW `v` AS select `z`.`id` AS `a` from `z`;',
      'CREATE VIEW `w` AS select `q`.`id` AS `id` from `shop`.`a` `q`;',
    );
    const stmts = generateDdl(diffSchemas(base, target, [{ kind: 'column', table: 'a', from: 'x', to: 'y' }]));
    const views = stmts.filter((s) => s.kind === 'view').map((s) => [s.object, s.comment]);
    expect(views).toEqual([['v', false], ['w', true]]);
  });

  it('삭제 컬럼 이름이 식 안에서 문자열로만 나오면 재사용 의존성으로 보지 않는다', () => {
    const t = (cols: string) => dump(tbl('t', `  \`id\` int NOT NULL,\n${cols},\n  PRIMARY KEY (\`id\`)`));
    const base = t("  `old` int NOT NULL,\n  `code` int NOT NULL,\n  `tag` varchar(20) GENERATED ALWAYS AS (concat(_utf8mb4'`code`', `id`)) VIRTUAL");
    const target = t("  `code` int NOT NULL,\n  `tag` varchar(20) GENERATED ALWAYS AS (concat(_utf8mb4'`code`', `id`)) VIRTUAL");
    const d = diffSchemas(base, target, [{ kind: 'column', table: 't', from: 'old', to: 'code', allowOverlap: true }]);
    expect(d.manualTables).toEqual([]);
  });
});

describe('fk-retype 묶음 수동 확인 전파 (8회차 3)', () => {
  it('묶음의 한 테이블 ALTER 가 수동 확인이면 FK 해제·부모 MODIFY·FK 재추가까지 묶음 전체 실행 문장 0', () => {
    const { base, target } = scenario('fk-retype-generated');
    const stmts = generateDdl(diffSchemas(base, target));
    expect(stmts.length).toBeGreaterThan(0);
    expect(runnable(stmts, ['member', 'point'])).toEqual([]);
    expect(stmts.find((s) => s.object === 'member')?.sql).toMatch(/^-- \[수동 확인 필요\] member: /);
  });
});

describe('FK 가 참조하는 부모 UNIQUE 교체 (8회차 5, 8.4 restrict_fk_on_non_standard_key)', () => {
  it('바뀌지 않는 자식 FK 가 쓰는 UNIQUE 를 비UNIQUE 로 바꾸면 부모 ALTER 를 수동 확인, 무관한 테이블은 실행', () => {
    const { base, target } = scenario('fk-unique-replace');
    const stmts = generateDdl(diffSchemas(base, target));
    expect(runnable(stmts, ['member'])).toEqual([]);
    const member = stmts.find((s) => s.object === 'member')!;
    expect(member.sql).toContain('restrict_fk_on_non_standard_key');
    expect(member.sql).toContain('coupon');
    expect(runnable(stmts, ['memo'])).toEqual(['ALTER TABLE `memo`\n  ADD INDEX `ix_memo_id` (`id`)']);
  });

  const parent = (key: string) => tbl('p', `  \`id\` int NOT NULL,\n  \`code\` varchar(10) NOT NULL,\n  \`n\` int NOT NULL,\n  PRIMARY KEY (\`id\`),\n  ${key}`);
  const child = tbl('c', '  `id` int NOT NULL,\n  `code` varchar(10) NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix_c` (`code`),\n  CONSTRAINT `fk_c_p` FOREIGN KEY (`code`) REFERENCES `p` (`code`)');
  const blocked = (from: string, to: string, childTo = child) => runnable(generateDdl(diffSchemas(dump(parent(from), child), dump(parent(to), childTo))), ['p']).length === 0;

  it('부분(prefix) 키·컬럼이 늘어난 UNIQUE 도 막고, 표준 키가 남거나 FK 를 함께 지우면 막지 않는다', () => {
    expect(blocked('UNIQUE KEY `uq` (`code`)', 'UNIQUE KEY `uq` (`code`(5))')).toBe(true);
    expect(blocked('UNIQUE KEY `uq` (`code`)', 'UNIQUE KEY `uq` (`code`,`n`)')).toBe(true);
    expect(blocked('UNIQUE KEY `uq` (`code`)', 'UNIQUE KEY `uq` (`code`) COMMENT \'x\'')).toBe(false);
    expect(blocked('UNIQUE KEY `uq` (`code`)', 'UNIQUE KEY `uq2` (`code`)')).toBe(false);
    const noFk = tbl('c', '  `id` int NOT NULL,\n  `code` varchar(10) NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix_c` (`code`)');
    expect(blocked('UNIQUE KEY `uq` (`code`)', 'KEY `uq` (`code`)', noFk)).toBe(false);
  });
});

describe('파싱 실패 객체는 출처와 무관하게 수동 확인, 의존 문장에도 전파 (9회차 6)', () => {
  const peTable = tbl('pe', "  `id` int NOT NULL,\n  `a` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix` (`a`) /*!80021 SECONDARY_ENGINE_ATTRIBUTE '{\"y\": 2}' */");
  const view = (name: string, body: string) => `CREATE ALGORITHM=UNDEFINED DEFINER=\`root\`@\`%\` SQL SECURITY DEFINER VIEW \`${name}\` AS ${body};`;

  it('SQL 출처의 파싱 실패 새 테이블 CREATE 는 주석 처리한 수동 확인, 그 테이블을 읽는 뷰·참조하는 FK 도 막는다', () => {
    const base = dump(tbl('m', '  `id` int NOT NULL,\n  PRIMARY KEY (`id`)'));
    const target = dump(tbl('m', '  `id` int NOT NULL,\n  PRIMARY KEY (`id`)'), peTable,
      tbl('c', '  `id` int NOT NULL,\n  `pe_id` int NOT NULL,\n  KEY `fk_c_pe` (`pe_id`),\n  CONSTRAINT `fk_c_pe` FOREIGN KEY (`pe_id`) REFERENCES `pe` (`id`)'),
      view('v', 'select `pe`.`id` AS `id` from `pe`'), view('w', 'select `m`.`id` AS `id` from `m`'));
    const stmts = generateDdl(diffSchemas(base, target));
    expect(runnable(stmts, ['pe', 'c'])).toEqual([]);
    const pe = stmts.find((s) => s.object === 'pe')!;
    expect(pe.sql).toMatch(/^-- \[수동 확인 필요\] pe: /);
    expect(pe.sql).toContain('-- CREATE TABLE `pe` (');
    expect(stmts.filter((s) => s.kind === 'view').map((s) => [s.object, s.comment])).toEqual([['v', true], ['w', false]]);
  });

  it('파싱 실패 새 함수를 부르는 뷰, 파싱 실패 뷰를 읽는 뷰도 막는다', () => {
    const fn = 'CREATE DEFINER=`root`@`%` FUNCTION `f` RETURNS int RETURN 1';
    const base = dump(tbl('m', '  `id` int NOT NULL'));
    const target = dump(tbl('m', '  `id` int NOT NULL'), `DELIMITER ;;\n${fn};;\nDELIMITER ;`,
      view('calls', 'select `f`() AS `x`'), 'CREATE VIEW `bad` ???;', view('reads_bad', 'select `bad`.`x` AS `x` from `bad`'));
    const parsed = diffSchemas(base, target);
    expect(parsed.routines.map((r) => [r.name, Boolean(r.to?.parseError)])).toEqual([['f', true]]);
    const stmts = generateDdl(parsed);
    const views = Object.fromEntries(stmts.filter((s) => s.kind === 'view').map((s) => [s.object, s.comment]));
    expect(views).toEqual({ bad: true, calls: true, reads_bad: true });
  });
});

describe('FK 표준 키 검사 일반화 (9회차 5)', () => {
  const blocked = (name: string) => {
    const { base, target, renames } = scenario(name);
    return diffSchemas(base, target, renames).manualTables.map((t) => t.table).sort();
  };

  it('부모 UNIQUE 제거 + 자식 FK 재생성(ON DELETE 변경): 자식·부모 모두 수동 확인 (8.4 error 6125 로 FK 소실 방지)', () => {
    expect(blocked('fk-unique-replace-cascade')).toEqual(['coupon', 'member']);
    const { base, target } = scenario('fk-unique-replace-cascade');
    const reason = diffSchemas(base, target).manualTables[0].reason;
    expect(reason).toContain('restrict_fk_on_non_standard_key=ON');
    expect(reason).toContain('8.0 은 실행 가능');
  });

  it('새 테이블의 FK 가 비UNIQUE 부모 컬럼을 참조하면 그 새 테이블을 막는다', () => {
    const base = dump(tbl('p', '  `id` int NOT NULL,\n  `code` int NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix_code` (`code`)'));
    const target = dump(tbl('p', '  `id` int NOT NULL,\n  `code` int NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix_code` (`code`)'),
      tbl('c', '  `code` int NOT NULL,\n  KEY `fk_c_p` (`code`),\n  CONSTRAINT `fk_c_p` FOREIGN KEY (`code`) REFERENCES `p` (`code`)'));
    expect(diffSchemas(base, target).manualTables.map((t) => t.table)).toEqual(['c']);
  });

  it('표준 키가 TARGET 에 있거나, 비표준 FK 를 아무 문장도 건드리지 않으면 막지 않는다', () => {
    const parent = (extra: string) => tbl('p', `  \`id\` int NOT NULL,\n  \`code\` int NOT NULL,\n  \`n\` int DEFAULT NULL,\n  PRIMARY KEY (\`id\`),\n  KEY \`ix_code\` (\`code\`)${extra}`);
    const child = tbl('c', '  `code` int NOT NULL,\n  KEY `fk_c_p` (`code`),\n  CONSTRAINT `fk_c_p` FOREIGN KEY (`code`) REFERENCES `p` (`code`)');
    // 부모의 무관한 인덱스 추가는 FK 와 관계없다
    expect(diffSchemas(dump(parent(''), child), dump(parent(',\n  KEY `ix_n` (`n`)'), child)).manualTables).toEqual([]);
    expect(blocked('fk-type-widen')).toEqual([]);
  });
});

describe('불완전한 TARGET 의 객체 삭제 차단 (13회차 1)', () => {
  const customers = tbl('customers', '  `id` int NOT NULL,\n  PRIMARY KEY (`id`)');
  const orders = tbl('orders', '  `id` int NOT NULL,\n  `cid` int NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fk_o_c` (`cid`),\n  CONSTRAINT `fk_o_c` FOREIGN KEY (`cid`) REFERENCES `customers` (`id`)');
  const view = 'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v` AS select `customers`.`id` AS `id` from `customers`;';
  const fn = 'DELIMITER ;;\nCREATE DEFINER=`root`@`%` FUNCTION `f`() RETURNS int\n    DETERMINISTIC\nRETURN 1;;\nDELIMITER ;';
  const base = dump(customers, orders, view, fn);
  const drops = (stmts: Statement[]) => stmts.filter((s) => s.op === 'drop');

  it('식별 불가 parse-error 문장이 있는 TARGET: 테이블·뷰·루틴 DROP 은 수동 확인, 사유 표시', () => {
    const target = dump('This is not a schema dump;');
    const d = diffSchemas(base, target);
    expect(d.targetIncomplete).toContain('식별할 수 없는');
    const stmts = generateDdl(d);
    expect(drops(stmts).length).toBeGreaterThan(0);
    expect(drops(stmts).filter((s) => !s.comment).map((s) => s.sql)).toEqual([]);
    expect(stmts.find((s) => s.op === 'drop' && s.object === 'orders' && s.sql.includes('DROP TABLE'))!.sql).toContain('TARGET 이 불완전');
  });

  it('객체가 0개인 TARGET: DROP 을 모두 수동 확인으로 막는다', () => {
    const d = diffSchemas(base, dump('/* Database : x */\nSET NAMES utf8mb4;'));
    expect(d.targetIncomplete).toContain('객체가 없');
    expect(drops(generateDdl(d)).filter((s) => !s.comment)).toEqual([]);
  });

  it('정상 TARGET 의 DROP 은 그대로 실행한다', () => {
    const d = diffSchemas(base, dump(customers));
    expect(d.targetIncomplete).toBeUndefined();
    expect(drops(generateDdl(d)).filter((s) => !s.comment).map((s) => s.object).sort()).toEqual(['f', 'orders', 'orders', 'v']);
  });
});

describe('비결정 DEFAULT 식 ADD COLUMN (14회차 3, 8.4 binlog ROW 실측 error 1674)', () => {
  const base = dump(tbl('t', '  `id` int NOT NULL,\n  PRIMARY KEY (`id`)'));
  const withColumn = (col: string) => dump(tbl('t', `  \`id\` int NOT NULL,\n${col},\n  PRIMARY KEY (\`id\`)`));

  it.each([
    '  `u` binary(16) DEFAULT (uuid_to_bin(uuid()))',
    '  `r` double DEFAULT (rand())',
    '  `s` datetime DEFAULT (sysdate())',
    '  `w` varchar(90) DEFAULT (current_user())',
    "  `c` varchar(90) DEFAULT (concat(_utf8mb4'x',uuid_short()))",
  ])('%s: 기존 테이블에 ADD 하면 수동 확인', (col) => {
    const stmts = generateDdl(diffSchemas(base, withColumn(col)));
    expect(runnable(stmts, ['t'])).toEqual([]);
    expect(stmts[0].sql).toContain('1674');
  });

  it('결정적 식(now()·식)·MODIFY 로 바꾸는 DEFAULT·새 테이블 CREATE 는 그대로 실행한다', () => {
    expect(runnable(generateDdl(diffSchemas(base, withColumn('  `n` datetime DEFAULT (now())'))), ['t'])).toHaveLength(1);
    const withU = (def: string) => dump(tbl('t', `  \`id\` int NOT NULL,\n  \`u\` binary(16) ${def},\n  PRIMARY KEY (\`id\`)`));
    expect(runnable(generateDdl(diffSchemas(withU('DEFAULT NULL'), withU('DEFAULT (uuid_to_bin(uuid()))'))), ['t'])).toHaveLength(1);
    expect(runnable(generateDdl(diffSchemas(dump(), withColumn('  `u` binary(16) DEFAULT (uuid_to_bin(uuid()))'))), ['t'])).toHaveLength(1);
  });
});
