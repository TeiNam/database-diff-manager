// ALTER 적용 실증: 같은 스크립트를 MySQL 에 실행한 결과와 applyScript 결과가 같은지 확인한다.
// 기준: 비교 엔진으로 양방향 0문장 + 테이블마다 컬럼·인덱스·FK·CHECK 이름 순서가 같음 + printSqlDump 왕복
// 시나리오 폴더: script.sql(필수), base.sql(없으면 _base.sql), expect-error.txt(MySQL 오류 번호), only.txt(그 버전에서만),
// defaults.json({ charset, collation } — 스키마 기본값: DB 를 그 값으로 만들고 applyScript 에도 넘긴다),
// re-export.txt(있으면 우리는 오류 번호 대신 1차 범위 밖 안내(RE_EXPORT)로 거부한다 — 예: InnoDB 만 지원하므로 MySQL 3776 대신 안내)
// 실패 시나리오는 MySQL 이 실패한 문장 번호와 우리가 거부한 문장 번호가 같고, 우리 사유에 같은 MySQL 오류 번호가 있어야 통과한다
import { readdirSync } from 'node:fs';
import mysql, { type Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyScript, printSqlDump } from '../src/apply';
import { RE_EXPORT } from '../src/apply/types';
import { canonicalJson } from '../src/canonical';
import { generateDdl } from '../src/ddl';
import { diffSchemas } from '../src/diff';
import type { SchemaModel } from '../src/model';
import { parseSqlDump, splitStatements } from '../src/parse-dump';
import { fixture, hasFixture } from './helpers';
import { dumpSchema, MYSQL_TARGETS } from './mysql-dump';

const SCENARIOS = readdirSync(new URL('./fixtures/alter-scenarios/', import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const suite = process.env.MYSQL_IT === '1' ? describe : describe.skip;
const COMPLETE = { level: 'complete' as const, objects: [] };
const at = (name: string, file: string) => `alter-scenarios/${name}/${file}`;
const zeroDiff = (from: SchemaModel, to: SchemaModel) => generateDdl(diffSchemas({ ...from, evidence: COMPLETE }, { ...to, evidence: COMPLETE })).map((s) => s.sql);
const names = (m: SchemaModel) => Object.fromEntries(m.tables.map((t) => [t.name, {
  columns: t.columns.map((c) => c.name), indexes: t.indexes.map((i) => i.name), fks: t.foreignKeys.map((f) => f.name), checks: t.checks.map((k) => k.name),
}]));

suite.each(MYSQL_TARGETS)('$name ALTER 적용', ({ name: target, port }) => {
  let conn: Connection;

  beforeAll(async () => {
    conn = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: 'test' });
  });

  afterAll(async () => {
    await conn?.end();
  });

  it.each(SCENARIOS)('%s', async (name) => {
    if (hasFixture(at(name, 'only.txt')) && fixture(at(name, 'only.txt')).trim() !== target) return;
    const db = `ap_${name.replace(/-/g, '_')}`;
    const baseText = (hasFixture(at(name, 'base.sql')) ? fixture(at(name, 'base.sql')) : fixture('alter-scenarios/_base.sql')).replaceAll('__DB__', db);
    const script = fixture(at(name, 'script.sql')).replaceAll('__DB__', db);
    const expectError = hasFixture(at(name, 'expect-error.txt')) ? Number(fixture(at(name, 'expect-error.txt')).trim()) : undefined;
    const defaults = hasFixture(at(name, 'defaults.json')) ? (JSON.parse(fixture(at(name, 'defaults.json'))) as { charset: string; collation: string }) : undefined;
    await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await conn.query(`CREATE DATABASE \`${db}\` DEFAULT CHARACTER SET ${defaults?.charset ?? 'utf8mb4'} COLLATE ${defaults?.collation ?? 'utf8mb4_0900_ai_ci'}`);
    await conn.query(`USE \`${db}\``);
    await conn.query('SET SESSION sql_mode = DEFAULT, foreign_key_checks = 1');
    try {
      for (const { ddl } of splitStatements(baseText)) await conn.query(ddl);
      const base = parseSqlDump(baseText).model;
      expect(zeroDiff(base, await dumpSchema(conn, db)), 'base.sql 이 MySQL 출력과 같아야 한다').toEqual([]);
      const ours = applyScript(base, script, { schemaName: db, ...(defaults ? { defaults } : {}) });
      let mysqlError: number | undefined;
      let mysqlStatement = 0; // MySQL 이 실패한 문장 번호 (1부터 — applyScript 의 error.index 와 같은 순번)
      try {
        for (const [i, { ddl }] of splitStatements(script).entries()) {
          mysqlStatement = i + 1;
          await conn.query(ddl);
        }
      } catch (e) {
        mysqlError = (e as { errno?: number }).errno ?? -1;
      }
      if (expectError !== undefined) {
        expect(mysqlError, 'MySQL 이 거부해야 한다').toBe(expectError);
        if (ours.ok) throw new Error('우리도 거부해야 한다');
        expect(ours.error.index, `MySQL 이 실패한 ${mysqlStatement}번째 문장에서 거부해야 한다 — ${ours.error.reason}`).toBe(mysqlStatement);
        if (hasFixture(at(name, 're-export.txt'))) expect(ours.error.reason.endsWith(RE_EXPORT), `1차 범위 밖 안내(RE_EXPORT)로 거부해야 한다 — ${ours.error.reason}`).toBe(true);
        else expect(ours.error.reason, `같은 MySQL 오류 번호 ${expectError} 로 거부해야 한다`).toMatch(new RegExp(`\\(MySQL (?:8\\.4 )?${expectError}\\b`));
        return;
      }
      expect(mysqlError, 'MySQL 이 스크립트를 받아야 한다').toBeUndefined();
      if (!ours.ok) throw new Error(`applyScript 실패 — ${ours.error.index}번째 문장 (줄 ${ours.error.line}): ${ours.error.reason}`);
      const dumped = await dumpSchema(conn, db);
      expect(zeroDiff(ours.model, dumped), '우리 → MySQL').toEqual([]);
      expect(zeroDiff(dumped, ours.model), 'MySQL → 우리').toEqual([]);
      expect(names(ours.model), '이름 순서').toEqual(names(dumped));
      const again = parseSqlDump(printSqlDump(ours.model));
      expect(again.warnings, 'printSqlDump 왕복 경고').toEqual([]);
      expect(canonicalJson([again.model.tables, again.model.views, again.model.routines])).toBe(canonicalJson([ours.model.tables, ours.model.views, ours.model.routines]));
    } finally {
      await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
    }
  });
});
