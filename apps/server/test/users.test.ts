import { describe, expect, it } from 'vitest';
import { login, loggedInApp, as } from './helpers';

describe('/api/users', () => {
  it('viewer는 403', async () => {
    const { app, viewer } = await loggedInApp();
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: viewer })).statusCode).toBe(403);
  });

  it('목록·생성·중복·약한 비밀번호', async () => {
    const { app, admin } = await loggedInApp();
    const list = await app.inject({ method: 'GET', url: '/api/users', headers: admin });
    expect(list.json().map((u: { username: string }) => u.username)).toEqual(['admin', 'viewer']);
    expect(list.body).not.toContain('password');

    const created = await app.inject({ method: 'POST', url: '/api/users', headers: admin, payload: { username: 'new.user', password: 'long-password-1', role: 'viewer' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ username: 'new.user', role: 'viewer', disabled: false });

    const dup = await app.inject({ method: 'POST', url: '/api/users', headers: admin, payload: { username: 'new.user', password: 'long-password-1', role: 'viewer' } });
    expect(dup.statusCode).toBe(409);

    const weak = await app.inject({ method: 'POST', url: '/api/users', headers: admin, payload: { username: 'weak', password: 'short', role: 'viewer' } });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().details[0].message).toContain('10자 이상');
  });

  it('역할 변경·비활성화·비밀번호 재설정', async () => {
    const { app, admin, viewer } = await loggedInApp();
    const users = (await app.inject({ method: 'GET', url: '/api/users', headers: admin })).json();
    const viewerId = users.find((u: { username: string }) => u.username === 'viewer').id;

    const disabled = await app.inject({ method: 'PATCH', url: `/api/users/${viewerId}`, headers: admin, payload: { disabled: true } });
    expect(disabled.json().disabled).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: viewer })).statusCode).toBe(401);

    await app.inject({ method: 'PATCH', url: `/api/users/${viewerId}`, headers: admin, payload: { disabled: false, password: 'brand-new-pass', role: 'admin' } });
    const relogin = as(await login(app, 'viewer', 'brand-new-pass'));
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: relogin })).json().role).toBe('admin');
  });

  it('빈 PATCH는 400, 없는 사용자는 404, 마지막 관리자 강등은 409', async () => {
    const { app, admin } = await loggedInApp();
    const adminId = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: admin })).json().id;
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${adminId}`, headers: admin, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/users/999', headers: admin, payload: { disabled: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${adminId}`, headers: admin, payload: { role: 'viewer' } })).statusCode).toBe(409);
  });
});
