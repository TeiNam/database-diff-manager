import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { ingest } from '../src/services/ingest';
import { loggedInApp, SAMPLE_SQL, sampleText } from './helpers';

type Headers = Record<string, string>;
interface Case {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  payload?: Record<string, unknown>;
  // 역할별 기대 상태. 숫자는 정확히 일치, 'allowed'는 401·403이 아니면 통과
  anon: number;
  viewer: number | 'allowed';
  dba: number | 'allowed';
  admin: number | 'allowed';
}

// 파괴적 동작이 실제로 일어나지 않도록 admin·dba 요청은 잘못된 id·본문으로 검증 단계에서 멈추게 한다
const CASES: Case[] = [
  { method: 'POST', url: '/api/auth/login', payload: {}, anon: 400, viewer: 400, dba: 400, admin: 400 },
  { method: 'GET', url: '/api/auth/me', anon: 401, viewer: 200, dba: 200, admin: 200 },

  { method: 'GET', url: '/api/users', anon: 401, viewer: 403, dba: 403, admin: 200 },
  { method: 'POST', url: '/api/users', payload: {}, anon: 401, viewer: 403, dba: 403, admin: 400 },
  { method: 'PATCH', url: '/api/users/1', payload: {}, anon: 401, viewer: 403, dba: 403, admin: 400 },
  { method: 'PATCH', url: '/api/users/abc', payload: { role: 'viewer' }, anon: 401, viewer: 403, dba: 403, admin: 400 },

  { method: 'GET', url: '/api/tree', anon: 401, viewer: 200, dba: 200, admin: 200 },
  { method: 'GET', url: '/api/schemas/1', anon: 401, viewer: 200, dba: 200, admin: 200 },
  { method: 'GET', url: '/api/schemas/abc', anon: 401, viewer: 400, dba: 400, admin: 400 },
  { method: 'GET', url: '/api/schemas/1/versions', anon: 401, viewer: 200, dba: 200, admin: 200 },

  { method: 'POST', url: '/api/databases', payload: {}, anon: 401, viewer: 403, dba: 400, admin: 400 },
  { method: 'PATCH', url: '/api/databases/1', payload: {}, anon: 401, viewer: 403, dba: 400, admin: 400 },
  { method: 'PATCH', url: '/api/databases/abc', payload: { name: 'x' }, anon: 401, viewer: 403, dba: 400, admin: 400 },
  { method: 'DELETE', url: '/api/databases/1', payload: {}, anon: 401, viewer: 403, dba: 400, admin: 400 },
  { method: 'DELETE', url: '/api/databases/abc', payload: { confirmName: 'x' }, anon: 401, viewer: 403, dba: 400, admin: 400 },
  { method: 'DELETE', url: '/api/schemas/1', payload: {}, anon: 401, viewer: 403, dba: 400, admin: 400 },
  { method: 'DELETE', url: '/api/schemas/abc', payload: { confirmName: 'x' }, anon: 401, viewer: 403, dba: 400, admin: 400 },

  { method: 'POST', url: '/api/uploads', payload: {}, anon: 401, viewer: 403, dba: 400, admin: 400 },

  { method: 'GET', url: '/api/versions/1', anon: 401, viewer: 200, dba: 200, admin: 200 },
  { method: 'GET', url: '/api/versions/abc', anon: 401, viewer: 400, dba: 400, admin: 400 },
  { method: 'GET', url: '/api/versions/1/source', anon: 401, viewer: 200, dba: 200, admin: 200 },
  { method: 'DELETE', url: '/api/versions/abc', anon: 401, viewer: 403, dba: 400, admin: 400 },
  { method: 'DELETE', url: '/api/versions/99999', anon: 401, viewer: 403, dba: 404, admin: 404 },

  { method: 'GET', url: '/api/diff?base=1&target=1', anon: 401, viewer: 'allowed', dba: 'allowed', admin: 'allowed' },
  { method: 'GET', url: '/api/diff?base=abc&target=1', anon: 401, viewer: 400, dba: 400, admin: 400 },
  { method: 'PUT', url: '/api/diff/renames', payload: {}, anon: 401, viewer: 403, dba: 400, admin: 400 },

  { method: 'GET', url: '/api/objects/1/history', anon: 401, viewer: 200, dba: 200, admin: 200 },
  { method: 'GET', url: '/api/objects/abc/history', anon: 401, viewer: 400, dba: 400, admin: 400 },

  { method: 'POST', url: '/api/migrations', payload: {}, anon: 401, viewer: 403, dba: 400, admin: 400 },
  { method: 'GET', url: '/api/migrations?from=1&to=1', anon: 401, viewer: 200, dba: 200, admin: 200 },
  { method: 'GET', url: '/api/migrations?from=abc&to=1', anon: 401, viewer: 400, dba: 400, admin: 400 },
  { method: 'GET', url: '/api/migrations/99999/source', anon: 401, viewer: 404, dba: 404, admin: 404 },
  { method: 'GET', url: '/api/migrations/abc/source', anon: 401, viewer: 400, dba: 400, admin: 400 },
  { method: 'DELETE', url: '/api/migrations/abc', anon: 401, viewer: 403, dba: 400, admin: 400 },
  { method: 'DELETE', url: '/api/migrations/99999', anon: 401, viewer: 403, dba: 404, admin: 404 },
  { method: 'GET', url: '/api/migration-flow?base=1&target=1', anon: 401, viewer: 200, dba: 200, admin: 200 },
  { method: 'GET', url: '/api/migration-flow?base=abc&target=1', anon: 401, viewer: 400, dba: 400, admin: 400 },
  // 로그아웃은 세션을 지우므로 다른 케이스가 끝난 뒤 마지막에 실행한다
  { method: 'POST', url: '/api/auth/logout', anon: 200, viewer: 200, dba: 200, admin: 200 },
];

