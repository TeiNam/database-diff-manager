import { diffSchemas, parseMdDump, parseSqlDump, type SchemaModel } from '@tdm/core';
import { describe, expect, it } from 'vitest';
import type { DiffResponse, VersionMeta } from '../src/api/types';
import { PARTIAL_MESSAGE } from '../src/features/diff/messages';
import { buildReportHtml, REPORT_CSP } from '../src/features/report/build-report';
import { filterReportData, formatGeneratedAt, reportFileName, reportTitle, viewLabel, type ReportOptions } from '../src/features/report/report-meta';

// td-export 0.1.52 형식의 루틴 구간
const routine = (ddl: string) =>
  `SET @OLD_ROUTINE_SQL_MODE = @@SQL_MODE, SQL_MODE = 'STRICT_TRANS_TABLES';\nDELIMITER ;;\n${ddl};;\nDELIMITER ;\nSET SQL_MODE = @OLD_ROUTINE_SQL_MODE;\n`;
const TAX = (rate: string) => routine(`CREATE DEFINER=\`root\`@\`%\` FUNCTION \`tax\`(a int) RETURNS int\n    DETERMINISTIC\nRETURN a * ${rate}`);
// 이스케이프 확인용: 객체 이름과 COMMENT 에 <script>·"·& 를 넣는다
const EVIL_TABLE = '<script>x"&';
const EVIL_COMMENT = 'a "q" & <script>alert(1)</script>';
const base = parseSqlDump('CREATE TABLE `orders` (\n  `x` int\n);\n' + TAX('1')).model;
const target = parseSqlDump(`CREATE TABLE \`orders\` (\n  \`x\` bigint COMMENT '${EVIL_COMMENT}'\n);\nCREATE TABLE \`${EVIL_TABLE}\` (\n  \`y\` int\n);\n${TAX('2')}`).model;
const MD = 'shop\n=====\n\n## Table List\n- [orders ()](#orders)\n\n## orders\n**Information**\n|Table type|Engine|Row format|Collate|Comment|\n|---|---|---|---|---|\n|BASE TABLE|InnoDB|Dynamic|utf8mb4_0900_ai_ci||\n\n**Columns**\n|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|\n|---|---|---|---|---|---|---|---|---|\n|x|bigint|YES|NULL||||||\n';
// 20줄 테이블의 가운데 한 줄만 바뀌어 화면이라면 접히는 동일 구간이 생긴다
const columns = (change?: number) => Array.from({ length: 20 }, (_, i) => `  \`c${i}\` int${i === change ? ' NOT NULL' : ''},`).join('\n');
const longTable = (change?: number) => parseSqlDump(`CREATE TABLE \`wide\` (\n${columns(change)}\n  \`id\` int\n);\n`).model;

const meta = (id: number, versionNo: number): VersionMeta => ({
  id, schemaId: 7, databaseId: 1, databaseName: 'prod-db', schemaName: 'shop', versionNo, sourceFormat: 'sql',
  sourceFilename: `shop_v${versionNo}.sql`, note: null, uploadedBy: 'kim', uploadedAt: '2026-10-15T01:02:00.000Z',
});
const response = (b: SchemaModel, t: SchemaModel, extra: Partial<DiffResponse> = {}): DiffResponse => ({
  base: meta(11, 1), target: meta(12, 2), baseModel: b, targetModel: t, diff: diffSchemas(b, t), statements: [], ddl: '', renames: [], ...extra,
});
const DATA = response(base, target);
const OPTIONS: ReportOptions = { mode: 'sql', layout: 'split', generatedAt: new Date(2026, 9, 16, 14, 5), generatedBy: 'park', appVersion: '9.9.9-test' };
const render = (data: DiffResponse, opts: Partial<ReportOptions> = {}) => buildReportHtml(data, { ...OPTIONS, ...opts });
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const objectOf = (doc: Document, label: string) => [...doc.querySelectorAll('details')].find((d) => d.getAttribute('aria-label') === label);
const colCount = (el: Element | undefined) => el?.querySelectorAll('table[aria-label="SQL diff"] col').length;

