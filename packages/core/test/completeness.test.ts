// TARGET 완전성 판정 (14회차 1): td-export 의 완전한 스키마 출력임을 적극적으로 확인할 수 있을 때만 파괴적 문장을 실행 문장으로 낸다
import { describe, expect, it } from 'vitest';
import { generateDdl, type Statement } from '../src/ddl';
import { diffSchemas } from '../src/diff';
import type { SchemaModel } from '../src/model';
import { parseSqlDump } from '../src/parse-dump';
import { parseMdDump } from '../src/parse-md';
import { fixture } from './helpers';

const TD_EXPORT_FIXTURES = ['td-export-0115/sample-app', 'td-export-0130/sample-app', 'td-export-0136/escapes', 'td-export-0152/escapes', 'td-export-0152/shop'];
const codes = (r: { warnings: { code: string }[] }) => r.warnings.map((w) => w.code);
// 실행 문장(수동 확인·안내 주석 제외) 중 데이터·객체를 지우는 문장
const DESTRUCTIVE = /\bDROP\s+(TABLE|VIEW|FUNCTION|PROCEDURE|COLUMN)\b/i;
const destructive = (base: SchemaModel, target: SchemaModel): string[] =>
  generateDdl(diffSchemas(base, target)).filter((s: Statement) => !s.comment && DESTRUCTIVE.test(s.sql)).map((s) => s.sql);

describe('td-export 실출력은 완전한 스키마로 판정한다 (회귀)', () => {
  it.each(TD_EXPORT_FIXTURES)('%s.sql / .md', (name) => {
    for (const parsed of [parseSqlDump(fixture(`${name}.sql`)), parseMdDump(fixture(`${name}.md`))]) {
      expect(parsed.model.incomplete).toBeUndefined();
      expect(codes(parsed).filter((c) => c === 'non-schema' || c === 'incomplete')).toEqual([]);
    }
  });
});

describe('SQL 완전성', () => {
  const base = parseSqlDump(fixture('td-export-0152/shop.sql')).model;
  const full = fixture('td-export-0152/shop.sql');

  it('CREATE 와 td-export 의 SET 밖 문장(ALTER 만 든 파일 등)은 비스키마로 표시한다 (Codex 재현)', () => {
    const r = parseSqlDump('ALTER TABLE `orders` ADD COLUMN `x` int;\n');
    expect(codes(r)).toContain('non-schema');
    expect(r.model.incomplete?.reason).toContain('스키마 정의가 아닌');
    expect(destructive(base, r.model)).toEqual([]);
    expect(codes(parseSqlDump('CREATE TABLE `a` (\n  `x` int\n);\nINSERT INTO `a` VALUES (1);\n'))).toContain('non-schema');
  });

  it('마지막 CREATE 가 구분자 없이 끊기면 불완전 — 끊긴 객체는 파싱 실패로 남긴다 (Claude 재현)', () => {
    const cut = full.slice(0, full.indexOf('CREATE TABLE `orders`') + 60);
    const r = parseSqlDump(cut);
    expect(r.model.incomplete).toMatchObject({ objects: ['orders'] });
    expect(r.model.tables.find((t) => t.name === 'orders')?.parseError).toBeDefined();
    expect(destructive(base, r.model)).toEqual([]);
  });

  it('문자열·주석 안에서 끊겨도 예외 없이 불완전으로 본다', () => {
    const head = '/* Database : shop */\nCREATE TABLE `a` (\n  `x` int\n);\n';
    for (const tail of ["CREATE TABLE `b` (\n  `s` varchar(9) DEFAULT 'ab", '/* Table : b', "SET SQL_MODE = 'AN"]) {
      const r = parseSqlDump(head + tail);
      expect(r.model.incomplete, tail).toBeDefined();
      expect(r.model.tables.map((t) => t.name)).toContain('a');
    }
  });

  it('헤더가 저장한 세션 변수(@OLD_…)를 복원하는 트레일러가 없으면 불완전 (0.1.30+)', () => {
    const cut = full.slice(0, full.indexOf('/* Table : big_paid */'));
    const r = parseSqlDump(cut);
    expect(r.model.incomplete?.reason).toContain('트레일러');
    expect(destructive(base, r.model)).toEqual([]);
    // 0.1.15 형식(헤더 SET 없음)은 트레일러를 내지 않는다
    expect(parseSqlDump(fixture('td-export-0115/sample-app.sql')).model.incomplete).toBeUndefined();
  });

  it('완전한 TARGET 의 DROP 은 그대로 실행한다', () => {
    const target = parseSqlDump(full.replace(/\/\* Table : big_paid \*\/\n[^\n]+\n/, '')).model;
    expect(target.incomplete).toBeUndefined();
    expect(destructive(base, target)).toEqual(['DROP VIEW `big_paid`']);
  });
});

describe('MD 완전성', () => {
  const md = fixture('td-export-0152/shop.md');
  const base = parseSqlDump(fixture('td-export-0152/shop.sql')).model;

  it('td-export MD 구조(제목·## Table List)가 없으면 비스키마 (Codex 재현)', () => {
    const r = parseMdDump('# Release notes\n## Changes\nSome notes\n');
    expect(codes(r)).toContain('non-schema');
    expect(r.model.incomplete).toBeDefined();
    expect(destructive(base, r.model)).toEqual([]);
  });

  it('마지막 표가 중간에 끝나면 불완전 — 그 객체 문장은 실행하지 않는다 (Claude 재현)', () => {
    const cut = md.slice(0, md.indexOf('|amount|decimal'));
    const target = parseMdDump(cut).model;
    expect(target.incomplete).toMatchObject({ objects: ['orders'] });
    expect(destructive(base, target)).toEqual([]);
  });

  it('Table List 에 있는데 섹션이 없는 객체가 있으면 불완전 (Claude 재현)', () => {
    const target = parseMdDump(md.replace(/## order_audit[\s\S]*?(?=## orders)/, '')).model;
    expect(target.incomplete?.reason).toContain('order_audit');
    expect(destructive(base, target)).toEqual([]);
  });

  it('완전한 MD TARGET 은 불완전 표시가 없다', () => {
    expect(parseMdDump(md).model.incomplete).toBeUndefined();
  });
});
