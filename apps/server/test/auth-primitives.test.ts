import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { createSession, purgeExpiredSessions, resolveSession } from '../src/auth/session';
import { createAdmin } from '../src/cli/create-admin';
import { one, openDb } from '../src/db/connection';
import { createUser, updateUser } from '../src/repos/users';

const TTL = 12 * 60 * 60 * 1000;

describe('password', () => {
  it('scrypt 해시를 만들고 검증한다', async () => {
    const stored = await hashPassword('correct horse');
    expect(stored.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('손상된 저장 해시는 예외 없이 false (fail-open 방지)', async () => {
    const salt = 'AAAAAAAAAAAAAAAAAAAAAA==';
    const valid = await hashPassword('correct horse');
    const [, , , , , goodHash] = valid.split('$');
    const malformed = [
      'scrypt$32768$8$1$AAAA$!!!!',
      `scrypt$32768$8$1$${salt}$`,
      `scrypt$32768$8$1$${salt}$AAAA`,
      `scrypt$abc$8$1$${salt}$${goodHash}`,
      `scrypt$${2 ** 20}$8$1$${salt}$${goodHash}`,
      `${valid}$extra`,
    ];
    for (const stored of malformed) {
      await expect(verifyPassword('anything', stored)).resolves.toBe(false);
      await expect(verifyPassword('', stored)).resolves.toBe(false);
    }
  });
});

describe('users', () => {
  it('중복 사용자명은 409', () => {
    const db = openDb(':memory:');
    createUser(db, { username: 'kim', passwordHash: 'h', role: 'viewer' });
    expect(() => createUser(db, { username: 'kim', passwordHash: 'h', role: 'admin' })).toThrow('이미 존재하는 사용자명입니다');
    expect(() => createUser(db, { username: 'KIM', passwordHash: 'h', role: 'admin' })).toThrow('이미 존재하는 사용자명입니다');
  });

  it('마지막 활성 관리자는 강등·비활성화할 수 없다', () => {
    const db = openDb(':memory:');
    const admin = createUser(db, { username: 'admin', passwordHash: 'h', role: 'admin' });
    expect(() => updateUser(db, admin.id, { role: 'viewer' })).toThrow('마지막 관리자');
    expect(() => updateUser(db, admin.id, { role: 'dba' })).toThrow('마지막 관리자');
    expect(() => updateUser(db, admin.id, { disabled: true })).toThrow('마지막 관리자');
    createUser(db, { username: 'admin2', passwordHash: 'h', role: 'admin' });
    expect(updateUser(db, admin.id, { disabled: true }).disabled).toBe(true);
  });

  it('사용자를 변경하면 그 사용자의 세션을 끊는다', () => {
    const db = openDb(':memory:');
    const user = createUser(db, { username: 'lee', passwordHash: 'h', role: 'viewer' });
    const token = createSession(db, user.id, TTL);
    updateUser(db, user.id, { passwordHash: 'h2' });
    expect(resolveSession(db, token, TTL)).toBeUndefined();
  });
});

describe('session', () => {
  it('토큰 원문은 저장하지 않고 해시로 찾는다', () => {
    const db = openDb(':memory:');
    const user = createUser(db, { username: 'park', passwordHash: 'h', role: 'viewer' });
    const token = createSession(db, user.id, TTL, 0);
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', token)?.n).toBe(0);
    expect(resolveSession(db, token, TTL, 1000)?.username).toBe('park');
    expect(resolveSession(db, 'other', TTL, 1000)).toBeUndefined();
  });

  it('만료 시간이 절반 미만으로 남으면 연장하고, 지나면 무효', () => {
    const db = openDb(':memory:');
    const user = createUser(db, { username: 'choi', passwordHash: 'h', role: 'viewer' });
    const token = createSession(db, user.id, TTL, 0);
    expect(resolveSession(db, token, TTL, TTL * 0.75)).toBeDefined(); // 연장 → 만료 시각 = 1.75 TTL
    expect(resolveSession(db, token, TTL, TTL * 1.5)).toBeDefined();
    expect(resolveSession(db, token, TTL, TTL * 3)).toBeUndefined();
  });

  it('비활성 사용자의 세션은 무효', () => {
    const db = openDb(':memory:');
    createUser(db, { username: 'admin', passwordHash: 'h', role: 'admin' });
    const user = createUser(db, { username: 'jung', passwordHash: 'h', role: 'viewer' });
    const token = createSession(db, user.id, TTL);
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(user.id);
    expect(resolveSession(db, token, TTL)).toBeUndefined();
  });

  it('purgeExpiredSessions', () => {
    const db = openDb(':memory:');
    const user = createUser(db, { username: 'han', passwordHash: 'h', role: 'viewer' });
    createSession(db, user.id, TTL, 0);
    purgeExpiredSessions(db, TTL * 2);
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM sessions')?.n).toBe(0);
  });
});

describe('createAdmin', () => {
  it('검증 후 관리자를 만든다', async () => {
    const db = openDb(':memory:');
    await expect(createAdmin(db, 'a', 'long-enough-pw')).rejects.toThrow('사용자명');
    await expect(createAdmin(db, 'admin', 'short')).rejects.toThrow('10자 이상');
    const user = await createAdmin(db, 'admin', 'long-enough-pw');
    expect(user).toMatchObject({ username: 'admin', role: 'admin', disabled: false });
  });
});
