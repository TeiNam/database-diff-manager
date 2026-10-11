// 비밀번호 재설정과 로그인이 겹칠 때: 검증(비동기) 중 바뀐 비밀번호·비활성화를 세션 발급 직전에 다시 확인한다
import { describe, expect, it, vi } from 'vitest';
import * as password from '../src/auth/password';
import { one, type Db } from '../src/db/connection';
import { updateUser } from '../src/repos/users';
import { CSRF, PASSWORD, seedUser, testApp } from './helpers';

vi.mock('../src/auth/password', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/auth/password')>();
  return { ...real, verifyPassword: vi.fn(real.verifyPassword) };
});

const sessionCount = (db: Db) => one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM sessions')?.n ?? 0;

// 옛 비밀번호 검증이 끝나기 직전에 다른 요청이 계정을 바꾼 상황을 만든다
async function raceLogin(change: (db: Db, userId: number) => Promise<void>) {
  const { app, db } = await testApp();
  const user = await seedUser(db, 'kim', 'viewer');
  const real = (await vi.importActual<typeof import('../src/auth/password')>('../src/auth/password')).verifyPassword;
  vi.mocked(password.verifyPassword).mockImplementationOnce(async (pw, hash) => {
    const ok = await real(pw, hash);
    await change(db, user.id);
    return ok;
  });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'kim', password: PASSWORD } });
  return { res, db };
}

describe('로그인 · 비밀번호 재설정 경합', () => {
  it('검증 중 비밀번호가 재설정되면 옛 비밀번호로는 세션을 만들지 않는다', async () => {
    const { res, db } = await raceLogin(async (d, id) => {
      updateUser(d, id, { passwordHash: await (await vi.importActual<typeof import('../src/auth/password')>('../src/auth/password')).hashPassword('brand-new-password') });
    });
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === 'tdm_session')).toBeUndefined();
    expect(sessionCount(db)).toBe(0);
  });

  it('검증 중 비활성화되면 세션을 만들지 않는다', async () => {
    const { res, db } = await raceLogin(async (d, id) => {
      updateUser(d, id, { disabled: true });
    });
    expect(res.statusCode).toBe(401);
    expect(sessionCount(db)).toBe(0);
  });

  it('검증 중 바뀐 것이 없으면 그대로 로그인된다', async () => {
    const { res, db } = await raceLogin(async () => {});
    expect(res.statusCode).toBe(200);
    expect(sessionCount(db)).toBe(1);
  });
});
