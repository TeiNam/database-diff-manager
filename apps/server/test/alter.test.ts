import { describe, expect, it } from 'vitest';
import { one, run } from '../src/db/connection';
import { loadEvidence, loadStaleReason } from '../src/repos/evidence';
import { listRenames } from '../src/repos/renames';
import { backfillEvidence } from '../src/services/evidence-backfill';
import { ingest } from '../src/services/ingest';
import { CSRF, loggedInApp, SAMPLE_MD, sampleText } from './helpers';

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
