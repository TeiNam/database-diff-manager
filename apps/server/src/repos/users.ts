import { all, one, run, tx, type Db } from '../db/connection';
import { AppError } from '../errors';

export type Role = 'admin' | 'viewer';

export interface User {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
}

export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;

interface UserRecord {
  id: number;
  username: string;
  role: Role;
  disabled: number;
  created_at: string;
  password_hash: string;
}

const COLUMNS = 'id, username, role, disabled, created_at, password_hash';

const toUser = (r: UserRecord): User => ({
  id: Number(r.id), username: r.username, role: r.role, disabled: r.disabled === 1, createdAt: r.created_at,
});

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && e.message.includes('UNIQUE constraint failed');
}

export function createUser(db: Db, input: { username: string; passwordHash: string; role: Role }): User {
  try {
    const { lastInsertRowid } = run(db, 'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
      input.username, input.passwordHash, input.role, new Date().toISOString());
    return getUser(db, lastInsertRowid)!;
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, '이미 존재하는 사용자명입니다');
    throw e;
  }
}

export function getUser(db: Db, id: number): User | undefined {
  const r = one<UserRecord>(db, `SELECT ${COLUMNS} FROM users WHERE id = ?`, id);
  return r && toUser(r);
}

export function findLoginCandidate(db: Db, username: string): (User & { passwordHash: string }) | undefined {
  const r = one<UserRecord>(db, `SELECT ${COLUMNS} FROM users WHERE username = ?`, username);
  return r && { ...toUser(r), passwordHash: r.password_hash };
}

export function listUsers(db: Db): User[] {
  return all<UserRecord>(db, `SELECT ${COLUMNS} FROM users ORDER BY username`).map(toUser);
}

export function countActiveAdmins(db: Db): number {
  return one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")?.n ?? 0;
}

export interface UserPatch {
  role?: Role;
  disabled?: boolean;
  passwordHash?: string;
}

// 변경 후에는 그 사용자의 세션을 모두 끊는다. 마지막 활성 관리자는 강등·비활성화할 수 없다
export function updateUser(db: Db, id: number, patch: UserPatch): User {
  const user = getUser(db, id);
  if (!user) throw new AppError(404, '사용자를 찾을 수 없습니다');
  const losesAdmin = user.role === 'admin' && !user.disabled && (patch.role === 'viewer' || patch.disabled === true);
  tx(db, () => {
    if (losesAdmin && countActiveAdmins(db) <= 1) throw new AppError(409, '마지막 관리자는 강등하거나 비활성화할 수 없습니다');
    if (patch.role) run(db, 'UPDATE users SET role = ? WHERE id = ?', patch.role, id);
    if (patch.disabled !== undefined) run(db, 'UPDATE users SET disabled = ? WHERE id = ?', patch.disabled ? 1 : 0, id);
    if (patch.passwordHash) run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', patch.passwordHash, id);
    run(db, 'DELETE FROM sessions WHERE user_id = ?', id);
  });
  return getUser(db, id)!;
}
