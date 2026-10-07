import { describe, expect, it } from 'vitest';
import { loggedInApp, multipart, SAMPLE_MD, SAMPLE_SQL, sampleText } from './helpers';

const META = (filenames: string[]) => JSON.stringify(filenames.map((filename) => ({ filename, databaseName: '10.0.0.15', schemaName: 'sample-app' })));

async function uploadFiles(app: Awaited<ReturnType<typeof loggedInApp>>['app'], headers: Record<string, string>, files: { filename: string; content: string | Buffer }[], meta = META(files.map((f) => f.filename))) {
  const body = multipart({ meta }, files);
  return app.inject({ method: 'POST', url: '/api/uploads', headers: { ...headers, ...body.headers }, payload: body.payload });
}

describe('POST /api/uploads', () => {
  it('여러 파일을 파일별 결과로 처리한다 (SQL v1, MD v2, 같은 SQL 재업로드 duplicate)', async () => {
    const { app, admin } = await loggedInApp();
    const first = await uploadFiles(app, admin, [
      { filename: SAMPLE_SQL, content: sampleText(SAMPLE_SQL) },
      { filename: SAMPLE_MD, content: sampleText(SAMPLE_MD) },
    ]);
    expect(first.statusCode).toBe(200);
    expect(first.json().results.map((r: { status: string; versionNo: number }) => [r.status, r.versionNo])).toEqual([['ok', 1], ['ok', 2]]);

    const again = await uploadFiles(app, admin, [{ filename: SAMPLE_MD, content: sampleText(SAMPLE_MD) }]);
    expect(again.json().results[0]).toMatchObject({ status: 'duplicate', versionNo: 2, versionId: first.json().results[1].versionId });
  });

  it('UTF-8이 아니거나 메타가 없거나 형식이 틀린 파일은 그 파일만 error', async () => {
    const { app, admin } = await loggedInApp();
    const res = await uploadFiles(app, admin, [
      { filename: 'bad.sql', content: Buffer.from([0xff, 0xfe, 0x00]) },
      { filename: 'ok.sql', content: 'CREATE TABLE `a` (\n  `x` int\n);' },
      { filename: 'orphan.sql', content: 'x' },
      { filename: 'sheet.xlsx', content: 'x' },
    ], META(['bad.sql', 'ok.sql', 'sheet.xlsx']));
    const results = res.json().results;
    expect(results.map((r: { filename: string; status: string }) => [r.filename, r.status])).toEqual([
      ['bad.sql', 'error'], ['ok.sql', 'ok'], ['sheet.xlsx', 'error'], ['orphan.sql', 'error'],
    ]);
    expect(results[0].message).toContain('UTF-8');
    expect(results[3].message).toContain('메타 정보');
  });

  it('viewer는 403, multipart가 아니거나 meta가 깨지면 400, 20MB 초과는 413', async () => {
    const { app, admin, viewer } = await loggedInApp();
    expect((await uploadFiles(app, viewer, [{ filename: 'a.sql', content: 'x' }])).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/uploads', headers: admin, payload: { a: 1 } })).statusCode).toBe(400);
    expect((await uploadFiles(app, admin, [{ filename: 'a.sql', content: 'x' }], '{not json')).statusCode).toBe(400);
    const huge = await uploadFiles(app, admin, [{ filename: 'big.sql', content: Buffer.alloc(20 * 1024 * 1024 + 1, 0x20) }]);
    expect(huge.statusCode).toBe(413);
  });
});

describe('업로드 견고성', () => {
  it('uploads 모듈을 app보다 먼저 직접 import해도 로드된다 (순환 import 없음)', async () => {
    const mod = await import('../src/routes/uploads');
    expect(typeof mod.uploadRoutes).toBe('function');
  });

  it('한 파일에서 예기치 않은 오류가 나도 다른 파일은 처리되고 200을 돌려준다', async () => {
    const { app, admin, db } = await loggedInApp();
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON databases WHEN NEW.name = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const meta = JSON.stringify([
      { filename: 'a.sql', databaseName: 'boom', schemaName: 's' },
      { filename: 'b.sql', databaseName: 'fine', schemaName: 's' },
    ]);
    const res = await uploadFiles(app, admin, [
      { filename: 'a.sql', content: 'CREATE TABLE `a` (\n  `x` int\n);' },
      { filename: 'b.sql', content: 'CREATE TABLE `a` (\n  `x` int\n);' },
    ], meta);
    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    expect(results[0]).toMatchObject({ status: 'error', message: '파일을 처리하지 못했습니다' });
    expect(results[1].status).toBe('ok');
  });

  it('meta 파일명 검증: 경로 구분자·255자 초과·중복은 400', async () => {
    const { app, admin } = await loggedInApp();
    const send = (filenames: string[]) => uploadFiles(app, admin, [{ filename: 'a.sql', content: 'x' }], META(filenames));
    expect((await send(['../a.sql'])).statusCode).toBe(400);
    expect((await send(['a\\b.sql'])).statusCode).toBe(400);
    expect((await send([`${'a'.repeat(256)}.sql`])).statusCode).toBe(400);
    const dup = await send(['a.sql', 'a.sql']);
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error).toBe('같은 파일명이 meta에 두 번 들어 있습니다');
  });
});

