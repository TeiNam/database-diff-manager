import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { all, one, openDb, run, tx } from '../src/db/connection';

describe('openDb', () => {
  it('마이그레이션으로 테이블을 만들고 user_version을 올린다', () => {
    const db = openDb(':memory:');
    const tables = all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
    expect(tables).toEqual([
      'databases', 'migration_mappings', 'object_revisions', 'objects', 'rename_mappings', 'schema_versions', 'schemas', 'sessions', 'users', 'version_objects',
    ]);
    expect(one<{ user_version: number }>(db, 'PRAGMA user_version')?.user_version).toBe(2);
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys')?.foreign_keys).toBe(1);
  });

  it('다시 열어도 마이그레이션을 반복하지 않는다', () => {
    const path = join(tmpdir(), `tdm-${process.pid}-${Date.now()}.db`);
    openDb(path).close();
    const db = openDb(path);
    expect(one<{ user_version: number }>(db, 'PRAGMA user_version')?.user_version).toBe(2);
    db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  });

  it('tx는 예외가 나면 롤백한다', () => {
    const db = openDb(':memory:');
    expect(() => tx(db, () => {
      run(db, "INSERT INTO databases (name, created_at) VALUES ('a', 'now')");
      throw new Error('중단');
    })).toThrow('중단');
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM databases')?.n).toBe(0);
  });
});

describe('loadConfig', () => {
  it('기본값과 env 해석', () => {
    expect(loadConfig({})).toMatchObject({ host: '127.0.0.1', port: 3000, cookieSecure: true, sessionTtlMs: 12 * 60 * 60 * 1000 });
    expect(loadConfig({ PORT: '8080', COOKIE_SECURE: 'false', DATA_DIR: '/tmp/x' })).toMatchObject({ port: 8080, cookieSecure: false, dataDir: '/tmp/x' });
    expect(() => loadConfig({ PORT: 'abc' })).toThrow('PORT');
  });
});
