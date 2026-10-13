import { describe, expect, it } from 'vitest';
import { applyScript, MYSQL_DEFAULTS, printSqlDump, type ApplyDefaults, type ApplyError, type ApplyOptions, type ApplyResult } from '../../src';
import { canonicalJson } from '../../src/canonical';
import type { Routine, SchemaModel } from '../../src/model';
import { parseSqlDump } from '../../src/parse-dump';
import { fixture, tdExport } from '../helpers';

const same = (a: SchemaModel, b: SchemaModel) => canonicalJson([a.tables, a.views, a.routines]) === canonicalJson([b.tables, b.views, b.routines]);

// Task 6·7(CREATE TABLE·PROCEDURE 적용)이 합쳐지기 전에는 applyScript 가 이 문장들을 받지 못한다. 합쳐진 뒤에는 이 가드가 걸리지 않는다
const CREATE_NOT_YET = /^지원하지 않는 문장입니다: CREATE /;

// 출력 → 다시 읽기: 경고 없이, 완전한 덤프로, 객체 순서까지 같은 모델
function roundTrip(model: SchemaModel) {
  const again = parseSqlDump(printSqlDump(model));
  expect(again.warnings).toEqual([]);
  expect(again.model.evidence?.level).toBe('complete');
  expect(same(again.model, model)).toBe(true);
  return again;
}

const shopModel = () => parseSqlDump(fixture('td-export-0152/shop.sql')).model;
const procedure = (body: string, sqlMode?: string): Routine => ({ kind: 'procedure', name: 'p', params: '', characteristics: {}, body, ...(sqlMode === undefined ? {} : { sqlMode }) });
const withRoutines = (...routines: Routine[]): SchemaModel => ({ ...shopModel(), routines });

