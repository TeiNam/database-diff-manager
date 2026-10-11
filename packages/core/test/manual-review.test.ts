import { describe, expect, it } from 'vitest';
import { generateDdl, renderDdl, type Statement } from '../src/ddl';
import { diffSchemas, type RenameMapping } from '../src/diff';
import { parseSqlDump } from '../src/parse-dump';
import { parseMdDump } from '../src/parse-md';

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
    + '|id|int|NO||||PRI|||\n|b|int|NO||||||\n';
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
