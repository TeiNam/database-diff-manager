import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { printSqlDump } from '@tdm/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { one, run, type Db } from '../src/db/connection';
import { loadEvidence, loadStaleReason } from '../src/repos/evidence';
import { listRenames } from '../src/repos/renames';
import { applyAlter } from '../src/services/alter';
import { backfillEvidence } from '../src/services/evidence-backfill';
import { ingest } from '../src/services/ingest';
import { CSRF, loggedInApp, SAMPLE_MD, sampleText } from './helpers';

// printSqlDump 를 감싼다: 기본은 진짜 구현이고, 출력→재파싱 안전망 테스트만 어긋난 출력을 내게 한다
vi.mock('@tdm/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tdm/core')>();
  return { ...actual, printSqlDump: vi.fn(actual.printSqlDump) };
});
const realPrint = (await vi.importActual<typeof import('@tdm/core')>('@tdm/core')).printSqlDump;
beforeEach(() => {
  vi.mocked(printSqlDump).mockImplementation(realPrint);
});

const SHOP_0152 = readFileSync(fileURLToPath(new URL('../../../packages/core/test/fixtures/td-export-0152/shop.sql', import.meta.url)), 'utf8');
const TABLE = 'CREATE TABLE `member` (\n  `id` int unsigned NOT NULL AUTO_INCREMENT,\n  `name` varchar(50) DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;';
const dump = (db: string, table = TABLE) => [
  `/* Database : ${db} */`, 'SET NAMES utf8mb4;', 'SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;', "SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';", '',
  table, '', 'SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;', 'SET SQL_MODE = @OLD_SQL_MODE;', '',
].join('\n');

async function setup() {
  const ctx = await loggedInApp();
  const base = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'shop', filename: 'shop.sql', text: dump('shop'), userId: 1 });
  const schemaId = Number(one<{ schema_id: number }>(ctx.db, 'SELECT schema_id FROM schema_versions WHERE id = ?', base.versionId)!.schema_id);
  const alter = (id: number, payload: Record<string, unknown>, headers: Record<string, string> = ctx.admin) =>
    ctx.app.inject({ method: 'POST', url: `/api/versions/${id}/alter`, headers, payload });
  return { ...ctx, baseId: base.versionId, schemaId, alter };
}

