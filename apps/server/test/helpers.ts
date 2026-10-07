import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import type { Config } from '../src/config';
import { openDb, type Db } from '../src/db/connection';
import { createUser, type Role } from '../src/repos/users';

export const PASSWORD = 'password-1234';
export const CSRF = { 'x-requested-with': 'tdm' };
export const TEST_CONFIG: Config = {
  host: '127.0.0.1', port: 0, dataDir: ':memory:', cookieSecure: false, sessionTtlMs: 12 * 60 * 60 * 1000,
};

export async function testApp(overrides: Partial<Config> = {}): Promise<{ app: FastifyInstance; db: Db }> {
  const db = openDb(':memory:');
  const app = await buildApp({ db, config: { ...TEST_CONFIG, ...overrides } }, { logger: false });
  return { app, db };
}

export async function seedUser(db: Db, username: string, role: Role) {
  return createUser(db, { username, passwordHash: await hashPassword(PASSWORD), role });
}

export async function login(app: FastifyInstance, username: string, password = PASSWORD): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username, password } });
  if (res.statusCode !== 200) throw new Error(`로그인 실패: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'tdm_session');
  return `tdm_session=${cookie!.value}`;
}

export const as = (cookie: string) => ({ cookie, ...CSRF });

// admin·viewer 계정을 만들고 각각 로그인한 앱
export async function loggedInApp() {
  const { app, db } = await testApp();
  await seedUser(db, 'admin', 'admin');
  await seedUser(db, 'viewer', 'viewer');
  return { app, db, admin: as(await login(app, 'admin')), viewer: as(await login(app, 'viewer')) };
}

export const SAMPLE_SQL = 'sample-app(10.0.0.15).sql';
export const SAMPLE_MD = 'sample-app(10.0.0.15).md';

// 업로드 파일명은 td-export 0.1.15 형식을 유지하고, 내용은 core 테스트 픽스처를 공유한다
export function sampleText(name: string): string {
  const kind = name.endsWith('.md') ? 'md' : 'sql';
  return readFileSync(fileURLToPath(new URL(`../../../packages/core/test/fixtures/td-export-0115/sample-app.${kind}`, import.meta.url)), 'utf8');
}

// app.inject 용 multipart/form-data 본문
export function multipart(fields: Record<string, string>, files: { filename: string; content: string | Buffer }[]) {
  const boundary = `----tdm${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
