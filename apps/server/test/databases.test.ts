import { describe, expect, it } from 'vitest';
import { ensureDatabase, ensureSchema } from '../src/repos/catalog';
import { loggedInApp } from './helpers';

describe('/api/databases', () => {
  it('생성·중복·수정·삭제 확인', async () => {
    const { app, admin, viewer } = await loggedInApp();
    expect((await app.inject({ method: 'POST', url: '/api/databases', headers: viewer, payload: { name: 'prod' } })).statusCode).toBe(403);

    const created = await app.inject({ method: 'POST', url: '/api/databases', headers: admin, payload: { name: 'prod-db-01', description: '운영' } });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();
    expect((await app.inject({ method: 'POST', url: '/api/databases', headers: admin, payload: { name: 'prod-db-01' } })).statusCode).toBe(409);

    const patched = await app.inject({ method: 'PATCH', url: `/api/databases/${id}`, headers: admin, payload: { description: '운영 1호기' } });
    expect(patched.json()).toMatchObject({ name: 'prod-db-01', description: '운영 1호기' });

    const wrong = await app.inject({ method: 'DELETE', url: `/api/databases/${id}`, headers: admin, payload: { confirmName: 'prod' } });
    expect(wrong.statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/databases/${id}`, headers: admin, payload: { confirmName: 'prod-db-01' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/databases/${id}`, headers: admin, payload: { name: 'x' } })).statusCode).toBe(404);
  });
});

describe('GET /api/tree', () => {
  it('Database → Schema 목록, 버전이 없으면 latestVersion null', async () => {
    const { app, db, viewer } = await loggedInApp();
    const dbId = ensureDatabase(db, 'prod-db-01');
    ensureSchema(db, dbId, 'shop');
    ensureSchema(db, dbId, 'billing');
    ensureDatabase(db, 'stg-db-01');
    expect(ensureDatabase(db, 'prod-db-01')).toBe(dbId);

    const tree = (await app.inject({ method: 'GET', url: '/api/tree', headers: viewer })).json();
    expect(tree.map((d: { name: string }) => d.name)).toEqual(['prod-db-01', 'stg-db-01']);
    expect(tree[0].schemas.map((s: { name: string; latestVersion: unknown }) => [s.name, s.latestVersion])).toEqual([['billing', null], ['shop', null]]);
    expect(tree[1].schemas).toEqual([]);

    const schemaId = tree[0].schemas[1].id;
    expect((await app.inject({ method: 'GET', url: `/api/schemas/${schemaId}`, headers: viewer })).json()).toEqual({
      id: schemaId, name: 'shop', databaseId: dbId, databaseName: 'prod-db-01',
    });
  });
});
