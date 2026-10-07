import { describe, expect, it } from 'vitest';
import { isLosslessConversion } from '../src/charset-ddl';
import { generateDdl, renderDdl } from '../src/ddl';
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
