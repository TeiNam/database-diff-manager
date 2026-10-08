import { describe, expect, it } from 'vitest';
import { getVersionMeta } from '../src/repos/versions';
import { ingest } from '../src/services/ingest';
import { dmsFixture, loggedInApp, multipart } from './helpers';

// dba 는 계정 관리를 뺀 모든 데이터 변경을 실제로 할 수 있다
describe('dba 역할', () => {
  it('업로드·Database 생성/수정/삭제·버전/Schema 삭제·rename 저장·전환 매핑 올리기/삭제', async () => {
    const ctx = await loggedInApp();
    const { app, dba } = ctx;
    const file = 's.sql';
    const upload = (content: string, schemaName: string) => {
      const body = multipart({ meta: JSON.stringify([{ filename: file, databaseName: 'db', schemaName }]) }, [{ filename: file, content }]);
      return app.inject({ method: 'POST', url: '/api/uploads', headers: { ...dba, ...body.headers }, payload: body.payload });
    };
    const v1 = (await upload('CREATE TABLE `members` (\n  `id` int NOT NULL\n);', 'app')).json().results[0];
    expect(v1).toMatchObject({ status: 'ok', versionNo: 1 });
    const v2 = (await upload('CREATE TABLE `member` (\n  `id` int NOT NULL\n);', 'app')).json().results[0].versionId;

    const saved = await app.inject({ method: 'PUT', url: '/api/diff/renames', headers: dba, payload: { base: v1.versionId, target: v2, renames: [{ kind: 'table', from: 'members', to: 'member' }] } });
    expect(saved.statusCode).toBe(200);

    const asIs = ingest(ctx.db, { databaseName: 'db', schemaName: 'legacy', filename: 'as-is.sql', text: dmsFixture('as-is.sql'), userId: 1 });
    const toBe = ingest(ctx.db, { databaseName: 'db', schemaName: 'newapp', filename: 'to-be.sql', text: dmsFixture('to-be.sql'), userId: 1 });
    const pair = { fromSchemaId: getVersionMeta(ctx.db, asIs.versionId).schemaId, toSchemaId: getVersionMeta(ctx.db, toBe.versionId).schemaId };
    const mapping = await app.inject({ method: 'POST', url: '/api/migrations', headers: dba, payload: { ...pair, filename: 'mapping.json', source: dmsFixture('mapping.json') } });
    expect(mapping.statusCode).toBe(201);
    expect(mapping.json().migration.uploadedBy).toBe('dba');
    expect((await app.inject({ method: 'DELETE', url: `/api/migrations/${mapping.json().migration.id}`, headers: dba })).statusCode).toBe(200);

    expect((await app.inject({ method: 'DELETE', url: `/api/versions/${v2}`, headers: dba })).statusCode).toBe(200);
    const schemaId = getVersionMeta(ctx.db, v1.versionId).schemaId;
    expect((await app.inject({ method: 'DELETE', url: `/api/schemas/${schemaId}`, headers: dba, payload: { confirmName: 'app' } })).statusCode).toBe(200);

    const created = await app.inject({ method: 'POST', url: '/api/databases', headers: dba, payload: { name: 'stg' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await app.inject({ method: 'PATCH', url: `/api/databases/${id}`, headers: dba, payload: { description: '스테이징' } })).json().description).toBe('스테이징');
    expect((await app.inject({ method: 'DELETE', url: `/api/databases/${id}`, headers: dba, payload: { confirmName: 'stg' } })).statusCode).toBe(200);
  });

  it('계정 관리는 할 수 없다 (403)', async () => {
    const { app, dba } = await loggedInApp();
    expect((await app.inject({ method: 'POST', url: '/api/users', headers: dba, payload: { username: 'x.user', password: 'long-password-1', role: 'admin' } })).statusCode).toBe(403);
  });

  it('같은 버전끼리는 rename 매핑을 저장할 수 없다 (400)', async () => {
    const ctx = await loggedInApp();
    const v = ingest(ctx.db, { databaseName: 'db', schemaName: 'app', filename: 'a.sql', text: 'CREATE TABLE `t` (\n  `x` int\n);', userId: 1 });
    const res = await ctx.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: ctx.dba, payload: { base: v.versionId, target: v.versionId, renames: [{ kind: 'table', from: 'a', to: 'b' }] } });
    expect(res.statusCode).toBe(400);
  });
});