describe('리포트 메타', () => {
  it('파일 이름: {DB}_{스키마}_v{BASE}-v{TARGET}_{YYYYMMDD-HHmm}.html, 쓸 수 없는 글자는 _', () => {
    const names = { databaseName: 'db/1:2', schemaName: 'a*b?"<>|\\c\u0001d' };
    const data = { ...DATA, target: { ...DATA.target, ...names, versionNo: 10 }, base: { ...DATA.base, ...names, versionNo: 3 } };
    expect(reportFileName(data, new Date(2026, 0, 5, 9, 7))).toBe('db_1_2_a_b______c_d_v3-v10_20260105-0907.html');
    expect(reportFileName(DATA, OPTIONS.generatedAt)).toBe('prod-db_shop_v1-v2_20261016-1405.html');
  });

  it('제목·보기 방식·만든 시각', () => {
    expect(reportTitle(DATA)).toBe('prod-db › shop 비교 리포트');
    expect([viewLabel('sql', 'split'), viewLabel('sql', 'unified'), viewLabel('grid', 'split')]).toEqual(['SQL Split', 'SQL Unified', '표']);
    expect(formatGeneratedAt(OPTIONS.generatedAt)).toMatch(/^2026-10-16 14:05 \(.+, UTC[+-]\d{2}:\d{2}\)$/);
  });
});