const CSRF_ONLY: Headers = { 'x-requested-with': 'tdm' };
let app: FastifyInstance;
let viewer: Headers;
let dba: Headers;
let admin: Headers;

beforeAll(async () => {
  const ctx = await loggedInApp();
  ({ app, viewer, dba, admin } = ctx);
  ingest(ctx.db, { databaseName: 'db', schemaName: 'sample-app', filename: SAMPLE_SQL, text: sampleText(SAMPLE_SQL), userId: 1 });
});

const call = (c: Case, headers: Headers) => app.inject({ method: c.method, url: c.url, headers, payload: c.payload });

function expectStatus(actual: number, expected: number | 'allowed') {
  if (expected === 'allowed') expect([401, 403]).not.toContain(actual);
  else expect(actual).toBe(expected);
}

// 업로드 본문 크기·권한 순서: 익명 요청은 본문을 읽기 전에 거절해야 한다
describe('POST /api/migrations 본문 크기와 권한 순서', () => {
  const MB = 1024 * 1024;
  const json = { ...CSRF_ONLY, 'content-type': 'application/json' };
  const uploadBody = (source: string) => JSON.stringify({ fromSchemaId: 1, toSchemaId: 2, filename: 'm.json', source });

  it('익명이 40MB 넘는 본문을 보내도 413 이 아니라 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/migrations', headers: json, payload: 'x'.repeat(41 * MB) });
    expect(res.statusCode).toBe(401);
  });

  it('admin 이 20MB 넘는 source 를 보내면 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/migrations', headers: { ...admin, 'content-type': 'application/json' }, payload: uploadBody('a'.repeat(20 * MB + 1)) });
    expect(res.statusCode).toBe(400);
  });

  it('admin 이 40MB 넘는 본문을 보내면 413', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/migrations', headers: { ...admin, 'content-type': 'application/json' }, payload: uploadBody('a'.repeat(41 * MB)) });
    expect(res.statusCode).toBe(413);
  });
});

describe('PUT /api/diff/renames 권한 순서', () => {
  it('익명이 깨진 JSON 본문을 보내도 400 이 아니라 401 (본문 파싱 전에 거절)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/diff/renames', headers: { ...CSRF_ONLY, 'content-type': 'application/json' }, payload: '{ not json' });
    expect(res.statusCode).toBe(401);
  });

  it('viewer 가 깨진 JSON 본문을 보내도 400 이 아니라 403 (본문 파싱 전에 거절)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/diff/renames', headers: { ...viewer, 'content-type': 'application/json' }, payload: '{ not json' });
    expect(res.statusCode).toBe(403);
  });
});

describe.each(CASES)('$method $url', (c) => {
  it(`익명 ${c.anon}`, async () => expect((await call(c, CSRF_ONLY)).statusCode).toBe(c.anon));
  it(`viewer ${c.viewer}`, async () => expectStatus((await call(c, viewer)).statusCode, c.viewer));
  it(`dba ${c.dba}`, async () => expectStatus((await call(c, dba)).statusCode, c.dba));
  it(`admin ${c.admin}`, async () => expectStatus((await call(c, admin)).statusCode, c.admin));
});
