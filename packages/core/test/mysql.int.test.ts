// 실증: base에 생성 DDL을 실제로 적용한 뒤 SHOW CREATE 결과가 target과 같은지 확인한다
import { execFileSync } from 'node:child_process';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDdl, objectStatements, renderDdl, type Statement } from '../src/ddl';
import { diffSchemas, type SchemaDiff } from '../src/diff';
import type { Routine, SchemaModel, Table, View } from '../src/model';
import { parseSqlDump, splitStatements } from '../src/parse-dump';
import { parseMdDump } from '../src/parse-md';
import { parseCreateTable } from '../src/parse-table';
import { parseCreateView } from '../src/parse-view';
import { parseRoutine } from '../src/parse-routine';
import { routineLexMode } from '../src/normalize';
import { commentPart, fixture, scenario, scenarioManual, scenarioManualObjects, SCENARIOS, scenarioValues } from './helpers';
import { BOUNDARY_CASES, MD_INJECTIONS, MD_OK, MD_VIEW_INJECTIONS, mdDump, PRECIOUS, SQL_INJECTION } from './injection-fixtures';
import { tokenize } from '../src/lexer';

const TARGETS = [
  { name: 'MySQL 8.0', port: 33080 },
  { name: 'MySQL 8.4', port: 33084 },
];
const suite = process.env.MYSQL_IT === '1' ? describe : describe.skip;

