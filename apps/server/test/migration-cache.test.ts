import { describe, expect, it, vi } from 'vitest';
import { getVersionMeta } from '../src/repos/versions';
import { ingest } from '../src/services/ingest';
import { dmsFixture, loggedInApp } from './helpers';

// 매핑 원문(최대 20MB)을 읽는 저장소 함수를 감싸 호출 수를 센다
vi.mock('../src/repos/migrations', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/repos/migrations')>();
  return { ...mod, getMigrationSource: vi.fn(mod.getMigrationSource) };
});
const { getMigrationSource } = await import('../src/repos/migrations');
const sourceReads = () => vi.mocked(getMigrationSource).mock.calls.length;

describe('전환 매핑 파싱·flow 캐시', () => {
  it('diff·flow·PUT /diff/renames 를 여러 번 불러도 원문은 한 번만 읽고, 매핑 삭제 뒤엔 다시 읽는다', async () => {
    const ctx = await loggedInApp();
    const put = (schemaName: string, file: string) => {
      const r = ingest(ctx.db, { databaseName: 'db', schemaName, filename: file, text: dmsFixture(file as 'as-is.sql'), userId: 1 });
      return { versionId: r.versionId, schemaId: getVersionMeta(ctx.db, r.versionId).schemaId };
    };
    const asIs = put('legacy', 'as-is.sql');
    const toBe = put('newapp', 'to-be.sql');
    const upload = await ctx.app.inject({ method: 'POST', url: '/api/migrations', headers: ctx.admin, payload: {
      fromSchemaId: asIs.schemaId, toSchemaId: toBe.schemaId, filename: 'mapping.json', source: dmsFixture('mapping.json'),
    } });
    const id = upload.json().migration.id as number;
    const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: ctx.viewer });
    const before = sourceReads();

    for (let i = 0; i < 3; i++) expect((await get(`/api/diff?base=${asIs.versionId}&target=${toBe.versionId}`)).statusCode).toBe(200);
    expect((await get(`/api/diff?base=${toBe.versionId}&target=${asIs.versionId}`)).statusCode).toBe(200);
    for (let i = 0; i < 2; i++) expect((await get(`/api/migration-flow?base=${asIs.versionId}&target=${toBe.versionId}`)).statusCode).toBe(200);
    const saved = await ctx.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: ctx.viewer, payload: { base: asIs.versionId, target: toBe.versionId, renames: [] } });
    expect(saved.statusCode).toBe(200);
    expect(sourceReads() - before).toBe(1);

    await ctx.app.inject({ method: 'POST', url: '/api/migrations', headers: ctx.admin, payload: {
      fromSchemaId: asIs.schemaId, toSchemaId: toBe.schemaId, filename: 'v2.json', source: dmsFixture('mapping.json'),
    } });
    await ctx.app.inject({ method: 'DELETE', url: `/api/migrations/${id}`, headers: ctx.admin });
    const afterChange = sourceReads();
    expect((await get(`/api/diff?base=${asIs.versionId}&target=${toBe.versionId}`)).json().renames).toHaveLength(11);
    expect(sourceReads() - afterChange).toBe(1);
  });
});
