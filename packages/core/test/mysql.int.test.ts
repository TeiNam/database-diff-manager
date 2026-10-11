// 실증: base에 생성 DDL을 실제로 적용한 뒤 SHOW CREATE 결과가 target과 같은지 확인한다
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDdl, objectStatements, type Statement } from '../src/ddl';
import { diffSchemas } from '../src/diff';
import type { Routine, SchemaModel, Table, View } from '../src/model';
import { splitStatements } from '../src/parse-dump';
import { parseCreateTable } from '../src/parse-table';
import { parseCreateView } from '../src/parse-view';
import { parseRoutine } from '../src/parse-routine';
import { routineLexMode } from '../src/normalize';
import { fixture, scenario, scenarioManual, SCENARIOS, scenarioValues } from './helpers';

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

  // 시나리오 BASE 로 새 DB 를 만든다 (기존 DB 는 지운다)
  const freshBase = async (db: string, name: string) => {
    await conn.query(`DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\`; USE \`${db}\``);
    for (const { ddl } of splitStatements(fixture(`scenarios/${name}/base.sql`))) await conn.query(ddl);
  };

  const apply = async (stmts: Statement[]) => {
    for (const s of stmts) {
      if (s.comment) continue;
      // DELIMITER 로 감싼 루틴 문장은 클라이언트 명령을 빼고 문장 단위로 보낸다
      if (s.delimited) for (const { ddl } of splitStatements(s.sql)) await conn.query(ddl);
      else await conn.query(s.sql);
    }
  };

  it.each(SCENARIOS)('%s: base + 생성 DDL = target', async (name) => {
    const db = `it_${name.replace(/-/g, '_')}`;
    await freshBase(db, name);
    const values = scenarioValues(name);
    if (values) await conn.query(values.seed);

    const { base, target, renames } = scenario(name);
    await apply(generateDdl(diffSchemas(base, target, renames)));

    const dumped = await dumpSchema(conn, db);
    const after = diffSchemas(dumped, target);
    const changed = { tables: after.tables.map((t) => t.name), views: after.views.map((v) => v.name), routines: after.routines.map((r) => `${r.kind} ${r.name} ${r.fields.join(',')}`) };
    // 수동 확인 테이블만 TARGET 과 다르고, 그 테이블은 반쯤 적용되지 않고 BASE 그대로여야 한다
    const manual = scenarioManual(name);
    expect(changed).toEqual({ tables: manual, views: [], routines: [] });
    const touched = diffSchemas(base, dumped).tables.map((t) => t.name).filter((n) => manual.includes(n));
    expect(touched).toEqual([]);
    if (values) {
      const [rows] = await conn.query<RowDataPacket[]>(values.query);
      expect(rows.map((r) => ({ ...r }))).toEqual(values.rows);
    }
    await conn.query(`DROP DATABASE \`${db}\``);
  });

  // 객체 카드 복사 묶음(objectStatements)은 새 BASE DB 에 그것만 실행해도 오류 없이 적용돼야 한다
  it.each(SCENARIOS)('%s: 객체 카드 묶음 단독 적용', async (name) => {
    const db = `itc_${name.replace(/-/g, '_')}`;
    const { base, target, renames } = scenario(name);
    const stmts = generateDdl(diffSchemas(base, target, renames));
    const cards = [...new Map(stmts.flatMap((s) => [s.object, ...(s.related ?? [])].map((o) => [`${s.kind} ${o}`, [s.kind, o] as const]))).values()];
    const failed: string[] = [];
    for (const [kind, object] of cards) {
      await freshBase(db, name);
      try {
        await apply(objectStatements(stmts, kind, object).statements);
      } catch (e) {
        failed.push(`${kind} ${object}: ${(e as Error).message}`);
      }
    }
    await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
    expect(failed).toEqual([]);
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
  return { name: db, tables, views, routines: await dumpRoutines(conn, db) };
}

// SHOW CREATE FUNCTION/PROCEDURE 와 그 sql_mode 로 루틴을 읽는다
async function dumpRoutines(conn: Connection, db: string): Promise<Routine[]> {
  const out: Routine[] = [];
  for (const kind of ['FUNCTION', 'PROCEDURE'] as const) {
    const [rows] = await conn.query<RowDataPacket[]>(`SHOW ${kind} STATUS WHERE Db = ?`, [db]);
    for (const row of rows) {
      const [created] = await conn.query<RowDataPacket[]>(`SHOW CREATE ${kind} \`${String(row.Name)}\``);
      const ddl = String(created[0][kind === 'FUNCTION' ? 'Create Function' : 'Create Procedure']);
      const sqlMode = String(created[0].sql_mode);
      out.push({ ...parseRoutine(ddl, routineLexMode(sqlMode)), sqlMode });
    }
  }
  return out;
}
