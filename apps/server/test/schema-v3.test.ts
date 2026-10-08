import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { all, applyMigration, migrate, one, openDb, run, type Db } from '../src/db/connection';
import { getTree } from '../src/repos/catalog';
import { addMigration, deleteMigration, getMigrationSource, listMigrations } from '../src/repos/migrations';
import { objectHistory } from '../src/repos/objects';
import { createUser, findLoginCandidate } from '../src/repos/users';
import { deleteVersion, getSource, listVersions, loadVersion } from '../src/repos/versions';
import { ingest } from '../src/services/ingest';

const count = (db: Db, table: string) => one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`)!.n;
const userVersion = (db: Db) => one<{ user_version: number }>(db, 'PRAGMA user_version')!.user_version;
const DATA_TABLES = ['databases', 'schemas', 'schema_versions', 'schema_version_sources', 'objects', 'object_revisions', 'version_objects',
  'rename_mappings', 'migration_mappings', 'migration_mapping_sources', 'migration_pairs'];

// 001+002 까지만 적용하고 운영 DB 처럼 사용자·세션·업로드 데이터를 채운 DB. KIM 은 kim 과 대소문자만 다르다
function legacyDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, 2);
  db.exec(`
    INSERT INTO users VALUES (1, 'admin', 'hash-a', 'admin', 0, '2026-01-01'), (2, 'kim', 'hash-k', 'viewer', 1, '2026-01-02'),
                             (3, 'KIM', 'hash-K', 'admin', 0, '2026-01-03'), (4, 'lee', 'hash-l', 'viewer', 0, '2026-01-04');
    INSERT INTO sessions VALUES ('token', 1, '2099-01-01T00:00:00.000Z');
    INSERT INTO databases VALUES (1, 'db', NULL, '2026-01-01');
    INSERT INTO schemas VALUES (1, 1, 'app'), (2, 1, 'app2');
    INSERT INTO schema_versions VALUES (1, 1, 1, 'sql', 'a.sql', 'CREATE TABLE t (x int);', 'sha', 'mh', NULL, 1, '2026-01-01'),
                                       (2, 2, 1, 'sql', 'b.sql', 'CREATE TABLE t (x int);', 'sha', 'mh', NULL, 1, '2026-01-01');
    INSERT INTO objects VALUES (1, 1, 'table', 't');
    INSERT INTO object_revisions VALUES (1, 1, 1, 'ch', '{}', 'full', NULL);
    INSERT INTO version_objects VALUES (1, 1);
    INSERT INTO rename_mappings VALUES (1, 1, 2, 'table', NULL, 'a', 'b', 1);
    INSERT INTO migration_mappings VALUES (1, 1, 2, 1, 'm.json', '{}', 1, NULL, 1, '2026-01-01');
  `);
  return db;
}

describe('마이그레이션 003 (001+002 상태에서 올리기)', () => {
  it('사용자는 보존하고(대소문자 중복은 먼저 생긴 것만), 세션·업로드 데이터는 비운다', () => {
    const db = legacyDb();
    migrate(db);
    expect(userVersion(db)).toBe(3);
    expect(all(db, 'SELECT id, username, password_hash, role, disabled, typeof(disabled) AS t, created_at FROM users ORDER BY id')).toEqual([
      { id: 1, username: 'admin', password_hash: 'hash-a', role: 'admin', disabled: 0, t: 'integer', created_at: '2026-01-01' },
      { id: 2, username: 'kim', password_hash: 'hash-k', role: 'viewer', disabled: 1, t: 'integer', created_at: '2026-01-02' },
      { id: 4, username: 'lee', password_hash: 'hash-l', role: 'viewer', disabled: 0, t: 'integer', created_at: '2026-01-04' },
    ]);
    expect(count(db, 'sessions')).toBe(0);
    for (const table of DATA_TABLES) expect(count(db, table), table).toBe(0);
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys')!.foreign_keys).toBe(1);
    expect(findLoginCandidate(db, 'ADMIN')?.id).toBe(1); // 사용자명은 대소문자를 가리지 않는다
  });

  it('모든 테이블이 STRICT 이고, 불필요한 인덱스는 없고 필요한 인덱스는 있다', () => {
    const db = legacyDb();
    migrate(db);
    const tables = all<{ name: string; sql: string }>(db, "SELECT name, sql FROM sqlite_master WHERE type = 'table'");
    for (const t of tables) expect(t.sql, t.name).toMatch(/\)\s*STRICT$/);
    const indexes = all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
    expect(indexes).not.toContain('ix_versions_uploaded');
    expect(indexes).not.toContain('ix_revisions_object');
    expect(indexes).toEqual(expect.arrayContaining(['ix_sessions_expires', 'ix_sessions_user', 'ix_revisions_history', 'ux_renames', 'ix_renames_target', 'ix_version_objects_revision']));
  });

  it('새 DB 에서도 001→003 이 적용되고 업로드가 동작한다', () => {
    const db = openDb(':memory:');
    expect(userVersion(db)).toBe(3);
    const userId = createUser(db, { username: 'admin', passwordHash: 'h', role: 'admin' }).id;
    const r = ingest(db, { databaseName: 'db', schemaName: 'app', filename: 'a.sql', text: 'CREATE TABLE `t` (\n  `x` int\n);', userId });
    expect(r).toMatchObject({ status: 'ok', versionNo: 1 });
    expect(getSource(db, r.versionId).text).toBe('CREATE TABLE `t` (\n  `x` int\n);');
    expect(count(db, 'schema_version_sources')).toBe(1);
  });

  it('foreign_keys: off 마이그레이션이 FK 위반을 남기면 롤백하고 foreign_keys 를 되돌린다', () => {
    const db = openDb(':memory:');
    expect(() => applyMigration(db, 99, "-- foreign_keys: off\nINSERT INTO sessions VALUES ('x', 12345, '2099');")).toThrow('외래 키');
    expect(count(db, 'sessions')).toBe(0);
    expect(userVersion(db)).toBe(3);
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys')!.foreign_keys).toBe(1);
    expect(db.isTransaction).toBe(false);
  });
});

const T = (type: string) => `CREATE TABLE \`t\` (\n  \`x\` ${type}\n);`;

