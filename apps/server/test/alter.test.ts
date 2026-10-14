import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { printSqlDump } from '@tdm/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// 지문은 서버의 계산을 거치지 않고 저장된 값에서 직접 읽는다 (서버가 돌려주는 지문과 대조하는 테스트가 순환하지 않게)
const fingerprintOf = (db: Db, id: number) => {
  const r = one<{ schema_id: number; version_no: number; model_hash: string; uploaded_at: string; database_name: string; schema_name: string }>(db, `
    SELECT v.schema_id, v.version_no, v.model_hash, v.uploaded_at, d.name AS database_name, s.name AS schema_name
      FROM schema_versions v JOIN schemas s ON s.id = v.schema_id JOIN databases d ON d.id = s.database_id WHERE v.id = ?`, id)!;
  return {
    schemaId: Number(r.schema_id), versionNo: Number(r.version_no), modelHash: r.model_hash, uploadedAt: r.uploaded_at, databaseName: r.database_name, schemaName: r.schema_name,
  };
};
// 미리보기가 돌려주는 기준 버전: 지문과, 그때 그 스키마의 최신 SQL 버전 번호 (SQL 버전이 없으면 — MD 기준 — 그 버전 자신)
const previewBaseOf = (db: Db, id: number) => {
  const fingerprint = fingerprintOf(db, id);
  const latest = one<{ n: number | null }>(db, "SELECT max(version_no) AS n FROM schema_versions WHERE schema_id = ? AND source_format = 'sql'", fingerprint.schemaId)!.n;
  return { ...fingerprint, latestVersionNo: latest === null ? fingerprint.versionNo : Number(latest) };
};

async function setup() {
  const ctx = await loggedInApp();
  const base = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'shop', filename: 'shop.sql', text: dump('shop'), userId: 1 });
  const schemaId = Number(one<{ schema_id: number }>(ctx.db, 'SELECT schema_id FROM schema_versions WHERE id = ?', base.versionId)!.schema_id);
  const alter = (id: number, payload: Record<string, unknown>, headers: Record<string, string> = ctx.admin) =>
    ctx.app.inject({ method: 'POST', url: `/api/versions/${id}/alter`, headers, payload });
  const fingerprint = (id: number) => previewBaseOf(ctx.db, id);
  // 저장 요청에는 미리보기가 돌려준 기준 버전 지문(expectedBase)이 필요하다. 지문이 주제가 아닌 테스트는 지금 미리보기했다면 받았을 값을 붙여 보낸다
  const save = (id: number, payload: Record<string, unknown>, headers: Record<string, string> = ctx.admin) =>
    alter(id, { expectedBase: fingerprint(id), ...payload }, headers);
  return { ...ctx, baseId: base.versionId, schemaId, alter, save, fingerprint };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const versionCount = (db: Db) => one<{ n: number }>(db, 'SELECT count(*) AS n FROM schema_versions')!.n;
const derivationCount = (db: Db) => one<{ n: number }>(db, 'SELECT count(*) AS n FROM schema_version_derivations')!.n;
const columnsOf = async (ctx: Ctx, versionId: number) => {
  const detail = (await ctx.app.inject({ method: 'GET', url: `/api/versions/${versionId}`, headers: ctx.viewer })).json();
  return detail.model.tables[0].columns.map((c: { name: string }) => c.name);
};

