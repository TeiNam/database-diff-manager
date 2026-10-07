import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { openDb } from '../src/db/connection';
import { TEST_CONFIG } from './helpers';

function webDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tdm-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  return dir;
}

describe('웹 정적 서빙', () => {
  it('정적 파일·SPA 폴백·API 404 구분', async () => {
    const app = await buildApp({ db: openDb(':memory:'), config: { ...TEST_CONFIG, webDist: webDist() } }, { logger: false });
    expect((await app.inject({ method: 'GET', url: '/' })).body).toContain('id="root"');
    expect((await app.inject({ method: 'GET', url: '/assets/app.js' })).body).toBe('console.log(1)');
    const deep = await app.inject({ method: 'GET', url: '/db/1/schema/2?base=1&target=2' });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers['content-type']).toContain('text/html');
    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: '요청한 경로를 찾을 수 없습니다' });
  });

  it('/api 와 /api?x=1 은 SPA 폴백이 아니라 JSON 404', async () => {
    const app = await buildApp({ db: openDb(':memory:'), config: { ...TEST_CONFIG, webDist: webDist() } }, { logger: false });
    for (const url of ['/api', '/api?x=1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: '요청한 경로를 찾을 수 없습니다' });
    }
  });

  it('webDist가 없으면 API만 동작하고 다른 경로도 JSON 404', async () => {
    const app = await buildApp({ db: openDb(':memory:'), config: { ...TEST_CONFIG, webDist: join(tmpdir(), 'no-such-dir-tdm') } }, { logger: false });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeDefined();
  });
});