function freshDb() {
  const db = openDb(':memory:');
  const userId = createUser(db, { username: 'admin', passwordHash: 'h', role: 'admin' }).id;
  const up = (text: string, schemaName = 'app') => ingest(db, { databaseName: 'db', schemaName, filename: 'a.sql', text, userId });
  return { db, userId, up };
}

describe('번호 재사용 방지', () => {
  it('최신 버전을 지우고 다시 올리면 version_no·revision_no 가 이어서 증가한다', () => {
    const { db, up } = freshDb();
    expect(up(T('int')).versionNo).toBe(1);
    const v2 = up(T('bigint'));
    expect(v2.versionNo).toBe(2);
    deleteVersion(db, v2.versionId);
    const v3 = up(T('varchar(10)'));
    expect(v3.versionNo).toBe(3);
    const objectId = loadVersion(db, v3.versionId).objects[0].objectId;
    expect(objectHistory(db, objectId).revisions.map((r) => r.revisionNo)).toEqual([1, 3]);
  });

  it('최신 매핑 리비전을 지우고 다시 올려도 리비전 번호를 재사용하지 않는다', () => {
    const { db, userId, up } = freshDb();
    const from = getVersionSchema(db, up(T('int'), 'legacy').versionId);
    const to = getVersionSchema(db, up(T('int'), 'newapp').versionId);
    const add = () => addMigration(db, { fromSchemaId: from, toSchemaId: to, filename: 'm.json', source: '{"rules":[]}', ruleCount: 1, userId });
    expect(add().revision).toBe(1);
    const r2 = add();
    expect(r2.revision).toBe(2);
    deleteMigration(db, r2.id);
    const r3 = add();
    expect(r3.revision).toBe(3);
    expect(listMigrations(db, from, to).map((m) => m.revision)).toEqual([3, 1]);
    expect(getMigrationSource(db, r3.id)).toEqual({ filename: 'm.json', text: '{"rules":[]}' });
    expect(count(db, 'migration_mapping_sources')).toBe(2);
  });

  it('버전 삭제는 그 버전의 고아 리비전·객체만 정리하고 다른 Schema 는 건드리지 않는다', () => {
    const { db, up } = freshDb();
    const a = up(T('int'), 'a');
    up(T('int'), 'b');
    deleteVersion(db, a.versionId);
    expect(all(db, 'SELECT s.name FROM objects o JOIN schemas s ON s.id = o.schema_id')).toEqual([{ name: 'b' }]);
    expect(count(db, 'object_revisions')).toBe(1);
    expect(count(db, 'schema_version_sources')).toBe(1);
  });
});

