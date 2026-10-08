// 실증: base에 생성 DDL을 실제로 적용한 뒤 SHOW CREATE 결과가 target과 같은지 확인한다
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDdl } from '../src/ddl';
import { diffSchemas } from '../src/diff';
import type { SchemaModel, Table, View } from '../src/model';
import { splitStatements } from '../src/parse-dump';
import { parseCreateTable } from '../src/parse-table';
import { parseCreateView } from '../src/parse-view';
import { fixture, scenario, SCENARIOS, scenarioValues } from './helpers';

const TARGETS = [
  { name: 'MySQL 8.0', port: 33080 },
  { name: 'MySQL 8.4', port: 33084 },
];
const suite = process.env.MYSQL_IT === '1' ? describe : describe.skip;

suite.each(TARGETS)('$name', ({ port }) => {
  let conn: Connection;

  beforeAll(async () => {
    conn = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: 'test', multipleStatements: true });
  });

  afterAll(async () => {
    await conn?.end();
  });

  it.each(SCENARIOS)('%s: base + 생성 DDL = target', async (name) => {
    const db = `it_${name.replace(/-/g, '_')}`;
    await conn.query(`DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\`; USE \`${db}\``);
    for (const { ddl } of splitStatements(fixture(`scenarios/${name}/base.sql`))) await conn.query(ddl);
    const values = scenarioValues(name);
    if (values) await conn.query(values.seed);

    const { base, target, renames } = scenario(name);
    for (const s of generateDdl(diffSchemas(base, target, renames))) {
      if (!s.comment) await conn.query(s.sql);
    }

    const after = diffSchemas(await dumpSchema(conn, db), target);
    expect({ tables: after.tables.map((t) => t.name), views: after.views.map((v) => v.name) }).toEqual({ tables: [], views: [] });
    if (values) {
      const [rows] = await conn.query<RowDataPacket[]>(values.query);
      expect(rows.map((r) => ({ ...r }))).toEqual(values.rows);
    }
  });
});

async function dumpSchema(conn: Connection, db: string): Promise<SchemaModel> {
  const [rows] = await conn.query<RowDataPacket[]>('SHOW FULL TABLES');
  const tables: Table[] = [];
  const views: View[] = [];
  for (const row of rows) {
    const name = String(Object.values(row)[0]);
    const [created] = await conn.query<RowDataPacket[]>(`SHOW CREATE TABLE \`${name}\``);
    if (row.Table_type === 'VIEW') views.push(parseCreateView(String(created[0]['Create View'])));
    else tables.push(parseCreateTable(String(created[0]['Create Table'])));
  }
  return { name: db, tables, views };
}
