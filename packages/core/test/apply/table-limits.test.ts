import { describe, expect, it } from 'vitest';
import { applyScript } from '../../src/apply';
import { RE_EXPORT } from '../../src/apply/types';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

// InnoDB 테이블 한도 (MySQL 8.0.46·8.4.11 실측): 키는 PRIMARY·FK 자동 인덱스를 포함해 64개(65번째는 1069 — 없는 컬럼 1072 보다 먼저), 컬럼은 1017개(1018번째는 1117)
const base = parseSqlDump(tdExport('CREATE TABLE `p` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\n')).model;
const run = (script: string) => applyScript(base, script, { schemaName: 'shop' });
const reasonOf = (script: string): string => {
  const r = run(script);
  return r.ok ? 'ok' : `${r.error.index}: ${r.error.reason}`;
};
const columns = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `c${i + from} INT`).join(', ');
const keys = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `KEY k${i + from} (c${(i + from) % 10})`).join(', ');
const table64 = `CREATE TABLE t (id INT PRIMARY KEY, ${columns(10)}, ${keys(63)});`;

describe('키 64개 한도 (MySQL 1069)', () => {
  it('CREATE TABLE 은 64개까지 받고 65개는 1069 다 (PRIMARY 가 없어도 같다)', () => {
    expect(reasonOf(table64)).toBe('ok');
    expect(reasonOf(`CREATE TABLE t (id INT PRIMARY KEY, ${columns(10)}, ${keys(64)});`)).toMatch(/^1: .*\(MySQL 1069\)/);
    expect(reasonOf(`CREATE TABLE t (id INT, ${columns(10)}, ${keys(64)});`)).toBe('ok');
    expect(reasonOf(`CREATE TABLE t (id INT, ${columns(10)}, ${keys(65)});`)).toMatch(/^1: .*\(MySQL 1069\)/);
  });

  it('ALTER TABLE 이 65번째 키를 더하면 1069 다 — 없는 컬럼(1072)보다 먼저다. 하나 지우고 더하면 받는다', () => {
    expect(reasonOf(`${table64}\nALTER TABLE t ADD KEY k99 (c1);`)).toMatch(/^2: .*\(MySQL 1069\)/);
    expect(reasonOf(`${table64}\nALTER TABLE t ADD KEY k99 (nope);`)).toMatch(/^2: .*\(MySQL 1069\)/);
    expect(reasonOf(`${table64}\nALTER TABLE t DROP KEY k0, ADD KEY k99 (c1);`)).toBe('ok');
  });

  it('FK 자동 인덱스도 센다: 받치는 인덱스가 없는 FK 는 1069, 있는 FK 는 받는다', () => {
    const noPk = `CREATE TABLE t (id INT, ${columns(10)}, ${keys(64)});`;
    expect(reasonOf(`${noPk}\nALTER TABLE t ADD FOREIGN KEY (id) REFERENCES p (id);`)).toMatch(/^2: .*\(MySQL 1069\)/);
    expect(reasonOf(`${noPk}\nALTER TABLE t ADD FOREIGN KEY (c0) REFERENCES p (id);`)).toBe('ok');
  });
});

describe('컬럼 1017개 한도 (MySQL 1117)', () => {
  it('CREATE TABLE 은 1017개까지 받고 1018개는 1117 이다', () => {
    expect(reasonOf(`CREATE TABLE t (${columns(1017)});`)).toBe('ok');
    expect(reasonOf(`CREATE TABLE t (${columns(1018)});`)).toMatch(/^1: .*\(MySQL 1117\)/);
  });

  it('ALTER TABLE 이 1018번째 컬럼을 더하면 1117 이다. 하나 지우고 더하면 받는다', () => {
    const wide = `CREATE TABLE t (${columns(1017)});`;
    expect(reasonOf(`${wide}\nALTER TABLE t ADD x INT;`)).toMatch(/^2: .*\(MySQL 1117\)/);
    expect(reasonOf(`${wide}\nALTER TABLE t ADD (x INT, y INT);`)).toMatch(/^2: .*\(MySQL 1117\)/);
    expect(reasonOf(`${wide}\nALTER TABLE t DROP c0, ADD x INT;`)).toBe('ok');
  });
});

// FK 는 MySQL 에 한도가 없지만 (MySQL 도 테이블 하나에 FK 2,000개면 CREATE TABLE 에 16 초가 걸린다), 문장마다 그 테이블의 FK 를 다시 훑으므로
// 테이블 하나의 FK 를 64개까지만 받는다. 넘으면 1차 지원 범위 밖으로 거부한다 (적용 시간을 묶는 한도)
describe('테이블당 FK 64개 (적용 시간 한도)', () => {
  const fks = (n: number) => Array.from({ length: n }, (_, i) => `CONSTRAINT f${i} FOREIGN KEY (x) REFERENCES p (id)`).join(', ');
  it('64개까지 받고, 65번째를 더하는 CREATE TABLE·ALTER TABLE 은 RE_EXPORT 로 거부한다', () => {
    expect(reasonOf(`CREATE TABLE c (x INT, ${fks(64)});`)).toBe('ok');
    const created = reasonOf(`CREATE TABLE c (x INT, ${fks(65)});`);
    expect(created).toMatch(/^1: .*FK/);
    expect(created.endsWith(RE_EXPORT)).toBe(true);
    const altered = reasonOf(`CREATE TABLE c (x INT, ${fks(64)});\nALTER TABLE c ADD FOREIGN KEY (x) REFERENCES p (id);`);
    expect(altered).toMatch(/^2: /);
    expect(altered.endsWith(RE_EXPORT)).toBe(true);
  });

  it('FK 가 이미 64개를 넘는 기준 테이블은 FK 를 더하지 않는 ALTER 도 거부하고, DROP·RENAME TABLE 과 다른 테이블의 ALTER 는 받는다', () => {
    const many = applyScript(base, `SET FOREIGN_KEY_CHECKS = 0;\nCREATE TABLE c (x INT, ${fks(64)});`, { schemaName: 'shop' });
    if (!many.ok) throw new Error(many.error.reason);
    const wide = { ...many.model, tables: many.model.tables.map((t) => (t.name === 'c' ? { ...t, foreignKeys: [...t.foreignKeys, { ...t.foreignKeys[0], name: 'f64' }] } : t)) };
    const reason = (script: string) => {
      const r = applyScript(wide, script, { schemaName: 'shop' });
      return r.ok ? 'ok' : r.error.reason;
    };
    expect(reason("ALTER TABLE c COMMENT 'x';").endsWith(RE_EXPORT)).toBe(true);
    expect(reason('RENAME TABLE c TO c2;')).toBe('ok');
    expect(reason('DROP TABLE c;')).toBe('ok');
    expect(reason("ALTER TABLE p COMMENT 'x';")).toBe('ok');
  });
});
