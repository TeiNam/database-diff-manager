import { describe, expect, it } from 'vitest';
import { diffSchemas } from '../src/diff';
import { parseSqlDump, splitStatements } from '../src/parse-dump';
import { parseCreateView } from '../src/parse-view';
import { fixture, sample, sampleV2 } from './helpers';

describe('parseCreateView', () => {
  it('옵션과 본문을 나누고 DEFINER는 버린다', () => {
    expect(parseCreateView(fixture('view.sql'))).toEqual({
      kind: 'view',
      name: 'v_daily',
      algorithm: 'UNDEFINED',
      security: 'DEFINER',
      checkOption: 'CASCADED',
      body: 'select `o`.`id` AS `id` from `orders` `o`',
      fidelity: 'full',
    });
  });
});

describe('splitStatements', () => {
  it('문자열 안의 ;는 무시하고 앞쪽 주석은 제외한다', () => {
    const text = "/* Database : s */\n/* Table : a */\nCREATE TABLE `a` (`x` int COMMENT 'a;b');\n\n/* Table : b */\nCREATE TABLE `b` (`y` int);\n";
    expect(splitStatements(text)).toEqual([
      { ddl: "CREATE TABLE `a` (`x` int COMMENT 'a;b')", line: 3 },
      { ddl: 'CREATE TABLE `b` (`y` int)', line: 6 },
    ]);
  });
});

describe('parseSqlDump', () => {
  it('실패한 객체만 parseError로 남기고 나머지는 계속 파싱한다', () => {
    const text = '/* Database : s */\nCREATE TABLE `bad` (`a` int NOT NULL FOO);\nCREATE TABLE `ok` (\n  `b` int\n);\n';
    const { model, warnings } = parseSqlDump(text);
    expect(model.name).toBe('s');
    expect(model.tables.map((t) => [t.name, Boolean(t.parseError)])).toEqual([['bad', true], ['ok', false]]);
    expect(model.tables[0].rawDdl).toContain('FOO');
    expect(warnings).toEqual([{ code: 'parse-error', kind: 'table', object: 'bad', line: 2, message: "알 수 없는 컬럼 속성 'FOO' (줄 1)" }]);
  });

  it('경고에 code와 kind를 단다: 뷰 파싱 실패, 왕복 불일치', () => {
    const text = 'CREATE VIEW `v` AS;\nCREATE TABLE `t` (\n  `a` int    NOT NULL\n);\n';
    const { warnings } = parseSqlDump(text);
    expect(warnings.map((w) => [w.code, w.kind, w.object])).toEqual([['parse-error', 'view', 'v'], ['round-trip', 'table', 't']]);
  });

  it('뷰를 구분한다', () => {
    const { model } = parseSqlDump(fixture('view.sql') + ';');
    expect(model.views.map((v) => v.name)).toEqual(['v_daily']);
  });

  it('실데이터 샘플 33개 테이블을 오류 없이 파싱한다', () => {
    const { model } = parseSqlDump(sample('sql'));
    expect(model.name).toBe('sample-app');
    expect(model.tables).toHaveLength(33);
    expect(model.tables.filter((t) => t.parseError).map((t) => [t.name, t.parseError])).toEqual([]);
    expect(model.tables.filter((t) => t.partition)).toHaveLength(6);
    const chat = model.tables.find((t) => t.name === 'chat_history')!;
    expect(chat.partition!.partitions.at(-1)!.name).toBe('pmax');
  });

  it('; 빠진 SET 뒤의 CREATE는 버리지 않고 parse-error로 남긴다', () => {
    const { model, warnings } = parseSqlDump('SET FOREIGN_KEY_CHECKS=0\nCREATE TABLE `a` (\n  `x` int\n);\n');
    expect(model.tables.map((t) => t.name)).toEqual(['a']);
    expect(warnings.map((w) => [w.code, w.object])).toEqual([['parse-error', 'a']]);
  });

  it('같은 줄에 붙은 CREATE도 parse-error로 남기고, 문자열·주석 안의 CREATE는 건너뛴다', () => {
    const { model, warnings } = parseSqlDump("SET FOREIGN_KEY_CHECKS=0 CREATE TABLE `a` (`x` int);\nSET @v = 'CREATE' /* CREATE */;\n");
    expect(model.tables.map((t) => t.name)).toEqual(['a']);
    expect(warnings.map((w) => [w.code, w.object])).toEqual([['parse-error', 'a']]);
  });

  it('SET 문(td-export 0.1.30 FOREIGN_KEY_CHECKS)은 경고 없이 건너뛰고, 다른 문장은 계속 경고한다', () => {
    const text = '/* Database : s */\nSET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;\n\nCREATE TABLE `t` (\n  `a` int\n);\nset names utf8mb4;\nDROP TABLE `x`;\nSET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;\n';
    const { model, warnings } = parseSqlDump(text);
    expect(model.tables.map((t) => t.name)).toEqual(['t', 'x']);
    expect(warnings.map((w) => [w.code, w.object, w.line])).toEqual([['parse-error', 'x', 8]]);
  });
});

describe('parseSqlDump: td-export 0.1.30 실데이터', () => {
  const v1 = parseSqlDump(sample('sql'));
  const v2 = parseSqlDump(sampleV2('sql'));

  it('경고 없이 0.1.15와 같은 수의 테이블·뷰를 파싱한다', () => {
    expect(v2.warnings).toEqual([]);
    expect(v2.model.name).toBe('sample-app');
    expect(v2.model.tables).toHaveLength(v1.model.tables.length);
    expect(v2.model.views).toHaveLength(v1.model.views.length);
  });

  it('같은 DB의 0.1.15 SQL과 차이가 없다', () => {
    const d = diffSchemas(v1.model, v2.model);
    expect(d.partial).toBe(false);
    expect([d.tables, d.views]).toEqual([[], []]);
  });
});

