import { describe, expect, it } from 'vitest';
import { generateDdl } from '../src/ddl';
import { diffSchemas } from '../src/diff';
import { parseMdDump } from '../src/parse-md';
import { parseSqlDump } from '../src/parse-dump';
import { fixture, sample, sampleV2 } from './helpers';

const { model, warnings } = parseMdDump(fixture('md/basic.md'));
const orders = model.tables[0];
const col = (name: string) => orders.columns.find((c) => c.name === name)!;

describe('parseMdDump: 기본 형식', () => {
  it('스키마명, Table List의 원래 대소문자', () => {
    expect(model.name).toBe('shop');
    expect(orders).toMatchObject({ name: 'Orders', fidelity: 'partial', unknown: ['checks', 'partition'] });
  });

  it('Columns 표 없는 섹션은 경고와 parseError 테이블', () => {
    expect(warnings).toMatchObject([{ code: 'parse-error', kind: 'table', object: 'broken', message: 'Columns 표 없음' }]);
    const broken = model.tables.find((t) => t.name === 'broken');
    expect(broken?.parseError).toBe('Columns 표 없음');
  });

  it('뷰 섹션 파싱 실패는 kind=view 경고와 parseError 뷰', () => {
    const md = '# s\n\n## v_bad\n**Information**\n|Table type|Charset|Collation|\n|---|---|---|\n|VIEW|utf8mb4|x|\n';
    const r = parseMdDump(md);
    expect(r.warnings).toMatchObject([{ code: 'parse-error', kind: 'view', object: 'v_bad' }]);
    expect(r.model.views.map((v) => [v.name, Boolean(v.parseError)])).toEqual([['v_bad', true]]);
  });

  it('옵션', () => {
    expect(orders.options).toEqual([
      { key: 'ENGINE', value: 'InnoDB' },
      { key: 'COLLATE', value: 'utf8mb4_0900_ai_ci' },
      { key: 'COMMENT', value: "'주문'" },
    ]);
  });

  it('컬럼 기본값·Extra·| 포함 코멘트', () => {
    expect(col('id')).toMatchObject({ type: 'bigint unsigned', nullable: false, autoIncrement: true, comment: '주문 ID' });
    expect(col('status').default).toBe("'ready'");
    expect(col('user_id').unknown).toContain('default');
    expect(col('memo')).toMatchObject({ default: undefined, comment: 'a|b 메모' });
    expect(col('note').default).toBeUndefined();
    expect(col('note').unknown).toContain('default');
    // legacy(0.1.14 이하)는 빈 문자열 기본값도 빈 칸이라 알 수 없다
    expect(col('code').unknown).toContain('default');
    expect(col('flag').default).toBe("b'0'");
    expect(col('uid').default).toBe('(uuid())');
    expect(col('ts').default).toBe('CURRENT_TIMESTAMP(3)');
    expect(col('vc')).toMatchObject({ generated: { expr: '', stored: false } });
    expect(col('vc').unknown).toContain('generated');
    expect(col('sc').generated?.stored).toBe(true);
    expect(col('rem').comment).toBe('line1\nline2 끝');
    expect(col('created_at').nullable).toBe(false);
    expect(col('created_at')).toMatchObject({ default: 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' });
  });

  it('PK는 Key=PRI 컬럼, Normal 인덱스는 종류 미상', () => {
    expect(orders.indexes.map((i) => [i.kind, i.name, i.parts.map((p) => p.column), i.unknown?.includes('kind')])).toEqual([
      ['PRIMARY', 'PRIMARY', ['id', 'created_at'], false],
      ['UNIQUE', 'uk_status', ['status', 'user_id'], false],
      ['INDEX', 'ix_user', ['user_id'], true],
    ]);
    expect(orders.indexes[0].unknown).toContain('partOrder');
  });

  it('FK', () => {
    expect(orders.foreignKeys).toEqual([
      { name: 'fk_user', columns: ['user_id'], refTable: 'users', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
      { name: 'fk_pair', columns: ['status', 'user_id'], refTable: 'users', refColumns: ['a', 'b'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
    ]);
  });

  it('뷰', () => {
    expect(model.views).toMatchObject([{ name: 'v_sales', algorithm: 'UNDEFINED', body: 'select `orders`.`id` AS `id` from `orders`' }]);
  });
});

describe('parseMdDump: td-export 0.1.15+ (v2) Default 형식', () => {
  const items = parseMdDump(fixture('md/v2.md')).model.tables[0];
  const c = (name: string) => items.columns.find((x) => x.name === name)!;

  it('Default 칸을 known 기본값으로 읽는다', () => {
    expect(items.columns.filter((x) => x.unknown?.includes('default')).map((x) => x.name)).toEqual([]);
    expect(items.columns.map((x) => [x.name, x.default])).toEqual([
      ['id', undefined], // auto_increment
      ['name', undefined], // NOT NULL + 빈 칸 = 기본값 없음
      ['nick', 'NULL'],
      ['qty', 'NULL'],
      ['memo', undefined], // text는 DEFAULT NULL이 붙지 않는다
      ['geo', undefined],
      ['doc', 'NULL'], // json은 붙는다
      ['code', "''"],
      ['status', "'ready'"],
      ['uid', '(uuid())'],
      ['ts', 'CURRENT_TIMESTAMP(3)'],
      ['flag', "b'0'"],
      ['vc', undefined], // 생성 컬럼
    ]);
    expect(c('vc').unknown).toContain('generated');
  });

  it("NULL 또는 ''가 없는 파일은 legacy 규칙을 쓴다", () => {
    const legacy = fixture('md/v2.md').replace(/\|NULL\|/g, '||').replace("|''|", '||');
    const t = parseMdDump(legacy).model.tables[0];
    expect(t.columns.find((x) => x.name === 'nick')?.unknown).toContain('default');
  });
});

describe('parseMdDump: 실데이터 교차 검증', () => {
  const sql = parseSqlDump(sample('sql')).model;

  it('같은 스키마의 SQL 모델과 비교 가능한 속성이 모두 같다', () => {
    const md = parseMdDump(sample('md'));
    expect(md.warnings).toEqual([]);
    expect(md.model.tables.map((t) => t.name).sort()).toEqual(sql.tables.map((t) => t.name).sort());
    const d = diffSchemas(sql, md.model);
    expect(d.partial).toBe(true);
    // 0.1.15 샘플은 nullable 컬럼 기본값도 비교한다
    expect(md.model.tables.flatMap((t) => t.columns.filter((c) => c.unknown?.includes('default')).map((c) => `${t.name}.${c.name}`))).toEqual([]);
    expect(d.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => [c.name, c.fields]), indexes: t.indexes.map((i) => [i.op, i.name, i.fields]), moved: t.moved, options: t.options }))).toEqual([]);
  });

  it('MD 쪽 실제 변경은 감지한다', () => {
    const md = parseMdDump(sample('md').replace('|feature|varchar(50)|', '|feature|varchar(80)|')).model;
    const d = diffSchemas(sql, md);
    expect(d.tables.map((t) => [t.name, t.columns.map((c) => [c.name, c.fields])])).toEqual([['ai_usage_log', [['feature', ['type']]]]]);
  });
});

describe('parseMdDump: td-export 0.1.30 (리터럴 인용 기본값·인덱스 종류/정렬·셀 이스케이프)', () => {
  const md = parseMdDump(fixture('md/v3.md'));
  const items = md.model.tables[0];
  const c = (name: string) => items.columns.find((x) => x.name === name)!;
  const ix = (name: string) => items.indexes.find((x) => x.name === name)!;

  it('따옴표로 감싼 기본값은 SQL 리터럴로, 숫자는 SHOW CREATE처럼 인용해 읽는다', () => {
    expect(md.warnings).toEqual([]);
    // MD가 표현할 수 없는 예외: binary 기본값은 information_schema가 16진수(0x6162)로 주고 SHOW CREATE는 문자열('ab')로 준다 → 미상
    expect(items.columns.filter((x) => x.unknown?.includes('default')).map((x) => x.name)).toEqual(['bin']);
    expect(items.columns.map((x) => [x.name, x.default])).toEqual([
      ['id', undefined],
      ['name', "'it''s'"],
      ['path', "'a\\\\b'"],
      ['word', "'NULL'"], // 문자열 'NULL'과 DEFAULT NULL을 구분한다
      ['code', "''"],
      ['nick', 'NULL'],
      ['price', "'0.00'"],
      ['qty', "'0'"],
      ['born', "'2020-01-01'"],
      ['kind', "'a|b'"],
      ['memo', undefined],
      ['g', undefined],
      ['owner_id', 'NULL'],
      ['owner_no', 'NULL'],
      ['cat_id', 'NULL'],
      ['bin', undefined],
      ['uid', '(uuid())'],
      ['ts', 'CURRENT_TIMESTAMP(3)'],
    ]);
  });

  it('셀의 \\|와 <br>을 되돌린다 (Table List·Information·Columns)', () => {
    expect(items.name).toBe('items');
    expect(items.options).toContainEqual({ key: 'COMMENT', value: "'상품|목록'" });
    expect(c('kind')).toMatchObject({ type: "enum('a|b','c')", comment: 'x|y' });
    expect(c('memo').comment).toBe('line1\nline2');
  });

  it('인덱스 종류(Fulltext/Spatial)와 키 파트(DESC·prefix·함수식)를 읽는다', () => {
    expect(ix('ft_name')).toMatchObject({ kind: 'FULLTEXT', parts: [{ column: 'name', desc: false }, { column: 'memo', desc: false }] });
    expect(ix('sp_g')).toMatchObject({ kind: 'SPATIAL', parts: [{ column: 'g', desc: false }] });
    expect(ix('ix_name').parts).toEqual([{ column: 'name', length: 10, desc: true }, { column: 'code', desc: false }]);
    expect(ix('ix_expr').parts).toEqual([
      { expr: 'lower(`name`)', desc: false },
      { expr: "concat(`code`,_utf8mb4'x\\'y')", desc: false }, // information_schema의 이중 이스케이프를 벗긴다
      { expr: '(`qty` + 1)', desc: true },
    ]);
    for (const name of ['ft_name', 'sp_g', 'ix_name', 'ix_expr', 'uk_owner']) expect(ix(name).unknown).not.toContain('partDetails');
    expect(ix('ix_name').unknown).toContain('kind'); // Normal은 여전히 종류 미상
  });

  it('다중 컬럼 FK 한 줄, 다른 스키마 참조', () => {
    expect(items.foreignKeys).toEqual([
      { name: 'fk_cat', columns: ['cat_id'], refSchema: 'common', refTable: 'categories', refColumns: ['id'], onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
      { name: 'fk_owner', columns: ['owner_id', 'owner_no'], refTable: 'owners', refColumns: ['id', 'no'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
    ]);
  });

  it('같은 테이블의 SQL(SHOW CREATE) 모델과 비교 가능한 속성이 모두 같다', () => {
    const sql = parseSqlDump(fixture('md/v3.sql'));
    expect(sql.warnings).toEqual([]);
    const d = diffSchemas(sql.model, md.model);
    expect(d.tables).toEqual([]);
  });

  it('0.1.21 이전 파일의 \\ 로 끝나는 셀은 이스케이프로 보지 않는다', () => {
    const md = fixture('md/v2.md').replace("|qty|int|YES|NULL|||||", "|qty|int|YES|NULL|||||C:\\|");
    const t = parseMdDump(md).model.tables[0];
    expect(t.columns.find((x) => x.name === 'qty')).toMatchObject({ default: 'NULL', comment: 'C:\\' });
  });

  it("따옴표 없는 문자열 기본값이 있으면 0.1.15로 보고 리터럴 따옴표 기본값은 그대로 읽는다 ('x' 2개)", () => {
    const rows = "|a|varchar(5)|NO|'x'|utf8mb4|utf8mb4_0900_ai_ci||||\n|b|varchar(5)|NO|'y'|utf8mb4|utf8mb4_0900_ai_ci||||\n";
    const t = parseMdDump(fixture('md/v2.md').replace('|vc|', `${rows}|vc|`)).model.tables[0];
    expect(t.columns.find((x) => x.name === 'a')?.default).toBe("'''x'''");
    expect(t.columns.find((x) => x.name === 'status')?.default).toBe("'ready'");
    expect(t.columns.find((x) => x.name === 'nick')?.default).toBe('NULL'); // v2 판별은 유지
  });

  it('따옴표 없는 문자열 기본값이 없으면 따옴표 Default 1개만으로도 0.1.30으로 본다 (인덱스 상세 포함)', () => {
    const quoted = fixture('md/v2.md').replace('|ready|', "|'ready'|");
    const t = parseMdDump(quoted).model.tables[0];
    expect(t.columns.find((x) => x.name === 'status')?.default).toBe("'ready'");
    expect(t.columns.find((x) => x.name === 'nick')?.default).toBe('NULL');
    // 숫자 컬럼 인덱스뿐이어도 0.1.30 규칙으로 DESC 유무를 비교한다
    const base = parseMdDump(`${quoted}\n**Index**\n- [Normal]ix(qty)\n`).model;
    const target = parseMdDump(`${quoted}\n**Index**\n- [Normal]ix(qty DESC)\n`).model;
    expect(diffSchemas(base, target).tables.map((x) => x.indexes.map((i) => [i.name, i.fields]))).toEqual([[['ix', ['parts']]]]);
  });

  it('0.1.19~0.1.20(인덱스 상세는 있고 기본값은 따옴표 없음)도 읽는다', () => {
    const t = parseMdDump(fixture('md/v2.md') + '\n**Index**\n- [Fulltext]ft(name)\n- [Normal]ix(qty DESC)\n').model.tables[0];
    expect(t.columns.find((x) => x.name === 'status')?.default).toBe("'ready'");
    expect(t.indexes.filter((i) => i.kind !== 'PRIMARY').map((i) => [i.name, i.kind, i.parts[0].desc, i.unknown?.includes('partDetails')])).toEqual([
      ['ft', 'FULLTEXT', false, false],
      ['ix', 'INDEX', true, false],
    ]);
  });
});

describe('parseMdDump: td-export 0.1.30 실데이터 교차 검증', () => {
  const sql = parseSqlDump(sampleV2('sql')).model;
  const md = parseMdDump(sampleV2('md'));

  it('같은 덤프의 SQL 모델과 비교 가능한 속성이 모두 같다', () => {
    expect(md.warnings).toEqual([]);
    expect(md.model.tables.map((t) => t.name).sort()).toEqual(sql.tables.map((t) => t.name).sort());
    expect(md.model.tables.flatMap((t) => t.columns.filter((c) => c.unknown?.includes('default')).map((c) => `${t.name}.${c.name}`))).toEqual([]);
    const d = diffSchemas(sql, md.model);
    expect(d.partial).toBe(true);
    expect(d.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => [c.name, c.fields]), indexes: t.indexes.map((i) => [i.op, i.name, i.fields]), moved: t.moved, options: t.options }))).toEqual([]);
  });

  it('0.1.15 MD와 달리 FULLTEXT 종류와 DESC 키 파트를 비교한다', () => {
    const t = md.model.tables.find((x) => x.name === 'grammar')!;
    expect(t.indexes.find((i) => i.name === 'grammar_title_FTX')).toMatchObject({ kind: 'FULLTEXT' });
    expect(t.indexes.find((i) => i.name === 'grammar_user_id_create_at_IDX')?.parts.map((p) => p.desc)).toEqual([false, true]);
    // SQL에서 DESC를 빼면 MD와 차이로 잡힌다
    const changed = parseSqlDump(sampleV2('sql').replace('KEY `grammar_user_id_create_at_IDX` (`user_id`,`create_at` DESC)', 'KEY `grammar_user_id_create_at_IDX` (`user_id`,`create_at`)')).model;
    const d = diffSchemas(changed, md.model);
    expect(d.tables.map((x) => [x.name, x.indexes.map((i) => [i.name, i.fields])])).toEqual([['grammar', [['grammar_user_id_create_at_IDX', ['parts']]]]]);
  });
});