describe('POST /versions/:id/alter', () => {
  it('미리보기는 저장하지 않고 변경 목록과 rename 을 돌려준다', async () => {
    const ctx = await setup();
    const res = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD COLUMN age INT;\nALTER TABLE member RENAME COLUMN name TO full_name;', dryRun: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'preview', applied: 2, changes: [{ kind: 'table', name: 'member', op: 'modify' }], renames: [{ kind: 'column', table: 'member', from: 'name', to: 'full_name' }] });
    expect(one(ctx.db, 'SELECT count(*) AS n FROM schema_versions')).toEqual({ n: 1 });
  });

  it('저장하면 새 버전(원문은 td-export 형식)·파생 정보·rename 매핑·기준 판정 상속', async () => {
    const ctx = await setup();
    const res = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member RENAME COLUMN name TO full_name;', note: '이름 변경', filename: 'rename.sql' });
    expect(res.json()).toMatchObject({ status: 'ok', versionNo: 2, applied: 1 });
    const id = res.json().versionId as number;
    const derivation = await ctx.app.inject({ method: 'GET', url: `/api/versions/${id}/derivation`, headers: ctx.viewer });
    expect(derivation.json()).toEqual({ baseVersionId: ctx.baseId, baseVersionNo: 1, script: 'ALTER TABLE member RENAME COLUMN name TO full_name;', statementCount: 1, defaults: { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' } });
    expect(listRenames(ctx.db, ctx.baseId, id)).toEqual([{ kind: 'column', table: 'member', from: 'name', to: 'full_name' }]);
    const list = (await ctx.app.inject({ method: 'GET', url: `/api/schemas/${ctx.schemaId}/versions`, headers: ctx.viewer })).json();
    expect(list[0]).toMatchObject({ versionNo: 2, sourceFilename: 'rename.sql', note: '이름 변경', derivedFrom: { baseVersionNo: 1, statementCount: 1, defaults: { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' } } });
    expect(list[1].derivedFrom).toBeUndefined();
    const source = await ctx.app.inject({ method: 'GET', url: `/api/versions/${id}/source`, headers: ctx.viewer });
    expect(source.body.startsWith('/* Database : shop */\nSET NAMES utf8mb4;')).toBe(true);
    expect(loadEvidence(ctx.db, id)).toEqual(loadEvidence(ctx.db, ctx.baseId));
    expect((await ctx.app.inject({ method: 'GET', url: `/api/versions/${ctx.baseId}/derivation`, headers: ctx.viewer })).statusCode).toBe(404);
  });

  it('권한·잘못된 스크립트·변경 없음·없는 버전', async () => {
    const ctx = await setup();
    expect((await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD x INT;' }, ctx.viewer)).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/versions/${ctx.baseId}/alter`, headers: CSRF, payload: { script: 'x' } })).statusCode).toBe(401);
    expect((await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD x INT;' }, ctx.dba)).statusCode).toBe(200);
    const bad = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD COLUMN id INT;', dryRun: true });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('1번째 문장 (줄 1)');
    expect(bad.json().details.error).toMatchObject({ index: 1, line: 1 });
    expect((await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ENGINE=InnoDB;', dryRun: true })).json().error).toContain('변경 없음');
    expect((await ctx.alter(9999, { script: 'ALTER TABLE member ADD x INT;' })).statusCode).toBe(404);
    expect((await ctx.alter(ctx.baseId, { script: '' })).statusCode).toBe(400);
  });

  it('MD 기준·stale 기준은 거부하고, 같은 결과를 다시 저장하면 duplicate', async () => {
    const ctx = await setup();
    const md = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'app', filename: SAMPLE_MD, text: sampleText(SAMPLE_MD), userId: 1 });
    expect((await ctx.alter(md.versionId, { script: 'ALTER TABLE x ADD y INT;' })).json().error).toContain('MD');
    const first = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;' });
    const again = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;' });
    expect(again.json()).toMatchObject({ status: 'duplicate', versionId: first.json().versionId });
    run(ctx.db, "UPDATE schema_version_evidence SET stale_reason = '예전 파서로 저장된 모델' WHERE version_id = ?", ctx.baseId);
    expect((await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD y INT;' })).json().error).toContain('예전 파서');
  });

  it('기동 재판정: 파생 버전은 기준 판정(unknown 포함)을 물려받고, 기준이 stale 이면 파생 버전도 stale', async () => {
    const ctx = await setup();
    const legacy = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'legacy', filename: 'legacy.sql', text: `/* Database : legacy */\n${TABLE}\n`, userId: 1 });
    const fromLegacy = (await ctx.alter(legacy.versionId, { script: 'ALTER TABLE member ADD age INT;' })).json();
    expect(loadEvidence(ctx.db, fromLegacy.versionId)?.level).toBe('unknown');
    const derived = (await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;' })).json();
    run(ctx.db, 'UPDATE schema_version_sources SET source_text = ? WHERE version_id = ?', dump('shop', TABLE.replace('varchar(50)', 'varchar(60)')), ctx.baseId);
    run(ctx.db, 'UPDATE schema_version_evidence SET judge_rev = 0');
    expect(backfillEvidence(ctx.db)).toBe(4);
    expect(loadStaleReason(ctx.db, ctx.baseId)).toBeDefined();
    expect(loadStaleReason(ctx.db, derived.versionId)).toContain('기준 버전 v1');
    expect(loadEvidence(ctx.db, derived.versionId)?.level).toBe('complete');
    expect(loadEvidence(ctx.db, fromLegacy.versionId)?.level).toBe('unknown');
    expect(loadStaleReason(ctx.db, fromLegacy.versionId)).toBeUndefined();
  });
});

describe('POST /versions/:id/alter — 입력 검증·경계', () => {
  it('파일 이름은 미리보기에서도 .sql 이어야 하고, 문자셋만 주면 core 가 기본 콜레이션을 채운다', async () => {
    const ctx = await setup();
    const preview = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD x INT;', filename: 'a.txt', dryRun: true });
    expect(preview.statusCode).toBe(400);
    expect(preview.json().error).toContain('.sql');
    expect((await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD x INT;', defaults: { charset: 'utf8; DROP' } })).statusCode).toBe(400);
    const saved = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD x INT;', defaults: { charset: 'latin1' } });
    expect(saved.statusCode).toBe(200);
    const derivation = await ctx.app.inject({ method: 'GET', url: `/api/versions/${saved.json().versionId}/derivation`, headers: ctx.viewer });
    expect(derivation.json().defaults).toEqual({ charset: 'latin1', collation: 'latin1_swedish_ci' });
  });

  it('덤프로 출력할 수 없는 스키마 이름은 400 으로 알린다', async () => {
    const ctx = await setup();
    const odd = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'a*/b', filename: 'odd.sql', text: dump('odd'), userId: 1 });
    const res = await ctx.alter(odd.versionId, { script: 'ALTER TABLE member ADD x INT;' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('스키마 이름');
  });

  it('기준 버전을 지워도 파생 버전은 기준 vN 을 남기고, 재판정은 저장된 판정을 그대로 둔다', async () => {
    const ctx = await setup();
    const derived = (await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;' })).json();
    const detail = (await ctx.app.inject({ method: 'GET', url: `/api/versions/${derived.versionId}`, headers: ctx.viewer })).json();
    expect(detail.version.derivedFrom).toMatchObject({ baseVersionNo: 1, statementCount: 1 });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/versions/9999/derivation', headers: ctx.viewer })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/versions/${ctx.baseId}`, headers: ctx.admin })).statusCode).toBe(200);
    const derivation = await ctx.app.inject({ method: 'GET', url: `/api/versions/${derived.versionId}/derivation`, headers: ctx.viewer });
    expect(derivation.json()).toMatchObject({ baseVersionId: null, baseVersionNo: 1, statementCount: 1 });
    const list = (await ctx.app.inject({ method: 'GET', url: `/api/schemas/${ctx.schemaId}/versions`, headers: ctx.viewer })).json();
    expect(list[0].derivedFrom).toMatchObject({ baseVersionNo: 1, statementCount: 1 });
    run(ctx.db, 'UPDATE schema_version_evidence SET judge_rev = 0');
    expect(backfillEvidence(ctx.db)).toBe(1);
    expect(loadEvidence(ctx.db, derived.versionId)?.level).toBe('complete');
    expect(loadStaleReason(ctx.db, derived.versionId)).toBeUndefined();
  });
});

describe('POST /versions/:id/alter — CREATE·DROP·RENAME TABLE·루틴', () => {
  it('테이블 이름 변경은 테이블·컬럼 rename 매핑으로 저장되고, 기준과 비교하면 RENAME 으로 나온다', async () => {
    const ctx = await setup();
    const res = await ctx.alter(ctx.baseId, { script: 'RENAME TABLE member TO customer;\nALTER TABLE customer RENAME COLUMN name TO full_name;' });
    expect(res.json()).toMatchObject({ status: 'ok', applied: 2, changes: [{ kind: 'table', name: 'customer', op: 'rename' }] });
    const id = res.json().versionId as number;
    expect(listRenames(ctx.db, ctx.baseId, id)).toEqual([
      { kind: 'table', from: 'member', to: 'customer' },
      { kind: 'column', table: 'customer', from: 'name', to: 'full_name' },
    ]);
    const diff = (await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${ctx.baseId}&target=${id}`, headers: ctx.viewer })).json();
    expect(diff.renames).toEqual([
      { kind: 'table', from: 'member', to: 'customer', source: 'manual' },
      { kind: 'column', table: 'customer', from: 'name', to: 'full_name', source: 'manual' },
    ]);
    expect(diff.ddl).toContain('RENAME TABLE');
    expect(diff.ddl).not.toMatch(/DROP TABLE|CREATE TABLE/);
  });

  it('테이블 생성·삭제는 add·drop 으로 나오고, 기준의 완전한 판정을 물려받아 삭제 문장이 실행 문장이 된다', async () => {
    const ctx = await setup();
    const script = 'CREATE TABLE orders (id INT NOT NULL AUTO_INCREMENT, PRIMARY KEY (id));\nDROP TABLE member;';
    const preview = await ctx.alter(ctx.baseId, { script, dryRun: true });
    expect(preview.json()).toEqual({ status: 'preview', applied: 2, renames: [], changes: [{ kind: 'table', name: 'member', op: 'drop' }, { kind: 'table', name: 'orders', op: 'add' }] });
    const id = (await ctx.alter(ctx.baseId, { script })).json().versionId as number;
    expect(loadEvidence(ctx.db, id)?.level).toBe('complete');
    const diff = (await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${ctx.baseId}&target=${id}`, headers: ctx.viewer })).json();
    expect(diff.statements.filter((s: { comment?: unknown }) => !s.comment).map((s: { sql: string }) => s.sql)).toContain('DROP TABLE `member`');
  });

  it('루틴을 만들고 지우는 스크립트: 파생 버전에 루틴이 실리고, 재판정에서도 stale 이 아니다', async () => {
    const ctx = await setup();
    const shop = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'shop_full', filename: 'shop.sql', text: SHOP_0152, userId: 1 });
    const script = 'DELIMITER ;;\nCREATE FUNCTION fn_double(x INT) RETURNS INT DETERMINISTIC\nBEGIN\n  RETURN x * 2;\nEND;;\nDELIMITER ;\nDROP PROCEDURE mark_paid;';
    const res = await ctx.alter(shop.versionId, { script });
    expect(res.json()).toMatchObject({ status: 'ok', applied: 2 });
    expect(res.json().changes).toEqual(expect.arrayContaining([{ kind: 'function', name: 'fn_double', op: 'add' }, { kind: 'procedure', name: 'mark_paid', op: 'drop' }]));
    const id = res.json().versionId as number;
    const detail = (await ctx.app.inject({ method: 'GET', url: `/api/versions/${id}`, headers: ctx.viewer })).json();
    expect(detail.model.routines.map((r: { name: string }) => r.name).sort()).toEqual(['fn_double', 'tax']);
    expect(detail.objects.filter((o: { kind: string }) => o.kind === 'function').map((o: { name: string }) => o.name).sort()).toEqual(['fn_double', 'tax']);
    const source = await ctx.app.inject({ method: 'GET', url: `/api/versions/${id}/source`, headers: ctx.viewer });
    expect(source.body).toContain('FUNCTION `fn_double`');
    expect(source.body).not.toContain('mark_paid');
    expect(loadEvidence(ctx.db, id)).toEqual(loadEvidence(ctx.db, shop.versionId));
    run(ctx.db, 'UPDATE schema_version_evidence SET judge_rev = 0');
    backfillEvidence(ctx.db);
    expect(loadStaleReason(ctx.db, id)).toBeUndefined();
    expect(loadEvidence(ctx.db, id)?.level).toBe('complete');
  });
});

describe('POST /versions/:id/alter — 출력→재파싱 안전망', () => {
  const versionCount = (db: Db) => one<{ n: number }>(db, 'SELECT count(*) AS n FROM schema_versions')!.n;

  it('다시 읽은 모델에서 객체가 빠지면 미리보기·저장 모두 400 이고 새 버전은 생기지 않는다', async () => {
    const ctx = await setup();
    vi.mocked(printSqlDump).mockImplementation((model) => realPrint({ ...model, tables: [] }));
    for (const dryRun of [true, false]) {
      const res = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;', dryRun });
      expect(res.statusCode, `dryRun ${dryRun}`).toBe(400);
      expect(res.json().error).toContain('다시 읽으면');
    }
    expect(versionCount(ctx.db)).toBe(1);
    expect(one(ctx.db, 'SELECT count(*) AS n FROM schema_version_derivations')).toEqual({ n: 0 });
  });

  it('모델은 같아도 다시 읽을 때 경고가 나면(스키마 정의가 아닌 문장이 섞임) 400', async () => {
    const ctx = await setup();
    vi.mocked(printSqlDump).mockImplementation((model) => `${realPrint(model)}\nSELECT 1;\n`);
    for (const dryRun of [true, false]) {
      const res = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;', dryRun });
      expect(res.statusCode, `dryRun ${dryRun}`).toBe(400);
      expect(res.json().error).toContain('다시 읽으면');
    }
    expect(versionCount(ctx.db)).toBe(1);
  });

  // 기준에 이미 있는 이상한 객체: 파싱하지 못한 테이블(parse-error), 다시 찍으면 원문과 다른 테이블·루틴(round-trip, 모델에 rawDdl 이 남는다).
  // 스크립트가 건드리지 않았으면 기준을 그대로 출력·다시 읽은 결과와 같아야 하고, 건드린 객체는 적용 결과와 같아야 한다 (rawDdl 은 출력한 덤프가 원문이라 보지 않는다)
  const BAD = 'CREATE TABLE `bad` (\n  `x` int NOT NULL FOO\n) ENGINE=InnoDB;';
  const ODD = 'CREATE TABLE `odd` (\n  `a` int    NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;';
  const ODD_ROUTINE = 'DELIMITER ;;\nCREATE FUNCTION `f`() RETURNS int   DETERMINISTIC RETURN 1;;\nDELIMITER ;';
  async function oddSetup() {
    const ctx = await setup();
    const odd = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'odd', filename: 'odd.sql', text: dump('odd', [TABLE, BAD, ODD, ODD_ROUTINE].join('\n')), userId: 1 });
    expect(odd.warnings.map((w) => [w.code, w.object])).toEqual([['parse-error', 'bad'], ['round-trip', 'odd'], ['round-trip', 'f']]);
    return { ...ctx, oddId: odd.versionId };
  }

  it('기준에 파싱 실패·왕복 불일치 객체가 있어도 그 객체를 건드리지 않는 ALTER 는 받고, 그 객체는 그대로 남는다', async () => {
    const ctx = await oddSetup();
    const preview = await ctx.alter(ctx.oddId, { script: 'ALTER TABLE member ADD age INT;', dryRun: true });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().changes).toEqual([{ kind: 'table', name: 'member', op: 'modify' }]);
    const saved = (await ctx.alter(ctx.oddId, { script: 'ALTER TABLE member ADD age INT;' })).json();
    expect(saved).toMatchObject({ status: 'ok', applied: 1 });
    const detail = (await ctx.app.inject({ method: 'GET', url: `/api/versions/${saved.versionId}`, headers: ctx.viewer })).json();
    const bad = detail.model.tables.find((t: { name: string }) => t.name === 'bad');
    expect(bad).toMatchObject({ parseError: expect.stringContaining('FOO'), rawDdl: expect.stringContaining('FOO') });
    expect(detail.model.tables.find((t: { name: string }) => t.name === 'odd').columns).toMatchObject([{ name: 'a', type: 'int', nullable: false }]);
  });

  it('왕복 불일치 객체를 건드리는 ALTER 도 받는다 (적용 결과를 다시 찍은 덤프가 새 원문이다)', async () => {
    const ctx = await oddSetup();
    const res = await ctx.alter(ctx.oddId, { script: 'ALTER TABLE odd ADD b INT;', dryRun: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changes).toEqual([{ kind: 'table', name: 'odd', op: 'modify' }]);
  });

  it('그래도 객체가 빠지거나 바뀌면 막고, 객체 이름과 요청 ID 를 서버 로그에 남긴다 (스크립트는 남기지 않는다)', async () => {
    const ctx = await oddSetup();
    const withoutOdd = (model: Parameters<typeof realPrint>[0]) => realPrint({ ...model, tables: model.tables.filter((t) => t.name !== 'odd') });
    vi.mocked(printSqlDump).mockImplementation(withoutOdd);
    const lost = await ctx.alter(ctx.oddId, { script: 'ALTER TABLE member ADD age INT;', dryRun: true });
    expect(lost.statusCode).toBe(400);
    expect(lost.json().error).toContain('`odd`');
    expect(lost.json().error).not.toContain('td-export'); // 다시 뽑아 올려도 풀리지 않는다
    // 건드리지 않은 정상 테이블이 다시 읽으며 바뀌어도 막는다 — 기준을 그대로 다시 읽어도 똑같이 바뀌는 출력 버그도 놓치지 않는다
    vi.mocked(printSqlDump).mockImplementation((model) => realPrint({ ...model, tables: model.tables.map((t) => (t.name === 'member' ? { ...t, options: [] } : t)) }));
    const changed = await ctx.alter(ctx.oddId, { script: 'ALTER TABLE odd ADD b INT;', dryRun: true });
    expect(changed.statusCode).toBe(400);
    expect(changed.json().error).toContain('`member`');
    const warn = vi.fn();
    vi.mocked(printSqlDump).mockImplementation(withoutOdd);
    expect(() => applyAlter(ctx.db, { baseId: ctx.oddId, script: 'ALTER TABLE member ADD age INT; -- 비밀', dryRun: true, userId: 1, requestId: 'req-7', log: { warn } })).toThrow(/req-7/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({ requestId: 'req-7', baseVersionId: ctx.oddId, objects: ['table `odd`'] });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('비밀');
  });

  it('서버 오류(ApplyFailure 가 아닌 예외)는 400 으로 바뀌지 않는다', async () => {
    const ctx = await setup();
    vi.mocked(printSqlDump).mockImplementation(() => {
      throw new TypeError('출력기 버그');
    });
    const res = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;', dryRun: true });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('출력기 버그');
  });
});

describe('기동 재판정 — 기준 버전의 stale', () => {
  const makeBaseStale = (ctx: Awaited<ReturnType<typeof setup>>) => {
    run(ctx.db, 'UPDATE schema_version_sources SET source_text = ? WHERE version_id = ?', dump('shop', TABLE.replace('varchar(50)', 'varchar(60)')), ctx.baseId);
    run(ctx.db, 'UPDATE schema_version_evidence SET judge_rev = 0');
  };

  it('기준 버전을 지워도 파생 버전의 stale 표시는 재판정이 몇 번 돌아도 이어진다', async () => {
    const ctx = await setup();
    const derived = (await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;' })).json();
    makeBaseStale(ctx);
    expect(backfillEvidence(ctx.db)).toBe(2);
    expect(loadStaleReason(ctx.db, derived.versionId)).toContain('기준 버전 v1');
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/versions/${ctx.baseId}`, headers: ctx.admin })).statusCode).toBe(200);
    for (const pass of [1, 2]) {
      run(ctx.db, 'UPDATE schema_version_evidence SET judge_rev = 0');
      expect(backfillEvidence(ctx.db), `재판정 ${pass}회`).toBe(1);
      expect(loadStaleReason(ctx.db, derived.versionId), `재판정 ${pass}회`).toContain('기준 버전 v1');
    }
    const detail = (await ctx.app.inject({ method: 'GET', url: `/api/versions/${derived.versionId}`, headers: ctx.viewer })).json();
    expect(detail.staleReason).toContain('기준 버전 v1');
  });

  it('기준 버전이 살아 있고 stale 이 풀리면(원문과 모델이 다시 일치) 파생 버전의 stale 도 풀린다', async () => {
    const ctx = await setup();
    const derived = (await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;' })).json();
    makeBaseStale(ctx);
    backfillEvidence(ctx.db);
    expect(loadStaleReason(ctx.db, derived.versionId)).toContain('기준 버전 v1');
    run(ctx.db, 'UPDATE schema_version_sources SET source_text = ? WHERE version_id = ?', dump('shop'), ctx.baseId);
    run(ctx.db, 'UPDATE schema_version_evidence SET judge_rev = 0');
    expect(backfillEvidence(ctx.db)).toBe(2);
    expect(loadStaleReason(ctx.db, ctx.baseId)).toBeUndefined();
    expect(loadStaleReason(ctx.db, derived.versionId)).toBeUndefined();
  });
});