const getVersionSchema = (db: Db, versionId: number) => one<{ schema_id: number }>(db, 'SELECT schema_id FROM schema_versions WHERE id = ?', versionId)!.schema_id;

describe('DB 제약', () => {
  // 두 Schema 에 버전·객체를 하나씩 만든다
  function seeded() {
    const { db, userId, up } = freshDb();
    const a = up(T('int'), 'a');
    const b = up(T('int'), 'b');
    const objectOf = (versionId: number) => one<{ object_id: number; revision_id: number; schema_id: number }>(db,
      'SELECT object_id, revision_id, schema_id FROM version_objects WHERE version_id = ?', versionId)!;
    return { db, userId, a: { versionId: a.versionId, ...objectOf(a.versionId) }, b: { versionId: b.versionId, ...objectOf(b.versionId) } };
  }

  it('같은 버전에 같은 객체를 두 번(다른 리비전으로) 연결할 수 없다', () => {
    const { db, a } = seeded();
    const rev2 = run(db, "INSERT INTO object_revisions (object_id, revision_no, content_hash, fidelity, model_json) VALUES (?, 2, 'h2', 'full', '{}')", a.object_id).lastInsertRowid;
    expect(() => run(db, 'INSERT INTO version_objects (version_id, schema_id, object_id, revision_id) VALUES (?, ?, ?, ?)', a.versionId, a.schema_id, a.object_id, rev2))
      .toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it('다른 Schema 의 객체·다른 객체의 리비전은 연결할 수 없다', () => {
    const { db, a, b } = seeded();
    const del = () => run(db, 'DELETE FROM version_objects WHERE version_id = ?', a.versionId);
    del();
    const link = (schemaId: number, objectId: number, revisionId: number) =>
      () => run(db, 'INSERT INTO version_objects (version_id, schema_id, object_id, revision_id) VALUES (?, ?, ?, ?)', a.versionId, schemaId, objectId, revisionId);
    expect(link(a.schema_id, b.object_id, b.revision_id)).toThrow(/FOREIGN KEY/); // 객체가 다른 Schema 소속
    expect(link(b.schema_id, b.object_id, b.revision_id)).toThrow(/FOREIGN KEY/); // 버전이 다른 Schema 소속
    expect(link(a.schema_id, a.object_id, b.revision_id)).toThrow(/FOREIGN KEY/); // 리비전이 다른 객체 소속
  });

  it('rename 매핑: table 중복·table_name 규칙·같은 버전 쌍을 거부한다', () => {
    const { db, userId, a, b } = seeded();
    const add = (kind: string, table: string | null, base = a.versionId, target = b.versionId) => () =>
      run(db, `INSERT INTO rename_mappings (base_version_id, target_version_id, kind, table_name, old_name, new_name, created_by)
               VALUES (?, ?, ?, ?, 'old', 'new', ?)`, base, target, kind, table, userId);
    add('table', null)();
    expect(add('table', null)).toThrow(/UNIQUE/);
    expect(add('table', 't')).toThrow(/CHECK/);
    expect(add('column', null)).toThrow(/CHECK/);
    expect(add('table', null, a.versionId, a.versionId)).toThrow(/CHECK/);
  });

  it('users: 역할·disabled 값과 타입을 DB 가 검사한다', () => {
    const { db } = freshDb();
    const insert = (role: string, disabled: SQLInputValue) => () =>
      run(db, "INSERT INTO users (username, password_hash, role, disabled, created_at) VALUES ('u', 'h', ?, ?, 'now')", role, disabled);
    expect(insert('root', 0)).toThrow(/CHECK/);
    expect(insert('viewer', 2)).toThrow(/CHECK/);
    expect(insert('viewer', 'yes')).toThrow(/cannot store TEXT value in INTEGER column/);
    insert('dba', 0)();
  });
});

// 실제 저장소 함수가 실행하는 SQL 을 모아 EXPLAIN QUERY PLAN 으로 검사한다
function capture(db: Db): { spy: Db; sqls: string[] } {
  const sqls: string[] = [];
  const spy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => { sqls.push(sql); return target.prepare(sql); };
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { spy, sqls };
}

function scans(db: Db, sql: string): string[] {
  const params = Array.from(sql.matchAll(/\?/g), () => 1);
  return all<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${sql}`, ...params)
    .map((r) => r.detail)
    .filter((d) => d.startsWith('SCAN') && !d.includes('VIRTUAL TABLE'));
}

describe('쿼리 계획', () => {
  it('버전 목록·트리·버전 로드·객체 이력·버전 삭제가 테이블 전체를 훑지 않는다 (트리의 databases 목록 제외)', () => {
    const { db, up } = freshDb();
    const v1 = up(T('int'));
    up(T('bigint'));
    const schemaId = getVersionSchema(db, v1.versionId);
    const objectId = loadVersion(db, v1.versionId).objects[0].objectId;
    const { spy, sqls } = capture(db);
    listVersions(spy, schemaId);
    loadVersion(spy, v1.versionId);
    objectHistory(spy, objectId);
    getTree(spy);
    deleteVersion(spy, v1.versionId);
    const read = sqls.filter((s) => /^\s*(SELECT|DELETE|WITH)/i.test(s));
    expect(read.length).toBeGreaterThan(5);
    for (const sql of read) {
      // 트리는 Database 전체 목록이라 databases 만 훑는다 (이름 순서 인덱스를 쓸 수 있다)
      const found = scans(db, sql).filter((d) => !(sql.includes('FROM databases d') && /^SCAN d\b/.test(d)));
      expect(found, sql).toEqual([]);
    }
  });

  it('모든 외래 키의 자식 컬럼에 인덱스가 있다 (삭제 연쇄가 자식 테이블을 훑지 않도록. users 는 삭제하지 않으므로 제외)', () => {
    const db = openDb(':memory:');
    const tables = all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    const missing: string[] = [];
    for (const table of tables) {
      const fks = all<{ id: number; table: string; from: string; seq: number }>(db, 'SELECT id, "table", "from", seq FROM pragma_foreign_key_list(?) ORDER BY id, seq', table);
      const groups = new Map<number, { parent: string; cols: string[] }>();
      for (const fk of fks) {
        const g = groups.get(fk.id) ?? { parent: fk.table, cols: [] };
        g.cols.push(fk.from);
        groups.set(fk.id, g);
      }
      const indexes = all<{ name: string }>(db, 'SELECT name FROM pragma_index_list(?)', table)
        .map((i) => all<{ name: string }>(db, 'SELECT name FROM pragma_index_info(?) ORDER BY seqno', i.name).map((c) => c.name));
      const pk = all<{ name: string; pk: number }>(db, 'SELECT name, pk FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk', table).map((c) => c.name);
      for (const { parent, cols } of groups.values()) {
        if (parent === 'users' && table !== 'sessions') continue;
        // 인덱스의 선두 컬럼이 FK 컬럼이면 자식 행을 인덱스로 찾는다 (복합 FK 는 나머지 컬럼을 그 범위 안에서 거른다)
        const covered = [...indexes, pk].some((ix) => ix.length > 0 && cols.includes(ix[0]));
        if (!covered) missing.push(`${table}(${cols.join(', ')}) → ${parent}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
