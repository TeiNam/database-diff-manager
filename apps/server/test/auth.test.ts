import { describe, expect, it } from 'vitest';
import { as, CSRF, login, PASSWORD, seedUser, testApp } from './helpers';

describe('POST /api/auth/login', () => {
  it('성공하면 HttpOnly·SameSite=Strict 쿠키를 주고 me가 사용자를 돌려준다', async () => {
    const { app, db } = await testApp();
    await seedUser(db, 'kim', 'viewer');
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'kim', password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ username: 'kim', role: 'viewer' });
    const cookie = res.cookies.find((c) => c.name === 'tdm_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(cookie.maxAge).toBeUndefined();
    expect(cookie.expires).toBeUndefined();
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `tdm_session=${cookie.value}` } });
    expect(me.json()).toMatchObject({ username: 'kim', role: 'viewer' });
  });

  it('없는 사용자와 틀린 비밀번호는 같은 401 메시지', async () => {
    const { app, db } = await testApp();
    await seedUser(db, 'kim', 'viewer');
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'kim', password: 'nope-nope-nope' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'ghost', password: PASSWORD } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error).toBe(unknown.json().error);
  });

  it('분당 5회를 넘으면 429', async () => {
    const { app } = await testApp();
    const attempt = () => app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'x', password: 'y' } });
    for (let i = 0; i < 5; i++) expect((await attempt()).statusCode).toBe(401);
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toContain('요청이 너무 많습니다');
  });

  it('잘못된 본문은 400', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('입력값이 올바르지 않습니다');
  });
});

describe('세션·CSRF·오류 처리', () => {
  it('로그인 없이 me는 401', async () => {
    const { app } = await testApp();
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
  });

  it('X-Requested-With 없는 변경 요청은 403', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'a', password: 'b' } });
    expect(res.statusCode).toBe(403);
  });

  it('인코딩된 경로(/%61pi)와 끝 슬래시로도 CSRF 검사를 우회할 수 없다', async () => {
    const { app } = await testApp();
    const encoded = await app.inject({ method: 'POST', url: '/%61pi/auth/login', payload: { username: 'a', password: 'b' } });
    expect(encoded.statusCode).toBe(403);
    const slash = await app.inject({ method: 'POST', url: '/api/auth/logout/' });
    expect(slash.statusCode).toBe(403);
  });

  it('없는 경로는 한국어 404', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: '요청한 경로를 찾을 수 없습니다' });
  });

  it('깨진 JSON 본문은 영어 프레임워크 메시지 없이 한국어 400', async () => {
    const { app } = await testApp();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'content-type': 'application/json' }, payload: '{"username":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: '요청 형식이 올바르지 않습니다' });
  });

  it('지원하지 않는 Content-Type은 한국어 415', async () => {
    const { app } = await testApp();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'content-type': 'application/xml' }, payload: '<a/>',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: '지원하지 않는 Content-Type입니다' });
  });

  it('세션이 이미 무효여도 logout은 200이고 쿠키를 지운다', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...CSRF, cookie: 'tdm_session=stale' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.cookies.find((c) => c.name === 'tdm_session')?.value).toBe('');
  });

  it('logout 후 세션은 무효', async () => {
    const { app, db } = await testApp();
    await seedUser(db, 'kim', 'viewer');
    const headers = as(await login(app, 'kim'));
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers })).statusCode).toBe(401);
  });

  it('예상하지 못한 오류는 상세 없이 500과 requestId', async () => {
    const { app } = await testApp();
    app.get('/api/boom', async () => {
      throw new Error('secret internal detail');
    });
    const res = await app.inject({ method: 'GET', url: '/api/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret');
    expect(res.json()).toMatchObject({ error: '서버 오류가 발생했습니다' });
    expect(res.json().requestId).toBeTruthy();
  });

  it('CSP 헤더', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('HTTP 모드(cookieSecure=false)는 HSTS와 https 승격을 끈다', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });

  it('보안 모드(cookieSecure=true)는 HSTS와 https 승격을 유지한다', async () => {
    const { app } = await testApp({ cookieSecure: true });
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['content-security-policy']).toContain('upgrade-insecure-requests');
  });
});