describe('POST /versions/:id/alter', () => {
  it('미리보기는 저장하지 않고 변경 목록과 rename 을, 기준 버전 지문과 함께 돌려준다', async () => {
    const ctx = await setup();
    const res = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD COLUMN age INT;\nALTER TABLE member RENAME COLUMN name TO full_name;', dryRun: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'preview', applied: 2, changes: [{ kind: 'table', name: 'member', op: 'modify' }], renames: [{ kind: 'column', table: 'member', from: 'name', to: 'full_name' }],
      base: ctx.fingerprint(ctx.baseId),
    });
    expect(one(ctx.db, 'SELECT count(*) AS n FROM schema_versions')).toEqual({ n: 1 });
  });

  it('저장하면 새 버전(원문은 td-export 형식)·파생 정보·rename 매핑·기준 판정 상속', async () => {
    const ctx = await setup();
    const res = await ctx.save(ctx.baseId, { script: 'ALTER TABLE member RENAME COLUMN name TO full_name;', note: '이름 변경', filename: 'rename.sql' });
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
    expect((await ctx.save(ctx.baseId, { script: 'ALTER TABLE member ADD x INT;' }, ctx.dba)).statusCode).toBe(200);
    const bad = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD COLUMN id INT;', dryRun: true });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('1번째 문장 (줄 1)');
    expect(bad.json().details.error).toMatchObject({ index: 1, line: 1 });
    expect((await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ENGINE=InnoDB;', dryRun: true })).json().error).toContain('변경 없음');
    expect((await ctx.alter(9999, { script: 'ALTER TABLE member ADD x INT;', dryRun: true })).statusCode).toBe(404);
    expect((await ctx.alter(9999, { script: 'ALTER TABLE member ADD x INT;', expectedBase: ctx.fingerprint(ctx.baseId) })).statusCode).toBe(404);
    expect((await ctx.alter(ctx.baseId, { script: '' })).statusCode).toBe(400);
  });

  it('MD 기준·stale 기준은 거부하고, 같은 결과를 다시 저장하면 duplicate', async () => {
    const ctx = await setup();
    const md = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'app', filename: SAMPLE_MD, text: sampleText(SAMPLE_MD), userId: 1 });
    expect((await ctx.save(md.versionId, { script: 'ALTER TABLE x ADD y INT;' })).json().error).toContain('MD');
    const first = await ctx.save(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;' });
    const again = await ctx.save(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;' });
    expect(again.json()).toMatchObject({ status: 'duplicate', versionId: first.json().versionId });
    run(ctx.db, "UPDATE schema_version_evidence SET stale_reason = '예전 파서로 저장된 모델' WHERE version_id = ?", ctx.baseId);
    expect((await ctx.save(ctx.baseId, { script: 'ALTER TABLE member ADD y INT;' })).json().error).toContain('예전 파서');
  });

  it('기동 재판정: 파생 버전은 기준 판정(unknown 포함)을 물려받고, 기준이 stale 이면 파생 버전도 stale', async () => {
    const ctx = await setup();
    const legacy = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'legacy', filename: 'legacy.sql', text: `/* Database : legacy */\n${TABLE}\n`, userId: 1 });
    const fromLegacy = (await ctx.save(legacy.versionId, { script: 'ALTER TABLE member ADD age INT;' })).json();
    expect(loadEvidence(ctx.db, fromLegacy.versionId)?.level).toBe('unknown');
    const derived = (await ctx.save(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;' })).json();
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
    expect((await ctx.save(ctx.baseId, { script: 'ALTER TABLE member ADD x INT;', defaults: { charset: 'utf8; DROP' } })).statusCode).toBe(400);
    const saved = await ctx.save(ctx.baseId, { script: 'ALTER TABLE member ADD x INT;', defaults: { charset: 'latin1' } });
    expect(saved.statusCode).toBe(200);
    const derivation = await ctx.app.inject({ method: 'GET', url: `/api/versions/${saved.json().versionId}/derivation`, headers: ctx.viewer });
    expect(derivation.json().defaults).toEqual({ charset: 'latin1', collation: 'latin1_swedish_ci' });
  });

  it('덤프로 출력할 수 없는 스키마 이름은 400 으로 알린다', async () => {
    const ctx = await setup();
    const odd = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'a*/b', filename: 'odd.sql', text: dump('odd'), userId: 1 });
    const res = await ctx.save(odd.versionId, { script: 'ALTER TABLE member ADD x INT;' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('스키마 이름');
  });

  it('기준 버전을 지워도 파생 버전은 기준 vN 을 남기고, 재판정은 저장된 판정을 그대로 둔다', async () => {
    const ctx = await setup();
    const derived = (await ctx.save(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;' })).json();
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
    const res = await ctx.save(ctx.baseId, { script: 'RENAME TABLE member TO customer;\nALTER TABLE customer RENAME COLUMN name TO full_name;' });
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
    expect(preview.json()).toEqual({ status: 'preview', applied: 2, renames: [], changes: [{ kind: 'table', name: 'member', op: 'drop' }, { kind: 'table', name: 'orders', op: 'add' }], base: ctx.fingerprint(ctx.baseId) });
    const id = (await ctx.save(ctx.baseId, { script, expectedBase: preview.json().base })).json().versionId as number;
    expect(loadEvidence(ctx.db, id)?.level).toBe('complete');
    const diff = (await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${ctx.baseId}&target=${id}`, headers: ctx.viewer })).json();
    expect(diff.statements.filter((s: { comment?: unknown }) => !s.comment).map((s: { sql: string }) => s.sql)).toContain('DROP TABLE `member`');
  });

  it('루틴을 만들고 지우는 스크립트: 파생 버전에 루틴이 실리고, 재판정에서도 stale 이 아니다', async () => {
    const ctx = await setup();
    const shop = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'shop_full', filename: 'shop.sql', text: SHOP_0152, userId: 1 });
    const script = 'DELIMITER ;;\nCREATE FUNCTION fn_double(x INT) RETURNS INT DETERMINISTIC\nBEGIN\n  RETURN x * 2;\nEND;;\nDELIMITER ;\nDROP PROCEDURE mark_paid;';
    const res = await ctx.save(shop.versionId, { script });
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
      const res = await ctx.save(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;', dryRun });
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
      const res = await ctx.save(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;', dryRun });
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
    const saved = (await ctx.save(ctx.oddId, { script: 'ALTER TABLE member ADD age INT;' })).json();
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
    const derived = (await ctx.save(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;' })).json();
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
    const derived = (await ctx.save(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;' })).json();
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

// 2way 리뷰 4회차 (R4-01): 행 ID 는 가장 큰 ID 의 버전을 지우면 다시 쓰이므로, ID 만으로는 미리보기한 그 기준 버전인지 알 수 없다.
// 미리보기가 기준 버전의 지문(스키마 ID·버전 번호·저장된 모델 해시)을 돌려주고, 저장은 그 지문을 expectedBase 로 되돌려 보내야 한다.
// 2way 리뷰 5회차 (R5-01): 스키마까지 통째로 지우면 스키마 ID·버전 번호·행 ID 를 처음부터 다시 쓰고, 모델 해시는 테이블·뷰·루틴만 보므로 같은 구조를
// 다른 스키마에 올리면 세 필드가 모두 같아진다. 지문에 버전을 만든 시각과 데이터베이스·스키마 이름을 더한다
describe('POST /versions/:id/alter — 기준 버전 지문', () => {
  const SCRIPT = 'ALTER TABLE member ADD x INT;';
  const REPLACEMENT = dump('shop', TABLE.replace('`name`', '`title`'));
  const removeVersion = (ctx: Ctx, id: number) => ctx.app.inject({ method: 'DELETE', url: `/api/versions/${id}`, headers: ctx.admin });
  const removeSchema = (ctx: Ctx) => ctx.app.inject({ method: 'DELETE', url: `/api/schemas/${ctx.schemaId}`, headers: ctx.admin, payload: { confirmName: 'shop' } });
  afterEach(() => {
    vi.useRealTimers(); // 시각을 고정한 테스트가 중간에 실패해도 다음 테스트는 실제 시각을 쓴다
  });
  // 미리보기를 낸 상태. stale 은 그때 받은 지문이다
  async function previewed() {
    const ctx = await setup();
    const preview = await ctx.alter(ctx.baseId, { script: SCRIPT, dryRun: true });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().base, '미리보기가 기준 버전 지문을 돌려준다').toBeDefined();
    return { ctx, stale: preview.json().base as ReturnType<typeof previewBaseOf> };
  }
  const expectStale = (res: Awaited<ReturnType<Ctx['alter']>>, stale: { modelHash: string }) => {
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toContain('기준 버전이 바뀌었습니다');
    expect(res.json().error).toContain('미리보기를 다시 실행');
    expect(res.body).not.toContain(stale.modelHash); // 저장된 값을 알려 주지 않는다
  };

  it('미리보기가 돌려주는 지문은 저장된 스키마 ID·버전 번호·모델 해시·버전을 만든 시각과 데이터베이스·스키마 이름이다', async () => {
    const { ctx, stale } = await previewed();
    const stored = one<{ model_hash: string; uploaded_at: string }>(ctx.db, 'SELECT model_hash, uploaded_at FROM schema_versions WHERE id = ?', ctx.baseId)!;
    expect(stale).toEqual({ schemaId: ctx.schemaId, versionNo: 1, modelHash: stored.model_hash, uploadedAt: stored.uploaded_at, databaseName: 'db-01', schemaName: 'shop', latestVersionNo: 1 });
  });

  it('미리보기가 돌려준 지문을 그대로 보내면 저장된다 (그 사이 더 새 버전이 생긴 경우는 아래 M-2)', async () => {
    const { ctx, stale } = await previewed();
    const res = await ctx.alter(ctx.baseId, { script: SCRIPT, expectedBase: stale });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', versionNo: 2 });
    expect(await columnsOf(ctx, res.json().versionId)).toEqual(['id', 'name', 'x']);
  });

  it('가장 큰 ID 의 기준 버전을 지우고 다시 올려 ID 가 재사용되면, 미리보기의 지문으로 저장할 때 409 이고 새 버전은 만들어지지 않는다', async () => {
    const { ctx, stale } = await previewed();
    expect((await removeVersion(ctx, ctx.baseId)).statusCode).toBe(200);
    const replacement = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'shop', filename: 'shop.sql', text: REPLACEMENT, userId: 1 });
    expect(replacement).toMatchObject({ status: 'ok', versionId: ctx.baseId, versionNo: 2 }); // 행 ID 는 같고, 버전 번호는 이어진다
    const res = await ctx.alter(ctx.baseId, { script: SCRIPT, expectedBase: stale });
    expectStale(res, stale);
    expect(versionCount(ctx.db)).toBe(1);
    expect(derivationCount(ctx.db)).toBe(0);
    // 새 미리보기가 돌려주는 지문으로는 저장된다: 바뀐 기준(id, title) 위에 적용한 결과다
    const fresh = (await ctx.alter(ctx.baseId, { script: SCRIPT, dryRun: true })).json().base;
    expect(fresh).toMatchObject({ schemaId: stale.schemaId, versionNo: 2 });
    expect(fresh.modelHash).not.toBe(stale.modelHash);
    const saved = await ctx.alter(ctx.baseId, { script: SCRIPT, expectedBase: fresh });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await columnsOf(ctx, saved.json().versionId)).toEqual(['id', 'title', 'x']);
  });

  it('같은 내용을 다시 올려 모델 해시가 같아도 버전 번호가 다르면 다른 버전이다 — 409', async () => {
    const { ctx, stale } = await previewed();
    expect((await removeVersion(ctx, ctx.baseId)).statusCode).toBe(200);
    const again = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'shop', filename: 'shop.sql', text: dump('shop'), userId: 1 });
    expect(again).toMatchObject({ status: 'ok', versionId: ctx.baseId, versionNo: 2 });
    expect(fingerprintOf(ctx.db, ctx.baseId)).toMatchObject({ schemaId: stale.schemaId, modelHash: stale.modelHash });
    expectStale(await ctx.alter(ctx.baseId, { script: SCRIPT, expectedBase: stale }), stale);
    expect(versionCount(ctx.db)).toBe(1);
  });

  it('다른 스키마가 그 행 ID 를 물려받아도 409 — 미리보기한 스키마가 아닌 곳에 파생 버전을 만들지 않는다', async () => {
    const { ctx, stale } = await previewed();
    expect((await removeVersion(ctx, ctx.baseId)).statusCode).toBe(200);
    const other = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'other', filename: 'other.sql', text: dump('other'), userId: 1 });
    expect(other.versionId).toBe(ctx.baseId);
    expect(fingerprintOf(ctx.db, other.versionId).schemaId).not.toBe(stale.schemaId);
    expectStale(await ctx.alter(ctx.baseId, { script: SCRIPT, expectedBase: stale }), stale);
    expect(versionCount(ctx.db)).toBe(1);
    expect(derivationCount(ctx.db)).toBe(0);
  });

  it('스키마를 통째로 지우고 같은 이름으로 다시 올려 스키마 ID·버전 번호·행 ID 가 모두 같아져도, 모델이 다르면 409 — 지문의 모델 해시가 가린다', async () => {
    const { ctx, stale } = await previewed();
    const removed = await ctx.app.inject({ method: 'DELETE', url: `/api/schemas/${ctx.schemaId}`, headers: ctx.admin, payload: { confirmName: 'shop' } });
    expect(removed.statusCode, removed.body).toBe(200);
    const replacement = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'shop', filename: 'shop.sql', text: REPLACEMENT, userId: 1 });
    expect(replacement).toMatchObject({ versionId: ctx.baseId, versionNo: 1 });
    expect(fingerprintOf(ctx.db, ctx.baseId)).toMatchObject({ schemaId: stale.schemaId, versionNo: stale.versionNo }); // 모델 해시만 다르다
    expectStale(await ctx.alter(ctx.baseId, { script: SCRIPT, expectedBase: stale }), stale);
    expect(versionCount(ctx.db)).toBe(1);
  });

  it('스키마를 통째로 지우고 같은 구조를 다른 이름의 스키마에 올려 스키마 ID·버전 번호·행 ID·모델 해시가 모두 같아져도 409 — 다른 스키마에 파생 버전을 만들지 않는다', async () => {
    const { ctx, stale } = await previewed();
    expect((await removeSchema(ctx)).statusCode).toBe(200);
    const other = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'other', filename: 'other.sql', text: dump('other'), userId: 1 });
    expect(other).toMatchObject({ status: 'ok', versionId: ctx.baseId, versionNo: 1 });
    expect(fingerprintOf(ctx.db, ctx.baseId)).toMatchObject({ schemaId: stale.schemaId, versionNo: stale.versionNo, modelHash: stale.modelHash });
    expectStale(await ctx.alter(ctx.baseId, { script: SCRIPT, expectedBase: stale }), stale);
    expect(versionCount(ctx.db)).toBe(1);
    expect(derivationCount(ctx.db)).toBe(0);
  });

  it('같은 데이터베이스·같은 이름·같은 구조로 다시 만들어 이름까지 같아져도, 버전을 만든 시각이 달라 409', async () => {
    const { ctx, stale } = await previewed();
    expect((await removeSchema(ctx)).statusCode).toBe(200);
    // 다시 올리는 시각을 미리보기한 버전을 만든 시각과 다르게 둔다 (같은 밀리초에 지우고 다시 올리지는 않는다)
    const later = Date.parse(stale.uploadedAt) + 60_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(later);
    const again = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'shop', filename: 'shop.sql', text: dump('shop'), userId: 1 });
    vi.useRealTimers();
    expect(again).toMatchObject({ status: 'ok', versionId: ctx.baseId, versionNo: 1 });
    const { uploadedAt, ...rest } = fingerprintOf(ctx.db, ctx.baseId);
    expect(rest).toEqual({ schemaId: stale.schemaId, versionNo: stale.versionNo, modelHash: stale.modelHash, databaseName: stale.databaseName, schemaName: stale.schemaName });
    expect(uploadedAt).toBe(new Date(later).toISOString());
    expectStale(await ctx.alter(ctx.baseId, { script: SCRIPT, expectedBase: stale }), stale);
    expect(versionCount(ctx.db)).toBe(1);
    expect(derivationCount(ctx.db)).toBe(0);
  });

  it('미리보기에 expectedBase 를 보내도 대조한다 — 맞으면 지문을 돌려주고, 어긋나면 409', async () => {
    const { ctx, stale } = await previewed();
    const ok = await ctx.alter(ctx.baseId, { script: SCRIPT, dryRun: true, expectedBase: stale });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().base).toEqual(stale);
    expectStale(await ctx.alter(ctx.baseId, { script: SCRIPT, dryRun: true, expectedBase: { ...stale, modelHash: '0'.repeat(64) } }), stale);
    expectStale(await ctx.alter(ctx.baseId, { script: SCRIPT, dryRun: true, expectedBase: { ...stale, versionNo: stale.versionNo + 1 } }), stale);
    expectStale(await ctx.alter(ctx.baseId, { script: SCRIPT, dryRun: true, expectedBase: { ...stale, schemaId: stale.schemaId + 1 } }), stale);
    expectStale(await ctx.alter(ctx.baseId, { script: SCRIPT, dryRun: true, expectedBase: { ...stale, uploadedAt: '2000-01-01T00:00:00.000Z' } }), stale);
    expectStale(await ctx.alter(ctx.baseId, { script: SCRIPT, dryRun: true, expectedBase: { ...stale, databaseName: 'db-02' } }), stale);
    expectStale(await ctx.alter(ctx.baseId, { script: SCRIPT, dryRun: true, expectedBase: { ...stale, schemaName: 'other' } }), stale);
  });

  it('저장에는 expectedBase 가 필요하다 — 없으면 400 이고 아무것도 만들지 않는다. 미리보기에는 필요 없다', async () => {
    const { ctx } = await previewed();
    for (const payload of [{ script: SCRIPT }, { script: SCRIPT, dryRun: false }]) {
      const res = await ctx.alter(ctx.baseId, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toContain('expectedBase');
    }
    expect(versionCount(ctx.db)).toBe(1);
    expect((await ctx.alter(ctx.baseId, { script: SCRIPT, dryRun: true })).statusCode).toBe(200);
  });

  it('expectedBase 의 형식이 틀리면 400 (미리보기도 같다)', async () => {
    const { ctx, stale } = await previewed();
    const malformed: [string, unknown][] = [
      ['객체가 아님', 'x'], ['null', null], ['필드 없음', { schemaId: 1 }], ['소수 스키마 ID', { ...stale, schemaId: 1.5 }], ['0 버전 번호', { ...stale, versionNo: 0 }],
      ['문자열 버전 번호', { ...stale, versionNo: '1' }], ['빈 해시', { ...stale, modelHash: '' }], ['숫자 해시', { ...stale, modelHash: 5 }], ['너무 긴 해시', { ...stale, modelHash: 'a'.repeat(129) }],
      ['시각 없음', { ...stale, uploadedAt: undefined }], ['숫자 시각', { ...stale, uploadedAt: 0 }], ['너무 긴 시각', { ...stale, uploadedAt: 'a'.repeat(257) }],
      ['빈 데이터베이스 이름', { ...stale, databaseName: '' }], ['스키마 이름 없음', { ...stale, schemaName: undefined }], ['너무 긴 스키마 이름', { ...stale, schemaName: 's'.repeat(257) }],
      ['최신 버전 번호 없음', { ...stale, latestVersionNo: undefined }], ['소수 최신 버전 번호', { ...stale, latestVersionNo: 1.5 }], ['문자열 최신 버전 번호', { ...stale, latestVersionNo: '1' }],
    ];
    for (const [label, expectedBase] of malformed) {
      for (const dryRun of [true, false]) {
        const res = await ctx.alter(ctx.baseId, { script: SCRIPT, dryRun, expectedBase });
        expect(res.statusCode, `${label} dryRun ${dryRun}: ${res.body}`).toBe(400);
        expect(res.json().details[0].path, label).toMatch(/^expectedBase/);
      }
    }
    expect(versionCount(ctx.db)).toBe(1);
  });
});

// 2way 리뷰 5회차 (M-2): 대화상자를 연 동안 다른 사용자가 같은 기준에서 더 새 버전을 저장해도, 지문은 기준 버전만 보므로 옛 미리보기가 그대로 저장돼
// 최신 버전에서 그 변경이 조용히 빠졌다. 미리보기가 그때 스키마의 최신 SQL 버전 번호(latestVersionNo)를 함께 돌려주고, 저장할 때 기준 버전이 그때 최신이었는데
// 더 새 SQL 버전이 생겼으면 409 로 막는다. 미리보기 때 이미 더 새 버전이 있던 옛 기준 버전을 고른 것은 일부러 고른 것이라 막지 않는다
describe('POST /versions/:id/alter — 미리보기 뒤에 저장된 더 새 버전', () => {
  const SCRIPT = 'ALTER TABLE member ADD x INT;';
  const REPLACEMENT = dump('shop', TABLE.replace('`name`', '`title`'));
  const preview = async (ctx: Ctx, id: number, script = SCRIPT, headers: Record<string, string> = ctx.admin) => {
    const res = await ctx.alter(id, { script, dryRun: true }, headers);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().base as ReturnType<typeof previewBaseOf>;
  };
  const expectNewer = (res: Awaited<ReturnType<Ctx['alter']>>, latest: { id: number; versionNo: number }) => {
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toContain(`다른 사용자가 더 새 버전(v${latest.versionNo})을 저장했습니다`);
    expect(res.json().error).toContain('최신 버전에서 미리보기를 다시 실행하세요');
    expect(res.json().details).toEqual({ latestVersion: latest }); // 화면이 그 버전으로 기준 버전을 옮긴다
  };

  it('미리보기 때 최신이던 기준 버전 뒤에 다른 사용자가 더 새 버전을 저장했으면 409 — 옛 미리보기로 저장해 최신 버전에서 그 변경이 빠지지 않게 한다', async () => {
    const ctx = await setup();
    const mine = await preview(ctx, ctx.baseId, 'ALTER TABLE member ADD a INT;');
    expect(mine).toMatchObject({ versionNo: 1, latestVersionNo: 1 });
    const theirs = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD b INT;', expectedBase: await preview(ctx, ctx.baseId, 'ALTER TABLE member ADD b INT;', ctx.dba) }, ctx.dba);
    expect(theirs.json()).toMatchObject({ status: 'ok', versionNo: 2 });
    expectNewer(await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD a INT;', expectedBase: mine }), { id: theirs.json().versionId, versionNo: 2 });
    expect(versionCount(ctx.db)).toBe(2);
    expect(derivationCount(ctx.db)).toBe(1);
    // 최신 버전에서 다시 낸 미리보기로는 저장되고, 앞 사람의 변경이 남는다
    const again = await preview(ctx, theirs.json().versionId, 'ALTER TABLE member ADD a INT;');
    const saved = await ctx.alter(theirs.json().versionId, { script: 'ALTER TABLE member ADD a INT;', expectedBase: again });
    expect(saved.json()).toMatchObject({ status: 'ok', versionNo: 3 });
    expect(await columnsOf(ctx, saved.json().versionId)).toEqual(['id', 'name', 'b', 'a']);
  });

  it('업로드로 올라온 SQL 버전도 더 새 버전이다 — MD 버전은 ALTER 의 기준이 될 수 없어 세지 않는다', async () => {
    const ctx = await setup();
    const mine = await preview(ctx, ctx.baseId);
    ingest(ctx.db, { databaseName: 'db-01', schemaName: 'shop', filename: SAMPLE_MD, text: sampleText(SAMPLE_MD), userId: 1 }); // v2 (MD)
    const saved = await ctx.alter(ctx.baseId, { script: SCRIPT, expectedBase: mine });
    expect(saved.json()).toMatchObject({ status: 'ok', versionNo: 3 });
    const next = await preview(ctx, saved.json().versionId, 'ALTER TABLE member ADD y INT;');
    expect(next).toMatchObject({ versionNo: 3, latestVersionNo: 3 });
    const uploaded = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'shop', filename: 'shop.sql', text: REPLACEMENT, userId: 1 }); // v4 (SQL)
    expectNewer(await ctx.alter(saved.json().versionId, { script: 'ALTER TABLE member ADD y INT;', expectedBase: next }), { id: uploaded.versionId, versionNo: 4 });
    expect(versionCount(ctx.db)).toBe(4);
  });

  it('미리보기 때 이미 더 새 버전이 있던 옛 기준 버전을 고른 것은 일부러 고른 것이라, 그 뒤에 새 버전이 더 생겨도 저장된다', async () => {
    const ctx = await setup();
    ingest(ctx.db, { databaseName: 'db-01', schemaName: 'shop', filename: 'shop.sql', text: REPLACEMENT, userId: 1 }); // v2
    const mine = await preview(ctx, ctx.baseId);
    expect(mine).toMatchObject({ versionNo: 1, latestVersionNo: 2 });
    ingest(ctx.db, { databaseName: 'db-01', schemaName: 'shop', filename: 'shop.sql', text: dump('shop', TABLE.replace('`name`', '`label`')), userId: 1 }); // v3
    const res = await ctx.alter(ctx.baseId, { script: SCRIPT, expectedBase: mine });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', versionNo: 4 });
    expect(await columnsOf(ctx, res.json().versionId)).toEqual(['id', 'name', 'x']);
  });

  it('미리보기에 expectedBase 를 보내도 같은 규칙으로 대조한다. 새 미리보기는 지금의 최신 SQL 버전 번호를 돌려준다', async () => {
    const ctx = await setup();
    const mine = await preview(ctx, ctx.baseId);
    const uploaded = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'shop', filename: 'shop.sql', text: REPLACEMENT, userId: 1 }); // v2
    expectNewer(await ctx.alter(ctx.baseId, { script: SCRIPT, dryRun: true, expectedBase: mine }), { id: uploaded.versionId, versionNo: 2 });
    expect(await preview(ctx, ctx.baseId)).toEqual({ ...mine, latestVersionNo: 2 });
    expect(versionCount(ctx.db)).toBe(2);
  });
});

// 2way 리뷰 5회차 (M-1): SET SQL_MODE 없이 만든 루틴은 스크립트를 실행한 서버의 sql_mode 를 기억하는데, 늘 MySQL 기본 모드로 두어 서버 sql_mode 가 기본과
// 다르면 틀린 모델이 됐다. 서버는 기준 버전 루틴의 SQL_MODE 최빈값을 처음 세션 SQL_MODE 로 준다 (루틴이 없으면 지금처럼 MySQL 기본 모드)
describe('POST /versions/:id/alter — SET SQL_MODE 없이 만든 루틴의 SQL_MODE', () => {
  const RELAXED = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
  const DEFAULT_MODE = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
  const NEW_PROC = 'DELIMITER $$\nCREATE PROCEDURE sp_new()\nBEGIN\n  SELECT 1;\nEND$$\nDELIMITER ;';
  // td-export 0.1.52 꼴 루틴 블록 (mode 가 없으면 0.1.52 전 꼴 — 루틴의 SQL_MODE 를 남기지 않는다)
  const routine = (name: string, mode?: string) => [
    ...(mode === undefined ? [] : [`SET @OLD_ROUTINE_SQL_MODE = @@SQL_MODE, SQL_MODE = '${mode}';`]),
    'DELIMITER ;;', `CREATE DEFINER=\`root\`@\`%\` PROCEDURE \`${name}\`()\nBEGIN\n  SELECT 1;\nEND ;;`, 'DELIMITER ;',
    ...(mode === undefined ? [] : ['SET SQL_MODE = @OLD_ROUTINE_SQL_MODE;']),
  ].join('\n');
  const baseWith = (ctx: Ctx, routines: string[]) =>
    ingest(ctx.db, { databaseName: 'db-01', schemaName: 'routines', filename: 'routines.sql', text: dump('routines', [...routines, '', TABLE].join('\n')), userId: 1 }).versionId;
  const modeOf = async (ctx: Ctx, versionId: number, name: string) => {
    const detail = (await ctx.app.inject({ method: 'GET', url: `/api/versions/${versionId}`, headers: ctx.viewer })).json();
    return (detail.model.routines as { name: string; sqlMode?: string }[]).find((r) => r.name === name)?.sqlMode;
  };
  const saveNew = async (ctx: Ctx, baseId: number, script = NEW_PROC) => {
    const res = await ctx.save(baseId, { script });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().versionId as number;
  };

  it('기준 버전 루틴의 SQL_MODE 최빈값을 쓴다 — 같은 서버에서 SET SQL_MODE 없이 만든 루틴과 같은 값이다', async () => {
    const ctx = await setup();
    const baseId = baseWith(ctx, [routine('sp_a', RELAXED), routine('sp_b', RELAXED), routine('sp_c', DEFAULT_MODE)]);
    expect(await modeOf(ctx, baseId, 'sp_a')).toBe(RELAXED);
    const id = await saveNew(ctx, baseId);
    expect(await modeOf(ctx, id, 'sp_new')).toBe(RELAXED);
    const source = (await ctx.app.inject({ method: 'GET', url: `/api/versions/${id}/source`, headers: ctx.viewer })).body;
    expect(source).toContain(`SQL_MODE = '${RELAXED}';\nDELIMITER ;;\nCREATE PROCEDURE \`sp_new\``);
    // 다음 추출과 견줘도 sp_new 의 SQL_MODE 가 바뀌지 않는다
    const diff = (await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${baseId}&target=${id}`, headers: ctx.viewer })).json();
    expect(diff.ddl).toContain(`SQL_MODE = '${RELAXED}'`);
  });

  it('스크립트의 SET SQL_MODE 가 앞선다', async () => {
    const ctx = await setup();
    const baseId = baseWith(ctx, [routine('sp_a', RELAXED)]);
    const id = await saveNew(ctx, baseId, `SET SQL_MODE = 'NO_ENGINE_SUBSTITUTION';\n${NEW_PROC}`);
    expect(await modeOf(ctx, id, 'sp_new')).toBe('NO_ENGINE_SUBSTITUTION');
  });

  it('루틴이 없거나 루틴에 SQL_MODE 기록이 없으면(td-export 0.1.52 전) 지금처럼 MySQL 기본 모드다', async () => {
    const ctx = await setup();
    expect(await modeOf(ctx, await saveNew(ctx, ctx.baseId), 'sp_new')).toBe(DEFAULT_MODE);
    const legacy = baseWith(ctx, [routine('sp_a'), routine('sp_b')]);
    expect(await modeOf(ctx, legacy, 'sp_a')).toBeUndefined();
    expect(await modeOf(ctx, await saveNew(ctx, legacy), 'sp_new')).toBe(DEFAULT_MODE);
  });

  it('처음 세션 SQL_MODE 로 쓸 수 없는 값(묶음 모드·ANSI_QUOTES 등)의 루틴은 세지 않고, 그런 루틴뿐이어도 ALTER 는 받는다', async () => {
    const ctx = await setup();
    const traditional = 'STRICT_TRANS_TABLES,STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,TRADITIONAL,NO_ENGINE_SUBSTITUTION';
    const mixed = baseWith(ctx, [routine('sp_a', traditional), routine('sp_b', traditional), routine('sp_c', 'ANSI_QUOTES'), routine('sp_d', RELAXED)]);
    expect(await modeOf(ctx, await saveNew(ctx, mixed), 'sp_new')).toBe(RELAXED);
    const unusable = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'odd', filename: 'odd.sql', text: dump('odd', [routine('sp_a', traditional), '', TABLE].join('\n')), userId: 1 }).versionId;
    const altered = await ctx.save(unusable, { script: 'ALTER TABLE member ADD x INT;' });
    expect(altered.json()).toMatchObject({ status: 'ok' });
    expect(await modeOf(ctx, await saveNew(ctx, altered.json().versionId), 'sp_new')).toBe(DEFAULT_MODE);
  });
});
