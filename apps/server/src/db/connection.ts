import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export type Db = DatabaseSync;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const MIGRATION_FILE = /^(\d{3})_.+\.sql$/;

const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA synchronous = NORMAL', // WAL 에서는 NORMAL 로도 커밋된 트랜잭션이 손상되지 않는다 (전원 장애 시 마지막 커밋만 잃을 수 있음)
  'PRAGMA journal_size_limit = 67108864', // 체크포인트 뒤 -wal 파일을 64MB 로 줄인다
].join('; ');

// 첫 줄이 이 표시인 마이그레이션은 foreign_keys 를 끄고 실행한다 (테이블 재생성용)
const FK_OFF_MARKER = /^-- foreign_keys: off\s*$/m;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`${PRAGMAS};`);
    migrate(db);
    // 오래 떠 있는 서버도 쿼리 통계를 갖도록 기동 시 한 번 (종료 시에도 실행)
    db.exec('PRAGMA optimize=0x10002');
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

// 종료 전에 통계를 갱신하고 닫는다
export function closeDb(db: Db): void {
  try {
    db.exec('PRAGMA optimize');
  } finally {
    db.close();
  }
}

function migrationFiles(): { version: number; file: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => MIGRATION_FILE.test(f))
    .sort()
    .map((file) => ({ version: Number(MIGRATION_FILE.exec(file)![1]), file }));
}

// PRAGMA user_version 보다 번호가 크고 target 이하인 migrations/NNN_*.sql 을 순서대로 적용한다
export function migrate(db: Db, target = Number.POSITIVE_INFINITY): void {
  const current = one<{ user_version: number }>(db, 'PRAGMA user_version')?.user_version ?? 0;
  const files = migrationFiles();
  const latest = files.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new Error(`DB 스키마 버전(${current})이 이 앱이 아는 최신 버전(${latest})보다 높습니다. 구 버전 이미지로 내려간 것 같습니다 — 새 버전으로 실행하거나 백업에서 복원하세요`);
  }
  let rebuilt = false;
  for (const { version, file } of files) {
    if (version <= current || version > target) continue;
    rebuilt = applyMigration(db, version, readFileSync(join(MIGRATIONS_DIR, file), 'utf8')) || rebuilt;
  }
  // 테이블을 다시 만들면 빈 페이지가 남으므로 트랜잭션 밖에서 한 번 정리한다
  if (rebuilt) {
    // 디스크 부족 등으로 실패해도 데이터는 이미 커밋됐으므로 기동은 계속한다
    try {
      db.exec('VACUUM');
    } catch (e) {
      console.warn('마이그레이션 후 VACUUM 실패 (데이터는 정상):', e);
    }
  }
}

// 마이그레이션 하나를 한 트랜잭션으로 적용한다. foreign_keys 를 끄고 실행했으면 true
// PRAGMA foreign_keys 는 트랜잭션 안에서 바뀌지 않으므로 BEGIN 전에 끄고, 끝나면 원래 값으로 되돌린다
export function applyMigration(db: Db, version: number, sql: string): boolean {
  const fkOff = FK_OFF_MARKER.test(sql.split('\n', 1)[0]);
  const fkBefore = one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys')?.foreign_keys ?? 0;
  if (fkOff) db.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(db, () => {
      db.exec(sql);
      if (fkOff) {
        const violations = all<{ table: string; parent: string }>(db, 'PRAGMA foreign_key_check');
        if (violations.length > 0) {
          const sample = violations.slice(0, 5).map((v) => `${v.table}→${v.parent}`).join(', ');
          throw new Error(`마이그레이션 ${version} 이후 외래 키 위반 ${violations.length}건: ${sample}`);
        }
      }
      db.exec(`PRAGMA user_version = ${version}`);
    });
  } finally {
    if (fkOff) db.exec(`PRAGMA foreign_keys = ${fkBefore ? 'ON' : 'OFF'}`);
  }
  return fkOff;
}

// 예외가 나면 롤백하고 원래 오류를 던진다. 트랜잭션이 이미 끝났으면(오류로 자동 롤백 등) ROLLBACK 오류는 무시한다
// (db.isTransaction 은 Node 22.13 에 없으므로 쓰지 않는다)
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 이미 롤백됨 — 원래 오류를 가리지 않는다
    }
    throw e;
  }
}

export function one<T>(db: Db, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

export function all<T>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function run(db: Db, sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}
