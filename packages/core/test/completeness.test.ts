// TARGET 완전성 판정: 부재 기반 파괴 문장(객체·컬럼·파티션 삭제)은 TARGET 이 완전한 덤프라는 양성 증거가 있을 때만 실행한다
// (14회차 1 → 15회차 원칙 전환: 증거 없음·불완전·판정 미상은 모두 수동 확인)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { targetEvidence } from '../src/completeness';
import { generateDdl, type Statement } from '../src/ddl';
import { diffSchemas } from '../src/diff';
import type { SchemaModel } from '../src/model';
import { parseSqlDump } from '../src/parse-dump';
import { parseMdDump } from '../src/parse-md';
import { fixture, stripTdExport, tdExport } from './helpers';

const codes = (r: { warnings: { code: string }[] }) => r.warnings.map((w) => w.code);
// 실행 문장(수동 확인·안내 주석 제외) 중 데이터·객체를 지우는 문장
const DESTRUCTIVE = /\bDROP\s+(TABLE|VIEW|FUNCTION|PROCEDURE|COLUMN|PARTITION)\b|\bREORGANIZE\s+PARTITION\b/i;
const ddlOf = (base: SchemaModel, target: SchemaModel): Statement[] => generateDdl(diffSchemas(base, target));
const destructive = (base: SchemaModel, target: SchemaModel): string[] =>
  ddlOf(base, target).filter((s) => !s.comment && DESTRUCTIVE.test(s.sql)).map((s) => s.sql);
const UNVERIFIED = 'TARGET 이 완전한 덤프인지 확인할 수 없음';

describe('td-export 실출력의 증거 수준 (회귀)', () => {
  it.each(['td-export-0130/sample-app', 'td-export-0136/escapes', 'td-export-0152/escapes', 'td-export-0152/shop'])('%s.sql: 헤더·트레일러가 있어 완전', (name) => {
    const r = parseSqlDump(fixture(`${name}.sql`));
    expect(r.model.evidence).toEqual({ level: 'complete', objects: [] });
    expect(codes(r).filter((c) => c === 'non-schema' || c === 'incomplete' || c === 'unverified')).toEqual([]);
  });

  it('td-export 0.1.15 SQL 은 헤더 SET·트레일러가 없어 판정 미상 (unknown) — 경고(unverified)는 업로드 때 서버가 붙인다', () => {
    const r = parseSqlDump(fixture('td-export-0115/sample-app.sql'));
    expect(r.model.evidence).toMatchObject({ level: 'unknown', objects: [] });
    expect(r.model.evidence?.reason).toContain('0.1.15');
    expect(codes(r)).toEqual([]);
  });

  it.each(['td-export-0115/sample-app', 'td-export-0130/sample-app', 'td-export-0136/escapes', 'td-export-0152/escapes', 'td-export-0152/shop'])('%s.md: 완전', (name) => {
    const r = parseMdDump(fixture(`${name}.md`));
    expect(r.model.evidence).toEqual({ level: 'complete', objects: [] });
    expect(codes(r).filter((c) => c === 'non-schema' || c === 'incomplete' || c === 'unverified')).toEqual([]);
  });
});

describe('targetEvidence: diff·DDL 가드가 보는 하나의 판정', () => {
  const shop = parseSqlDump(fixture('td-export-0152/shop.sql')).model;

  it('원문 판정이 없는 모델(직접 만든 모델·옛 JSON)은 unknown', () => {
    const { evidence: _, ...bare } = shop;
    expect(targetEvidence(bare).level).toBe('unknown');
  });

  it('식별할 수 없는 파싱 실패 문장·객체 0개는 원문 판정과 무관하게 incomplete', () => {
    const unidentified = { ...shop, tables: [...shop.tables, { ...shop.tables[0], name: '(unknown)', parseError: 'x' }] };
    expect(targetEvidence(unidentified).level).toBe('incomplete');
    expect(targetEvidence({ ...shop, tables: [], views: [], routines: [] })).toMatchObject({ level: 'incomplete', reason: expect.stringContaining('객체가 없습니다') });
  });

  it('diff 는 TARGET 판정을 targetEvidence 로 싣는다', () => {
    expect(diffSchemas(shop, shop).targetEvidence).toEqual({ level: 'complete', objects: [] });
  });
});