describe('buildReportHtml', () => {
  it('문서 머리: doctype·lang·밝은 테마·charset·viewport·CSP meta 와 style 이 있고 script·버튼이 없다', () => {
    const html = render(DATA);
    expect(html.startsWith('<!doctype html>\n<html lang="ko" data-theme="light">\n<head><meta charset="utf-8">')).toBe(true);
    expect(REPORT_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    expect(html).toContain(`<meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`);
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<button');
    expect(parse(html).title).toBe('prod-db › shop 비교 리포트');
  });

  it('머리말: DB·스키마·버전·원본 파일·올린 사람·만든 사람·만든 시각·보기 방식·도구 버전', () => {
    const doc = parse(render(DATA));
    expect(doc.querySelector('h1')?.textContent).toBe('prod-db › shop 비교 리포트');
    const header = doc.querySelector('header.report-header')?.textContent ?? '';
    for (const text of ['BASE', 'v1 · shop_v1.sql · kim', 'TARGET', 'v2 · shop_v2.sql · kim', 'SQL Split', formatGeneratedAt(OPTIONS.generatedAt), 'park', '9.9.9-test']) {
      expect(header).toContain(text);
    }
  });

  it('요약 목록 링크의 href 가 객체 섹션 id 와 같고, 객체는 모두 펼친 <details open> 이다', () => {
    const doc = parse(render(DATA));
    const hrefs = [...doc.querySelectorAll('[aria-label="변경 객체"] a')].map((a) => a.getAttribute('href'));
    const sections = [...doc.querySelectorAll('section[aria-label="객체 diff"] details')];
    expect(hrefs).toHaveLength(3);
    expect(hrefs).toEqual(sections.map((d) => `#${d.id}`));
    expect(sections.every((d) => d.hasAttribute('open'))).toBe(true);
    expect(doc.querySelector('[aria-label="변경 통계"]')?.textContent).toContain('TARGET 완전성');
  });

  it('보기 방식별 본문: SQL Split 6열, SQL Unified 4열, 표는 컬럼 표와 루틴 표', () => {
    expect(colCount(objectOf(parse(render(DATA)), 'table orders'))).toBe(6);
    expect(colCount(objectOf(parse(render(DATA, { layout: 'unified' })), 'table orders'))).toBe(4);
    const grid = parse(render(DATA, { mode: 'grid' }));
    expect(objectOf(grid, 'table orders')?.querySelector('table[aria-label="Columns"]')).not.toBeNull();
    expect(objectOf(grid, 'table orders')?.querySelector('table[aria-label="SQL diff"]')).toBeNull();
    expect(objectOf(grid, 'function tax')?.querySelector('table[aria-label="루틴 정의"]')).not.toBeNull();
    expect(grid.querySelector('header.report-header')?.textContent).toContain('표');
  });

  it('화면이라면 접히는 동일 구간도 모두 펼쳐 넣는다', () => {
    const html = render(response(longTable(), longTable(10)));
    expect(html).not.toContain('펼치기');
    expect(objectOf(parse(html), 'table wide')?.textContent).toContain('`c0` int');
  });

  it('객체 이름·COMMENT 의 <script>·"·& 는 텍스트로 이스케이프된다', () => {
    const html = render(DATA);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('aria-label="table &lt;script&gt;x&quot;&amp;"');
    const doc = parse(html);
    expect(objectOf(doc, `table ${EVIL_TABLE}`)?.querySelector('summary')?.textContent).toContain(EVIL_TABLE);
    expect(objectOf(doc, 'table orders')?.textContent).toContain(EVIL_COMMENT);
    expect(objectOf(parse(render(DATA, { mode: 'grid' })), 'table orders')?.textContent).toContain(EVIL_COMMENT);
  });

  it('변경 없는 비교: 안내 문구만 있고 객체 diff 구역이 없다', () => {
    const doc = parse(render(response(base, base)));
    expect(doc.body.textContent).toContain('두 버전 사이에 변경 사항이 없습니다');
    expect(doc.querySelector('details')).toBeNull();
    expect(doc.querySelector('section[aria-label="객체 diff"]')).toBeNull();
  });

  it('MD 부분 비교 안내와 루틴 미비교 안내를 화면과 같은 문구로 넣는다', () => {
    const doc = parse(render(response(base, parseMdDump(MD).model)));
    expect(doc.body.textContent).toContain(PARTIAL_MESSAGE);
    expect(doc.body.textContent).toContain('MD 출처라 루틴은 비교하지 않음');
  });

  it('적용된 rename 을 출처와 함께 읽기 전용으로 넣고, DMS 목록은 펼친다', () => {
    const renames = [{ kind: 'column', table: 'orders', from: 'x', to: 'y', source: 'manual' }, { kind: 'table', from: 'a', to: 'b', source: 'dms' }] as DiffResponse['renames'];
    const doc = parse(render({ ...DATA, renames }));
    expect(doc.querySelector('section[aria-label="적용된 이름 변경"]')?.textContent).toMatch(/수동\s*orders\.x → y/);
    expect(doc.querySelector('section[aria-label="DMS 매핑에서 적용된 이름 변경"] details')?.hasAttribute('open')).toBe(true);
    expect(doc.querySelector('button')).toBeNull();
  });
});

describe('리포트 추가·삭제 객체 빼기와 좌우 출처', () => {
  const b = parseSqlDump('CREATE TABLE `orders` (\n  `x` int\n);\nCREATE TABLE `gone_t` (\n  `y` int\n);\n').model;
  const t = parseSqlDump('CREATE TABLE `orders` (\n  `x` bigint\n);\nCREATE TABLE `new_t` (\n  `z` int\n);\n').model;
  const cross = response(b, t, { target: { ...meta(50, 3), databaseName: 'stage-db' } });

  it('삭제를 빼면 요약 목록·통계·객체 diff 모두에서 빠지고 머리말에 뺀 종류를 적는다', () => {
    const html = render(cross, { excludeDropped: true });
    expect(html).not.toContain('gone_t');
    expect(html).toContain('new_t');
    expect(html).toContain('<dt>뺀 객체</dt><dd>삭제된 객체</dd>');
  });

  it('추가를 빼면 추가 객체만 빠지고, 아무것도 빼지 않으면 뺀 객체 줄이 없다', () => {
    const html = render(cross, { excludeAdded: true });
    expect(html).not.toContain('new_t');
    expect(html).toContain('gone_t');
    expect(render(cross)).not.toContain('뺀 객체');
  });

  it('다른 DB 끼리면 제목과 파일 이름에 양쪽 이름을 모두 쓴다', () => {
    expect(reportTitle(cross)).toBe('prod-db › shop ↔ stage-db › shop 비교 리포트');
    expect(reportFileName(cross, new Date(2026, 9, 16, 14, 5))).toBe('prod-db_shop_v1-stage-db_shop_v3_20261016-1405.html');
  });

  it('뷰·루틴의 추가·삭제도 빼고, 뺀 객체의 문장은 안내의 문장 수에서 빠진다', () => {
    const vb = parseSqlDump('CREATE TABLE `orders` (\n  `x` int\n);\nCREATE VIEW `old_v` AS select 1 AS `a`;\n' + TAX('1')).model;
    const vt = parseSqlDump('CREATE TABLE `orders` (\n  `x` bigint\n);\nCREATE VIEW `new_v` AS select 1 AS `a`;\n').model;
    const d = response(vb, vt);
    const statements = [
      { object: 'old_v', kind: 'view', op: 'drop', sql: 'DROP VIEW `old_v`', evidenceHold: true },
      { object: 'orders', kind: 'table', op: 'modify', sql: 'ALTER TABLE `orders` DROP COLUMN `y`', evidenceHold: true },
    ] as DiffResponse['statements'];
    const filtered = filterReportData({ ...d, statements }, { excludeAdded: true, excludeDropped: true });
    expect(filtered.diff.views).toEqual([]);
    expect(filtered.diff.routines).toEqual([]);
    expect(filtered.diff.tables.map((t) => t.name)).toEqual(['orders']);
    expect(filtered.statements.map((st) => st.object)).toEqual(['orders']);
    expect(d.diff.views).toHaveLength(2); // 원본은 그대로
  });

  it('추가·삭제를 모두 빼서 남은 변경이 없으면 "변경 없음" 이 아니라 뺀 뒤 남은 것이 없다고 적는다', () => {
    const only = response(parseSqlDump('CREATE TABLE `a` (\n  `x` int\n);\n').model, parseSqlDump('CREATE TABLE `b` (\n  `x` int\n);\n').model);
    const html = render(only, { excludeAdded: true, excludeDropped: true });
    expect(html).toContain('<dt>뺀 객체</dt><dd>추가된 객체, 삭제된 객체</dd>');
    expect(html).toContain('추가된 객체, 삭제된 객체를 뺀 뒤 남은 변경 객체가 없습니다');
    expect(html).not.toContain('두 버전 사이에 변경 사항이 없습니다');
  });

  it('표 보기 + Unified 에서 SQL 로 그리는 뷰가 있으면 범례에 SQL −/+ 를 함께 적는다', () => {
    const vb = parseSqlDump('CREATE VIEW `v` AS select 1 AS `id`;\n').model;
    const vt = parseSqlDump('CREATE VIEW `v` AS select 2 AS `id`;\n').model;
    expect(render(response(vb, vt), { mode: 'grid', layout: 'unified' })).toContain('BASE (SQL −)</span>');
    expect(render(cross, { mode: 'grid', layout: 'unified' })).toContain('<span class="report-side-tag">BASE</span>');
  });

  it('객체 diff 위에 왼쪽 BASE·오른쪽 TARGET 의 DB › 스키마 버전을 적는다 (Unified 는 −/+)', () => {
    expect(render(cross)).toContain('<div class="report-sides"><div><span class="report-side-tag">BASE</span>prod-db › shop v1</div><div><span class="report-side-tag">TARGET</span>stage-db › shop v3</div></div>');
    expect(render(cross, { layout: 'unified' })).toContain('− BASE</span>prod-db › shop v1');
  });
});