describe('버전 API', () => {
  it('목록·상세·원문·삭제', async () => {
    const { app, admin, viewer } = await loggedInApp();
    await uploadFiles(app, admin, [{ filename: SAMPLE_SQL, content: sampleText(SAMPLE_SQL) }]);
    const tree = (await app.inject({ method: 'GET', url: '/api/tree', headers: viewer })).json();
    const schema = tree[0].schemas[0];
    expect(schema.latestVersion.versionNo).toBe(1);

    const versions = (await app.inject({ method: 'GET', url: `/api/schemas/${schema.id}/versions`, headers: viewer })).json();
    expect(versions[0]).toMatchObject({ versionNo: 1, sourceFormat: 'sql', uploadedBy: 'admin', changedObjects: 33 });

    const detail = (await app.inject({ method: 'GET', url: `/api/versions/${versions[0].id}`, headers: viewer })).json();
    expect(detail.model.tables).toHaveLength(33);
    expect(detail.objects).toHaveLength(33);

    const source = await app.inject({ method: 'GET', url: `/api/versions/${versions[0].id}/source`, headers: viewer });
    expect(source.headers['content-disposition']).toBe(
      `attachment; filename="sample-app(10.0.0.15).sql"; filename*=UTF-8''sample-app%2810.0.0.15%29.sql`,
    );
    expect(source.body).toBe(sampleText(SAMPLE_SQL));

    expect((await app.inject({ method: 'DELETE', url: `/api/versions/${versions[0].id}`, headers: viewer })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/versions/${versions[0].id}`, headers: admin })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/versions/${versions[0].id}`, headers: viewer })).statusCode).toBe(404);
  });

  it('중간 버전을 지워도 changedObjects는 내용(content_hash) 기준이라 과대 계산되지 않는다', async () => {
    const { app, admin, viewer } = await loggedInApp();
    const sql = (type: string) => `CREATE TABLE \`a\` (\n  \`x\` ${type}\n);`;
    for (const type of ['int', 'bigint', 'int']) {
      const res = await uploadFiles(app, admin, [{ filename: `${type}.sql`, content: sql(type) }]);
      expect(res.json().results[0].status).toBe('ok');
    }
    const schemaId = (await app.inject({ method: 'GET', url: '/api/tree', headers: viewer })).json()[0].schemas[0].id;
    const list = async () => (await app.inject({ method: 'GET', url: `/api/schemas/${schemaId}/versions`, headers: viewer })).json();
    const before = await list();
    expect(before.map((v: { changedObjects: number }) => v.changedObjects)).toEqual([1, 1, 1]);

    const v2 = before.find((v: { versionNo: number }) => v.versionNo === 2);
    expect((await app.inject({ method: 'DELETE', url: `/api/versions/${v2.id}`, headers: admin })).statusCode).toBe(200);
    const after = await list();
    expect(after.map((v: { versionNo: number; changedObjects: number }) => [v.versionNo, v.changedObjects])).toEqual([[3, 0], [1, 1]]);
  });

  it('업로드된 Database를 확인명과 함께 삭제하면 트리에서 사라진다 (FK 연쇄 삭제)', async () => {
    const { app, admin, viewer } = await loggedInApp();
    await uploadFiles(app, admin, [{ filename: SAMPLE_SQL, content: sampleText(SAMPLE_SQL) }]);
    const tree = (await app.inject({ method: 'GET', url: '/api/tree', headers: viewer })).json();
    const del = await app.inject({ method: 'DELETE', url: `/api/databases/${tree[0].id}`, headers: admin, payload: { confirmName: tree[0].name } });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/tree', headers: viewer })).json()).toEqual([]);
  });

  it('Schema를 확인명과 함께 삭제하면 버전까지 사라지고 Database는 남는다', async () => {
    const { app, admin, viewer } = await loggedInApp();
    await uploadFiles(app, admin, [{ filename: SAMPLE_SQL, content: sampleText(SAMPLE_SQL) }]);
    const [db] = (await app.inject({ method: 'GET', url: '/api/tree', headers: viewer })).json();
    const schema = db.schemas[0];
    const wrong = await app.inject({ method: 'DELETE', url: `/api/schemas/${schema.id}`, headers: admin, payload: { confirmName: 'nope' } });
    expect(wrong.statusCode).toBe(400);
    const del = await app.inject({ method: 'DELETE', url: `/api/schemas/${schema.id}`, headers: admin, payload: { confirmName: schema.name } });
    expect(del.statusCode).toBe(200);
    const tree = (await app.inject({ method: 'GET', url: '/api/tree', headers: viewer })).json();
    expect(tree.map((d: { name: string; schemas: unknown[] }) => [d.name, d.schemas.length])).toEqual([[db.name, 0]]);
    expect((await app.inject({ method: 'GET', url: `/api/schemas/${schema.id}/versions`, headers: viewer })).statusCode).toBe(404);
  });
});
