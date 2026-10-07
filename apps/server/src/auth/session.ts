import { createHash, randomBytes } from 'node:crypto';
import { one, run, type Db } from '../db/connection';
import type { Role, User } from '../repos/users';

export const SESSION_COOKIE = 'tdm_session';
const TOKEN_BYTES = 32;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

interface SessionRecord {
  expires_at: string;
  id: number;
  username: string;
  role: Role;
  disabled: number;
  created_at: string;
}

// 토큰 원문은 쿠키로만 내보내고 DB에는 해시만 저장한다
export function createSession(db: Db, userId: number, ttlMs: number, now = Date.now()): string {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  run(db, 'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, new Date(now + ttlMs).toISOString());
  return token;
}

// 유효한 세션의 사용자. 남은 시간이 절반 미만이면 만료를 연장한다(슬라이딩)
export function resolveSession(db: Db, token: string, ttlMs: number, now = Date.now()): User | undefined {
  const hash = sha256(token);
  const row = one<SessionRecord>(db,
    `SELECT s.expires_at, u.id, u.username, u.role, u.disabled, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, hash);
  if (!row) return undefined;
  const expiresAt = Date.parse(row.expires_at);
  if (expiresAt <= now || row.disabled === 1) {
    run(db, 'DELETE FROM sessions WHERE token_hash = ?', hash);
    return undefined;
  }
  if (expiresAt - now < ttlMs / 2) run(db, 'UPDATE sessions SET expires_at = ? WHERE token_hash = ?', new Date(now + ttlMs).toISOString(), hash);
  return { id: Number(row.id), username: row.username, role: row.role, disabled: false, createdAt: row.created_at };
}

export function deleteSession(db: Db, token: string): void {
  run(db, 'DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function purgeExpiredSessions(db: Db, now = Date.now()): void {
  run(db, 'DELETE FROM sessions WHERE expires_at <= ?', new Date(now).toISOString());
}
