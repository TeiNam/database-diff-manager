import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { all, one, openDb, run, tx } from '../src/db/connection';

describe('openDb', () => {
  it('마이그레이션으로 테이블을 만들고 user_version을 올린다', () => {
    const db = openDb(':memory:');
    const tables = all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
    expect(tables).toEqual([
      'databases', 'migration_mapping_sources', 'migration_mappings', 'migration_pairs', 'object_revisions', 'objects', 'rename_mappings',
      'schema_version_sources', 'schema_versions', 'schemas', 'sessions', 'users', 'version_objects',
    ]);
    expect(one<{ user_version: number }>(db, 'PRAGMA user_version')?.user_version).toBe(3);
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys')?.foreign_keys).toBe(1);
  });

  it('다시 열어도 마이그레이션을 반복하지 않는다', () => {
    const path = join(tmpdir(), `tdm-${process.pid}-${Date.now()}.db`);
    openDb(path).close();
    const db = openDb(path);
    expect(one<{ user_version: number }>(db, 'PRAGMA user_version')?.user_version).toBe(3);
    expect(one<{ synchronous: number }>(db, 'PRAGMA synchronous')?.synchronous).toBe(1); // NORMAL
    expect(one<{ journal_size_limit: number }>(db, 'PRAGMA journal_size_limit')?.journal_size_limit).toBe(67108864);
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

  it('tx 안에서 트랜잭션이 이미 끝났으면 ROLLBACK 오류가 원래 오류를 가리지 않는다', () => {
    const db = openDb(':memory:');
    expect(() => tx(db, () => {
      db.exec('ROLLBACK');
      throw new Error('원래 오류');
    })).toThrow('원래 오류');
    expect(db.isTransaction).toBe(false);
  });

  it('DB 가 앱이 아는 것보다 새 버전이면 기동을 거부한다', () => {
    const path = join(tmpdir(), `tdm-future-${process.pid}-${Date.now()}.db`);
    const db = openDb(path);
    db.exec('PRAGMA user_version = 999');
    db.close();
    expect(() => openDb(path)).toThrow('구 버전');
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  });
});

describe('loadConfig', () => {
  it('기본값과 env 해석', () => {
    expect(loadConfig({})).toMatchObject({ host: '127.0.0.1', port: 3000, cookieSecure: true, sessionTtlMs: 12 * 60 * 60 * 1000 });
    expect(loadConfig({ PORT: '8080', COOKIE_SECURE: 'false', DATA_DIR: '/tmp/x' })).toMatchObject({ port: 8080, cookieSecure: false, dataDir: '/tmp/x' });
    expect(() => loadConfig({ PORT: 'abc' })).toThrow('PORT');
  });
});

describe('tx() 롤백 (isTransaction 이 없는 Node 22.13 대응)', () => {
  it('예외 뒤에도 트랜잭션이 남지 않아 다음 tx 가 동작한다', () => {
    const real = openDb(':memory:');
    // Node 22.13 처럼 isTransaction 이 없는 런타임을 흉내 낸다 (인스턴스 속성은 재정의할 수 없어 Proxy 로 가린다)
    const db = new Proxy(real, {
      get: (target, key) => {
        if (key === 'isTransaction') return undefined;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    db.exec('CREATE TABLE t (v INTEGER NOT NULL)');
    expect(() => tx(db, () => {
      db.prepare('INSERT INTO t (v) VALUES (1)').run();
      throw new Error('원래 오류');
    })).toThrow('원래 오류');
    expect(() => tx(db, () => db.prepare('INSERT INTO t (v) VALUES (2)').run())).not.toThrow();
    expect(db.prepare('SELECT v FROM t').all()).toEqual([{ v: 2 }]);
    // SQL 오류로 이미 롤백된 경우에도 원래 오류를 그대로 던진다
    expect(() => tx(db, () => db.exec('INSERT INTO t (v) VALUES (NULL)'))).toThrow(/NOT NULL/);
    real.close();
  });
});
