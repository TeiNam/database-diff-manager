import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDb } from '../src/cli/backup';
import { one, openDb } from '../src/db/connection';
import { createUser } from '../src/repos/users';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('backupDb', () => {
  it('VACUUM INTO 로 실행 중인 DB 의 일관된 스냅샷을 만든다', () => {
    dir = mkdtempSync(join(tmpdir(), 'tdm-backup-'));
    const db = openDb(join(dir, 'tdm.db'));
    createUser(db, { username: 'admin', passwordHash: 'h', role: 'admin' });
    const target = join(dir, 'out', 'backup.db');
    backupDb(db, target);
    db.close();
    const copy = openDb(target);
    expect(one<{ n: number }>(copy, 'SELECT COUNT(*) AS n FROM users')!.n).toBe(1);
    expect(one<{ user_version: number }>(copy, 'PRAGMA user_version')!.user_version).toBe(3);
    copy.close();
  });

  it('이미 있는 파일은 덮어쓰지 않는다', () => {
    dir = mkdtempSync(join(tmpdir(), 'tdm-backup-'));
    const db = openDb(':memory:');
    const target = join(dir, 'exists.db');
    writeFileSync(target, 'x');
    expect(() => backupDb(db, target)).toThrow('이미 있습니다');
  });
});