describe('SQL 증거', () => {
  const full = fixture('td-export-0152/shop.sql');
  const base = parseSqlDump(full).model;
  const withoutBigPaid = full.replace(/\/\* Table : big_paid \*\/\n[^\n]+\n/, '');

  it('스키마 정의가 아닌 문장(ALTER·INSERT·SHOW 등)이 하나라도 있으면 비스키마 (Codex 1: SHOW CREATE TABLE 만 든 파일)', () => {
    for (const text of ['ALTER TABLE `orders` ADD COLUMN `x` int;\n', 'SHOW CREATE TABLE a;\n', 'SHOW CREATE TABLE `a`;\n',
      'CREATE TABLE `a` (\n  `x` int\n);\nINSERT INTO `a` VALUES (1);\n', tdExport('SELECT 1;\nCREATE TABLE `a` (\n  `x` int\n);')]) {
      const r = parseSqlDump(text);
      expect(codes(r), text).toContain('non-schema');
      expect(r.model.evidence?.level, text).toBe('incomplete');
      expect(destructive(base, r.model), text).toEqual([]);
    }
  });

  it('완전한 td-export 출력(헤더·트레일러)의 DROP 은 실행한다', () => {
    const target = parseSqlDump(withoutBigPaid).model;
    expect(target.evidence?.level).toBe('complete');
    expect(destructive(base, target)).toEqual(['DROP VIEW `big_paid`']);
  });

  it('0.1.15 형식(헤더 SET·트레일러 없음) TARGET 의 DROP 은 수동 확인 — 사유는 확인할 수 없음', () => {
    const target = parseSqlDump(stripTdExport(withoutBigPaid)).model;
    expect(target.evidence?.level).toBe('unknown');
    expect(destructive(base, target)).toEqual([]);
    const held = ddlOf(base, target).find((s) => s.object === 'big_paid')!;
    expect(held).toMatchObject({ comment: true, evidenceHold: true });
    expect(held.sql).toContain(UNVERIFIED);
  });

  it('Database 주석이 없으면 SET 헤더가 있어도 unknown', () => {
    const r = parseSqlDump(withoutBigPaid.replace(/^\/\* Database : shop \*\/\n/, ''));
    expect(r.model.evidence?.level).toBe('unknown');
  });

  it('헤더가 저장한 세션 변수를 마지막 CREATE 뒤에서 복원하지 않으면 불완전', () => {
    const cut = full.slice(0, full.indexOf('/* Table : big_paid */'));
    expect(parseSqlDump(cut).model.evidence).toMatchObject({ level: 'incomplete', reason: expect.stringContaining('트레일러') });
    // 복원이 CREATE 앞에 있으면 트레일러가 아니다
    const early = tdExport('SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;\nSET SQL_MODE = @OLD_SQL_MODE;\nCREATE TABLE `a` (\n  `x` int\n);').replace(/\nSET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;\nSET SQL_MODE = @OLD_SQL_MODE;\n$/, '\n');
    expect(parseSqlDump(early).model.evidence?.level).toBe('incomplete');
  });

  it('마지막 CREATE 가 구분자 없이 끊기면 불완전 — 끊긴 객체를 남긴다', () => {
    const cut = full.slice(0, full.indexOf('CREATE TABLE `orders`') + 60);
    const r = parseSqlDump(cut);
    expect(r.model.evidence).toMatchObject({ level: 'incomplete', objects: ['orders'] });
    expect(destructive(base, r.model)).toEqual([]);
  });

  it('문자열·주석 안에서 끊겨도 예외 없이 불완전 (0.1.15 형식도 끊김은 음성 증거)', () => {
    const head = '/* Database : shop */\nCREATE TABLE `a` (\n  `x` int\n);\n';
    for (const tail of ["CREATE TABLE `b` (\n  `s` varchar(9) DEFAULT 'ab", '/* Table : b', "SET SQL_MODE = 'AN"]) {
      expect(parseSqlDump(head + tail).model.evidence?.level, tail).toBe('incomplete');
    }
  });
});