describe('parseMdDump: 셀 끝 백슬래시·식별자 백슬래시·Normal↔Fulltext', () => {
  const v3 = fixture('md/v3.md');

  it('이스케이프 파일에서 \\ 로 끝나는 마지막 셀과 \\| 로 끝나는 셀을 구분한다 (C:\\ ≠ C:|)', () => {
    const md = v3.replace('|qty|int|NO|0||||||', '|qty|int|NO|0|||||C:\\|').replace('|price|decimal(5,2)|NO|0.00||||||', '|price|decimal(5,2)|NO|0.00|||||C:\\||');
    const t = parseMdDump(md).model.tables[0];
    expect(t.columns.find((x) => x.name === 'qty')?.comment).toBe('C:\\');
    expect(t.columns.find((x) => x.name === 'price')?.comment).toBe('C:|');
  });

  it('인덱스 키 파트의 컬럼 식별자는 백슬래시를 보존하고 함수식만 디코드한다', () => {
    const md = v3.replace('|id|bigint unsigned|', '|a\\b|int|YES|NULL||||||\n|ab|int|YES|NULL||||||\n|id|bigint unsigned|')
      .replace('- [Normal]fk_cat(cat_id)', "- [Normal]fk_cat(cat_id)\n- [Normal]ix_bs(a\\b DESC,ab,concat(_utf8mb4\\'a\\\\\\'b\\'))");
    const ix = parseMdDump(md).model.tables[0].indexes.find((i) => i.name === 'ix_bs')!;
    expect(ix.parts).toEqual([{ column: 'a\\b', desc: true }, { column: 'ab', desc: false }, { expr: "concat(_utf8mb4'a\\'b')", desc: false }]);
  });

  it('Normal은 INDEX/UNIQUE만 모호하다: Fulltext로 바뀌면 diff·DDL이 나오고 Unique로는 나오지 않는다', () => {
    const base = parseMdDump(v3).model;
    const fulltext = parseMdDump(v3.replace('- [Normal]fk_cat(cat_id)', '- [Fulltext]fk_cat(cat_id)')).model;
    const d = diffSchemas(base, fulltext);
    expect(d.tables.map((x) => x.indexes.map((i) => [i.name, i.fields]))).toEqual([[['fk_cat', ['kind']]]]);
    expect(generateDdl(d).map((s) => s.sql).join('\n')).toContain('ADD FULLTEXT INDEX `fk_cat`');
    const unique = parseMdDump(v3.replace('- [Normal]fk_cat(cat_id)', '- [Unique]fk_cat(cat_id)')).model;
    expect(diffSchemas(base, unique).tables).toEqual([]);
  });

  it('SQL FULLTEXT → MD Normal은 BASE 종류로 채우지 않고 일반 INDEX로 다시 만든다', () => {
    const sql = parseSqlDump(fixture('md/v3.sql')).model;
    const md = parseMdDump(v3.replace('- [Fulltext]ft_name(name,memo)', '- [Normal]ft_name(name,memo)')).model;
    const d = diffSchemas(sql, md);
    expect(d.tables.map((x) => x.indexes.map((i) => [i.name, i.fields]))).toEqual([[['ft_name', ['kind']]]]);
    const ddl = generateDdl(d).map((s) => s.sql).join('\n');
    expect(ddl).toContain('ADD INDEX `ft_name`');
    expect(ddl).not.toContain('ADD FULLTEXT');
  });
});

