// MySQL 실증 테스트 공용: 대상 서버(8.0·8.4)와 SHOW CREATE 로 스키마 모델 읽기
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { Routine, SchemaModel, Table, View } from '../src/model';
import { routineLexMode } from '../src/normalize';
import { parseRoutine } from '../src/parse-routine';
import { parseCreateTable } from '../src/parse-table';
import { parseCreateView } from '../src/parse-view';

// 포트는 MYSQL80_PORT / MYSQL84_PORT 로 바꿀 수 있다 (기본 33080 / 33084 — docker-compose.test.yml)
function portOf(env: string | undefined, fallback: number): number {
  if (env === undefined || env === '') return fallback;
  const port = Number(env);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`잘못된 MySQL 포트: ${env}`);
  return port;
}

export const MYSQL_TARGETS = [
  { name: 'MySQL 8.0', port: portOf(process.env.MYSQL80_PORT, 33080) },
  { name: 'MySQL 8.4', port: portOf(process.env.MYSQL84_PORT, 33084) },
];

// 지금 DB(USE)의 테이블·뷰·루틴을 SHOW CREATE 로 읽는다
export async function dumpSchema(conn: Connection, db: string): Promise<SchemaModel> {
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