// mysql 클라이언트(DELIMITER·주석·'\\g' 를 클라이언트가 해석한다)가 있으면 렌더한 DDL 을 그대로 흘려 넣는다
const hasMysqlClient = (() => {
  try {
    execFileSync('mysql', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// 카드 단독 적용 뒤 TARGET 과 같아야 하는 객체: 카드에 문장이 있고, 그 문장이 모두 실행 문장이며(수동 확인·안내 주석이 있으면
// 부분 적용이 의도된 것), 삭제되는 객체가 아니고, 수동 확인 시나리오 테이블이 아닌 것
function completeCardObjects(card: Statement[], diff: SchemaDiff, manual: string[]): Set<string> {
  const key = (kind: string, name: string) => `${kind === 'table' || kind === 'view' ? 'relation' : kind} ${name}`;
  const keysOf = (st: Statement) => (st.related ?? [st.object]).map((n) => key(st.kind, n));
  const partial = new Set(card.filter((st) => st.comment).flatMap(keysOf));
  const dropped = new Set([...diff.tables.filter((t) => t.op === 'drop').map((t) => key('table', t.name)),
    ...diff.views.filter((v) => v.op === 'drop').map((v) => key('view', v.name)),
    ...diff.routines.filter((r) => r.op === 'drop').map((r) => key(r.kind, r.name))]);
  return new Set(card.flatMap(keysOf).filter((k) => !partial.has(k) && !dropped.has(k) && !manual.some((m) => k === key('table', m))));
}

// 덤프와 TARGET 이 다른 객체 키
function changedObjects(dumped: SchemaModel, target: SchemaModel): Set<string> {
  const after = diffSchemas(dumped, target);
  return new Set([...after.tables.map((t) => `relation ${t.name}`), ...after.views.map((v) => `relation ${v.name}`), ...after.routines.map((r) => `${r.kind} ${r.name}`)]);
}

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
    const stmts = generateDdl(diffSchemas(base, target, renames));
    // 주석 부분(머리·notes·주석 문장)은 서버에서도 실행할 문장이 0개다: 뒤에 붙인 SELECT 하나만 결과를 낸다
    for (const s of stmts) {
      const [res] = await conn.query(`${commentPart(s)}\nSELECT 1 AS ok`);
      expect(res, commentPart(s)).toEqual([{ ok: 1 }]);
    }
    await apply(stmts);

    const dumped = await dumpSchema(conn, db);
    const after = diffSchemas(dumped, target);
    // 수동 확인 객체만 TARGET 과 다르고, 수동 확인 테이블은 반쯤 적용되지 않고 BASE 그대로여야 한다
    const { tables: manual, views: manualViews, routines: manualRoutines } = scenarioManualObjects(name);
    const changed = { tables: after.tables.map((t) => t.name), views: after.views.map((v) => v.name),
      routines: after.routines.filter((r) => !manualRoutines.includes(`${r.kind} ${r.name}`)).map((r) => `${r.kind} ${r.name} ${r.fields.join(',')}`) };
    expect(changed).toEqual({ tables: manual, views: manualViews, routines: [] });
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
    const diff = diffSchemas(base, target, renames);
    for (const [kind, object] of cards) {
      await freshBase(db, name);
      const card = objectStatements(stmts, kind, object).statements;
      try {
        await apply(card);
      } catch (e) {
        failed.push(`${kind} ${object}: ${(e as Error).message}`);
        continue;
      }
      // 카드에 넣은 객체는 그 정의가 TARGET 과 같아야 한다 (FK 가 빠진 채 만든 테이블 등)
      const changed = changedObjects(await dumpSchema(conn, db), target);
      const wrong = [...completeCardObjects(card, diff, scenarioManual(name))].filter((k) => changed.has(k));
      if (wrong.length) failed.push(`${kind} ${object}: TARGET 과 다른 객체 ${wrong.join(', ')}`);
    }
    await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
    expect(failed).toEqual([]);
  });

  // 주입 MD·SQL 로 만든 DDL 을 mysql 클라이언트로 끝까지(--force) 흘려 넣어도 sentinel 테이블 precious 가 남아야 한다
  it.skipIf(!hasMysqlClient)('MD·SQL 주입: 렌더한 DDL 을 mysql 클라이언트로 적용해도 precious 가 남는다', async () => {
    const db = 'it_injection';
    const md = parseMdDump(mdDump({ t_ok: MD_OK, ...MD_INJECTIONS, ...MD_VIEW_INJECTIONS })).model;
    const precious = parseSqlDump(PRECIOUS).model;
    const runs = [
      { base: PRECIOUS, diff: diffSchemas(precious, { ...md, tables: [...md.tables, ...precious.tables] }) },
      { base: SQL_INJECTION.base, diff: diffSchemas(parseSqlDump(SQL_INJECTION.base).model, parseSqlDump(SQL_INJECTION.target).model) },
    ];
    for (const run of runs) {
      await conn.query(`DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\`; USE \`${db}\``);
      for (const { ddl } of splitStatements(run.base)) await conn.query(ddl);
      const input = renderDdl(generateDdl(run.diff), run.diff.partial);
      try {
        execFileSync('mysql', ['-h127.0.0.1', `-P${port}`, '-uroot', '-ptest', '--force', db], { input, stdio: ['pipe', 'ignore', 'ignore'] });
      } catch {
        // --force 라 오류 문장이 있어도 끝까지 실행한다 (종료 코드만 실패)
      }
      const [rows] = await conn.query<RowDataPacket[]>('SHOW TABLES LIKE ?', ['precious']);
      expect(rows.length, input).toBe(1);
    }
    await conn.query(`DROP DATABASE \`${db}\``);
  });

  // 실행 문장 경계 고정 사례: 기본·NO_BACKSLASH_ESCAPES 세션 × --force 유무로 mysql 클라이언트에 흘려 넣어 precious 가 남고,
  // --force 로 끝까지 보낸 실행 문장 수(--verbose 가 찍는 문장 중 주석뿐이 아닌 것)가 우리 판정 수와 같아야 한다
  it.skipIf(!hasMysqlClient)('실행 문장 경계: 클라이언트가 보낸 문장 수가 우리 판정과 같고 precious 가 남는다', async () => {
    const db = 'it_boundary';
    const failed: string[] = [];
    for (const c of BOUNDARY_CASES) {
      const base = [PRECIOUS, c.base].filter((x) => x).join('\n');
      const diff = diffSchemas(parseSqlDump(base).model, parseSqlDump(`${PRECIOUS}\n${c.target}`).model);
      const stmts = generateDdl(diff);
      const ours = stmts.filter((s) => !s.comment).reduce((n, s) => n + (s.delimited ? splitStatements(s.sql).length : 1), 0);
      const script = renderDdl(stmts, diff.partial);
      for (const nbe of [false, true]) for (const force of [false, true]) {
        await conn.query(`DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\`; USE \`${db}\``);
        execFileSync('mysql', [...CLIENT(port), db], { input: base, stdio: ['pipe', 'ignore', 'ignore'] });
        const out = runClient([...CLIENT(port), '--verbose', ...(force ? ['--force'] : []), db], (nbe ? NBE_SESSION : '') + script);
        const [rows] = await conn.query<RowDataPacket[]>('SHOW TABLES LIKE ?', ['precious']);
        const label = `${c.name} nbe=${nbe} force=${force}`;
        if (rows.length !== 1) failed.push(`${label}: precious 소실`);
        const sent = sentStatements(out) - (nbe ? 1 : 0);
        if (force && sent !== ours) failed.push(`${label}: 클라이언트 ${sent} 문장, 우리 판정 ${ours} 문장`);
      }
    }
    await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
    expect(failed).toEqual([]);
  });
});

const CLIENT = (port: number) => ['-h127.0.0.1', `-P${port}`, '-uroot', '-ptest', '-N'];
const NBE_SESSION = "SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES');\n";
const VERBOSE_SEP = '--------------\n';

// 오류로 끝나도(--force 없이 멈추거나 --force 의 종료 코드) 표준 출력은 쓴다
function runClient(args: string[], input: string): string {
  try {
    return execFileSync('mysql', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (e) {
    return String((e as { stdout?: unknown }).stdout ?? '');
  }
}

// --verbose 출력: 보낸 문장마다 구분선 사이에 찍힌다 (홀수 번째 조각). 주석뿐인 문장(클라이언트가 주석 줄도 보낸다)은 세지 않는다
function sentStatements(out: string): number {
  return out.split(VERBOSE_SEP).filter((_, i) => i % 2 === 1).filter((text) => {
    try {
      return tokenize(text).length > 0;
    } catch {
      return true;
    }
  }).length;
}

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