describe('printSqlDump', () => {
  it('td-export 0.1.52 형식: 완전한 덤프로 읽히고, 경고 없이 같은 모델로 돌아온다 (루틴·뷰 포함)', (ctx) => {
    const shop = parseSqlDump(fixture('td-export-0152/shop.sql')).model;
    const r = applyScript(shop, "CREATE TABLE extra (id INT PRIMARY KEY, label VARCHAR(10) COMMENT 'it''s');\nDELIMITER $$\nCREATE PROCEDURE p_x() BEGIN SELECT ';;'; END$$\nDELIMITER ;", { schemaName: 'shop' });
    if (!r.ok && CREATE_NOT_YET.test(r.error.reason)) ctx.skip(r.error.reason);
    if (!r.ok) throw new Error(r.error.reason);
    const text = printSqlDump(r.model);
    expect(text.startsWith('/* Database : shop */\nSET NAMES utf8mb4;')).toBe(true);
    const again = parseSqlDump(text);
    expect(again.warnings).toEqual([]);
    expect(again.model.evidence?.level).toBe('complete');
    expect(same(again.model, r.model)).toBe(true);
  });

  it("스키마 이름에 '*/'·줄바꿈이 있으면 머리말을 쓸 수 없어 실패한다", () => {
    expect(() => printSqlDump({ name: 'a*/b', tables: [], views: [], routines: [] })).toThrow();
  });

  it('스키마 이름 검사는 이유를 알려 주고, 줄바꿈도 막는다', () => {
    for (const name of ['a*/b', 'a\nb', 'a\r']) {
      expect(() => printSqlDump({ name, tables: [], views: [], routines: [] }), JSON.stringify(name)).toThrow(/스키마 이름/);
    }
  });

  it('td-export 0.1.52 픽스처를 그대로 출력해도 객체 순서까지 같은 모델로 돌아오고, 입력 모델은 바뀌지 않는다', () => {
    const shop = shopModel();
    const before = structuredClone(shop);
    roundTrip(shop);
    expect(shop).toEqual(before);
  });

  it('ALTER 로 바뀐 모델: 따옴표가 든 COMMENT 컬럼도 경고 없이 같은 모델로 돌아온다', () => {
    const r = applyScript(shopModel(), "ALTER TABLE orders ADD COLUMN label VARCHAR(10) COMMENT 'it''s';", { schemaName: 'shop' });
    if (!r.ok) throw new Error(r.error.reason);
    roundTrip(r.model);
  });

  it('루틴 구분자: ;; 가 본문에 있으면 $$, 둘 다 있으면 //, 셋 다 있으면 쓸 수 없어 실패한다', () => {
    const semicolons = "BEGIN SELECT ';;'; END";
    const dollars = "BEGIN SELECT ';;', '$$'; END";
    const all = "BEGIN SELECT ';;', '$$', '//'; END";
    expect(printSqlDump(withRoutines(procedure('BEGIN SELECT 1; END')))).toContain('DELIMITER ;;\n');
    roundTrip(withRoutines(procedure(semicolons)));
    expect(printSqlDump(withRoutines(procedure(semicolons)))).toContain('DELIMITER $$\n');
    roundTrip(withRoutines(procedure(dollars)));
    expect(printSqlDump(withRoutines(procedure(dollars)))).toContain('DELIMITER //\n');
    expect(() => printSqlDump(withRoutines(procedure(all)))).toThrow(/구분자/);
  });

  it('본문이 구분자의 첫 글자로 끝나면(END; 뒤에 ;;) 끝 표시가 앞당겨 읽히므로 다른 구분자를 쓴다', () => {
    const model = withRoutines(procedure('BEGIN SELECT 1; END;'));
    const text = printSqlDump(model);
    expect(text).toContain('END;$$\n');
    const again = parseSqlDump(text);
    expect(again.warnings.filter((w) => w.code === 'non-schema')).toEqual([]);
    expect(again.model.tables.map((t) => t.name)).toEqual(model.tables.map((t) => t.name));
    expect(again.model.routines.map((x) => x.name)).toEqual(['p']);
  });

  it("본문이 '--' 줄 주석으로 끝나는 루틴도 끝맺음이 주석에 먹히지 않아 경고 없이 같은 모델로 돌아온다", () => {
    roundTrip(withRoutines(procedure('BEGIN SELECT 1; END -- tail')));
  });

  it("본문이 '#' 줄 주석으로 끝나는 루틴도 끝맺음이 주석에 먹히지 않아 경고 없이 같은 모델로 돌아온다", () => {
    roundTrip(withRoutines(procedure('BEGIN SELECT 1; END # tail')));
  });

  it('줄 주석으로 끝나는 루틴 뒤의 테이블·뷰는 왕복해도 모두 남는다 (루틴이 파일 끝까지 삼키지 않는다)', () => {
    for (const comment of ['-- tail', '# tail']) {
      const model = withRoutines(procedure(`BEGIN SELECT 1; END ${comment}`));
      const again = parseSqlDump(printSqlDump(model));
      expect(again.model.routines.map((x) => x.name), comment).toEqual(['p']);
      expect(again.model.tables.map((t) => t.name), comment).toEqual(model.tables.map((t) => t.name));
      expect(again.model.views.map((v) => v.name), comment).toEqual(model.views.map((v) => v.name));
    }
  });

  it('파싱 실패한 테이블·뷰의 원문이 줄 주석으로 끝나도 세미콜론이 주석에 먹히지 않아 뒤의 객체가 남는다', () => {
    const failed = parseSqlDump(tdExport('CREATE TABLE `broken` (`id` int, ???) -- note\n;\n\nCREATE VIEW `broken_v` AS select ??? -- note\n;')).model;
    expect([failed.tables.map((t) => t.name), failed.views.map((v) => v.name)]).toEqual([['broken'], ['broken_v']]);
    const shop = shopModel();
    const model: SchemaModel = { ...shop, tables: [...failed.tables, ...shop.tables], views: [...failed.views, ...shop.views] };
    const again = parseSqlDump(printSqlDump(model));
    expect(again.model.tables.map((t) => t.name)).toEqual(model.tables.map((t) => t.name));
    expect(again.model.views.map((v) => v.name)).toEqual(model.views.map((v) => v.name));
    expect(same(again.model, model)).toBe(true);
  });

  it('루틴 SQL_MODE: 있으면 저장·설정·복원 줄을 붙이고(빈 문자열 포함), 없으면 붙이지 않는다', () => {
    const none = printSqlDump(withRoutines(procedure('BEGIN SELECT 1; END')));
    expect(none).not.toContain('OLD_ROUTINE_SQL_MODE');
    roundTrip(withRoutines(procedure('BEGIN SELECT 1; END')));
    const empty = printSqlDump(withRoutines(procedure('BEGIN SELECT 1; END', '')));
    expect(empty).toContain("SET @OLD_ROUTINE_SQL_MODE = @@SQL_MODE, SQL_MODE = '';");
    expect(parseSqlDump(empty).model.routines[0].sqlMode).toBe('');
    roundTrip(withRoutines(procedure('BEGIN SELECT 1; END', 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION')));
  });

  it("객체 이름에 '*/'·줄바꿈이 있으면 머리 주석만 빼고 정의는 그대로 출력한다", () => {
    for (const name of ['a*/b', 'a\nb']) {
      const table = parseSqlDump(tdExport(`CREATE TABLE \`${name}\` (\n  \`id\` int NOT NULL,\n  PRIMARY KEY (\`id\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`)).model.tables[0];
      expect(table.name, JSON.stringify(name)).toBe(name);
      const text = printSqlDump({ ...shopModel(), routines: [], views: [], tables: [table] });
      expect(text, JSON.stringify(name)).not.toContain('/* Table : a');
      expect(parseSqlDump(text).model.tables.map((t) => t.name), JSON.stringify(name)).toEqual([name]);
    }
  });

  it('@tdm/core 공개 API: applyScript·printSqlDump·MYSQL_DEFAULTS 와 ApplyDefaults·ApplyOptions·ApplyResult·ApplyError 타입', () => {
    const defaults: ApplyDefaults = MYSQL_DEFAULTS;
    const opts: ApplyOptions = { schemaName: 'shop', defaults };
    const result: ApplyResult = applyScript(shopModel(), 'SELECT 1;', opts);
    const error: ApplyError | undefined = result.ok ? undefined : result.error;
    expect(defaults).toEqual({ charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' });
    expect(error?.index).toBe(1);
    expect(typeof printSqlDump).toBe('function');
  });
});