describe('MD 증거', () => {
  const md = fixture('td-export-0152/shop.md');
  const base = parseSqlDump(fixture('td-export-0152/shop.sql')).model;

  it('제목·## Table List 가 없거나, Table List 가 비었거나, 스키마 표가 하나도 없으면 비스키마 (Codex 2)', () => {
    for (const text of ['# Release notes\n## Changes\nSome notes\n', 'notes\n=====\n\n## Table List\n \n## Changes\n- fixed\n \n',
      'notes\n=====\n\n## Table List\n- [a ()](#a)\n \n## a\nhello\n \n']) {
      const r = parseMdDump(text);
      expect(codes(r), text).toContain('non-schema');
      expect(r.model.evidence?.level, text).toBe('incomplete');
      expect(destructive(base, r.model), text).toEqual([]);
    }
  });

  it('섹션에 스키마 표(Columns 표 헤더 + 1행 이상)가 없으면 불완전', () => {
    const target = parseMdDump(md.replace(/\|id\|int\|NO\|\|\|\|PRI\|auto_increment\|\|\n\|order_id[^\n]*\n\|at[^\n]*\n/, '')).model;
    expect(target.evidence).toMatchObject({ level: 'incomplete', reason: expect.stringContaining('order_audit') });
  });

  it('마지막 표가 행 중간에서 끝나면 불완전 — 그 객체 문장은 실행하지 않는다', () => {
    const cut = md.slice(0, md.indexOf('|amount|decimal') + 8);
    const target = parseMdDump(cut).model;
    expect(target.evidence).toMatchObject({ level: 'incomplete', objects: ['orders'] });
    expect(destructive(base, target)).toEqual([]);
  });

  it('Table List 에 있는데 섹션이 없는 객체가 있으면 불완전', () => {
    const target = parseMdDump(md.replace(/## order_audit[\s\S]*?(?=## orders)/, '')).model;
    expect(target.evidence).toMatchObject({ level: 'incomplete', reason: expect.stringContaining('order_audit') });
    expect(destructive(base, target)).toEqual([]);
  });

  it('편집기가 줄 끝 공백을 지워 끝 줄 \' \' 이 없어지면 판정 미상 (unknown) — 줄 경계 잘림과 구별할 수 없다 (16회차 1)', () => {
    for (const text of [md, fixture('td-export-0130/sample-app.md')]) {
      const trimmed = text.split('\n').map((l) => l.trimEnd()).join('\n');
      expect(parseMdDump(trimmed).model.evidence).toMatchObject({ level: 'unknown', reason: expect.stringContaining('MD 끝 표식이 없음') });
      expect(destructive(base, parseMdDump(trimmed).model)).toEqual([]);
    }
  });
});

// 줄 경계 잘림 fuzz (16회차 1, 결정적): 실제 td-export MD 를 모든 줄 경계에서 자르면(줄바꿈 포함·제외 둘 다) 어느 것도 complete 가 아니다
const MD_FIXTURES = ['td-export-0115/sample-app.md', 'td-export-0130/sample-app.md', 'td-export-0136/escapes.md', 'td-export-0152/escapes.md', 'td-export-0152/shop.md'];
const SAMPLE_MD_DIR = fileURLToPath(new URL('../../../samples/', import.meta.url));
const sampleMds = existsSync(SAMPLE_MD_DIR)
  ? readdirSync(SAMPLE_MD_DIR, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.md')).map((f) => join(SAMPLE_MD_DIR, f))
  : [];
const linePrefixes = (text: string): string[] => {
  const cuts: string[] = [];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) cuts.push(text.slice(0, i), text.slice(0, i + 1));
  return cuts.filter((c) => c !== text && c !== text.replace(/\n$/, ''));
};

describe('MD 줄 경계 잘림은 complete 가 아니다', () => {
  const check = (text: string) => {
    expect(parseMdDump(text).model.evidence?.level).toBe('complete');
    const leaked = linePrefixes(text).filter((cut) => parseMdDump(cut).model.evidence?.level === 'complete');
    expect(leaked.map((c) => c.length)).toEqual([]);
  };
  it.each(MD_FIXTURES)('%s', (name) => check(fixture(name)));
  it.skipIf(!sampleMds.length).each(sampleMds)('로컬 샘플 %s', (file) => check(readFileSync(file, 'utf8')));
});

describe('파티션 삭제도 부재 기반 파괴 문장이다', () => {
  const part = (defs: string, header = true) => {
    const body = `/* Table : t */\nCREATE TABLE \`t\` (\n  \`id\` int NOT NULL,\n  \`r\` int NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci\n/*!50100 PARTITION BY LIST (\`r\`)\n(${defs}) */;`;
    return parseSqlDump(header ? tdExport(body) : `/* Database : shop */\n${body}\n`).model;
  };
  const base = part('PARTITION p1 VALUES IN (1) ENGINE = InnoDB,\n PARTITION p2 VALUES IN (2,3) ENGINE = InnoDB');
  const dropped = 'PARTITION p2 VALUES IN (2,3) ENGINE = InnoDB';
  const shrunk = 'PARTITION p1 VALUES IN (1) ENGINE = InnoDB,\n PARTITION p2 VALUES IN (2) ENGINE = InnoDB';

  it('완전한 TARGET 이면 DROP PARTITION·값을 지우는 REORGANIZE 를 실행한다', () => {
    expect(destructive(base, part(dropped))).toEqual(['ALTER TABLE `t` DROP PARTITION `p1`']);
    expect(destructive(base, part(shrunk))).toHaveLength(1);
  });

  it('증거가 없으면 DROP PARTITION·LIST 값 제거 REORGANIZE 를 수동 확인으로 돌린다', () => {
    for (const defs of [dropped, shrunk]) {
      const stmts = ddlOf(base, part(defs, false));
      expect(stmts.filter((s) => !s.comment && DESTRUCTIVE.test(s.sql)), defs).toEqual([]);
      expect(stmts.some((s) => s.evidenceHold), defs).toBe(true);
    }
  });

  it('행을 지우지 않는 파티션 변경(ADD PARTITION)은 증거가 없어도 실행한다', () => {
    const grown = 'PARTITION p1 VALUES IN (1) ENGINE = InnoDB,\n PARTITION p2 VALUES IN (2,3) ENGINE = InnoDB,\n PARTITION p3 VALUES IN (4) ENGINE = InnoDB';
    const stmts = ddlOf(base, part(grown, false));
    expect(stmts.map((s) => s.comment)).toEqual([false]);
  });
});

describe('증거가 없어도 부재 기반이 아닌 문장은 실행한다', () => {
  it('컬럼 추가는 0.1.15 형식 TARGET 에서도 실행 문장', () => {
    const t = (cols: string) => `/* Database : shop */\n/* Table : t */\nCREATE TABLE \`t\` (\n${cols}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\n`;
    const stmts = ddlOf(parseSqlDump(t('  `a` int')).model, parseSqlDump(t('  `a` int,\n  `b` int')).model);
    expect(stmts.map((s) => [s.comment, s.evidenceHold])).toEqual([[false, undefined]]);
  });
});
