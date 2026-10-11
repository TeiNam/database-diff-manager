// SchemaDiff → BASE를 TARGET으로 바꾸는 DDL. 순서는 FK·뷰 의존성 때문에 고정 (스펙 4.6)
import { renamedFkNames } from './auto-name';
import { guardStatements } from './ddl-guard';
import { RETYPED_FIELD, retypeGroups } from './fk-retype';
import { type Op, type RoutineDiff, type SchemaDiff, type TableDiff, type ViewDiff } from './diff';
import { alter, alterStatements, commentBody, inheritCollation, manualBody, sqlBody, type StatementBody } from './ddl-alter';
import { quoteIdent as q, quoteString } from './lexer';
import type { Routine, RoutineKind, Table } from './model';
import { columnNote, fillColumn, fillIndex, generatedReason, hasUnknownGenerated, indexNote, printable, tableNote } from './partial-fill';
import { printForeignKey, printRoutine, printTable, printView } from './print';
import { renameGroups, renameTableSql } from './table-rename';

export interface Statement extends StatementBody {
  object: string;
  kind: 'table' | 'view' | RoutineKind;
  op: Op;
  // sql: ';' 없음(delimited=true 인 루틴 CREATE 는 DELIMITER 로 감싼 완결된 문장). comment=true(실행할 SQL 없는 안내 문장)면 '-- ' 주석 줄로만 이루어진다
  // notes: 문장 위에 '-- '로 붙는 안내 (MD 기반 미확인 속성 등)
  // related: 한 문장이 여러 테이블을 함께 다룰 때(얽힌 테이블 rename) 그 테이블들의 TARGET 이름. object 도 포함한다
  related?: string[];
  // depends: 이 문장을 다른 테이블 문장과 함께 실행해야 할 때 그 묶음의 테이블들 (TARGET 이름, object 포함). 예: FK 로 묶인
  // 컬럼 타입 변경 — 부모 MODIFY 는 자식 FK 해제·재추가 없이 실행하면 실패한다. 객체 카드 복사는 objectStatements 로 묶음을 낸다
  depends?: string[];
}

const MARK: Record<Op, string> = { add: '+', drop: '-', modify: '~', rename: '>' };
const DEFINER_NOTE = 'DEFINER 없이 생성합니다 — 실행한 사용자가 DEFINER 가 됩니다';
const PIN_NOTE = 'RENAME INDEX x TO x: FK 를 다시 추가할 때 FK 가 만든 인덱스 이름이 FK 이름으로 바뀌지 않도록 고정합니다';
const RETYPE_NOTE = 'FK 컬럼(또는 참조 컬럼)의 타입·문자셋·콜레이션이 바뀌어 FK 를 먼저 삭제하고 마지막에 다시 추가합니다 (error 3780)';
const PARTIAL_NOTE = '-- [MD 기반] 일부 속성(Normal 인덱스 종류, 기본값, 생성 컬럼, 문자셋·콜레이션, CHECK, 파티션)은 비교하지 않았습니다';
const PARTIAL_CHECK_NOTE = '-- [MD 기반] MD 출처는 CHECK 를 알 수 없어, 실제 DB 에 CHECK 가 있으면 그 컬럼의 RENAME·CHANGE COLUMN 이 오류 3959 로 실패할 수 있습니다';

export function generateDdl(diff: SchemaDiff): Statement[] {
  const out: Statement[] = [];
  const table = (d: TableDiff, body: StatementBody) => out.push({ object: d.name, kind: 'table', op: d.op, ...body });
  const view = (v: ViewDiff, body: StatementBody) => out.push({ object: v.name, kind: 'view', op: v.op, ...body });
  const routine = (r: RoutineDiff, body: StatementBody) => out.push({ object: r.name, kind: r.kind, op: r.op, ...body });
  const altered = diff.tables.filter((d) => d.op === 'modify' || d.op === 'rename');

  // 1. FK 삭제 (rename 전 테이블·FK 이름 사용)
  for (const d of altered) {
    const drops = d.foreignKeys.filter((f) => f.op === 'drop' || f.op === 'modify');
    if (!drops.length) continue;
    const pinned = pinnedIndexes(d, drops);
    const clauses = [...drops.map((f) => `DROP FOREIGN KEY ${q(baseFkName(d, f.name))}`), ...pinned.map((n) => `RENAME INDEX ${q(n)} TO ${q(n)}`)];
    const notes = [...(pinned.length ? [PIN_NOTE] : []), ...(drops.some((f) => f.fields.includes(RETYPED_FIELD)) ? [RETYPE_NOTE] : [])];
    table(d, sqlBody(alter(d.oldName ?? d.name, clauses), notes));
  }
  // 1-b. 삭제될 테이블의 FK도 먼저 제거 (부모/자식 DROP 순서 무관하게, error 3730 방지)
  for (const d of diff.tables) {
    const fks = d.op === 'drop' ? d.from?.foreignKeys ?? [] : [];
    if (fks.length) table(d, sqlBody(alter(d.name, fks.map((f) => `DROP FOREIGN KEY ${q(f.name)}`))));
  }
  // 2. 뷰 삭제, 루틴 삭제(변경은 삭제 후 8-b 에서 다시 만든다)
  for (const v of diff.views) if (v.op === 'drop') view(v, sqlBody(`DROP VIEW ${q(v.name)}`));
  for (const r of diff.routines) {
    const name = r.op === 'drop' ? r.from!.name : r.name;
    if (r.op === 'add') continue;
    const drop = `DROP ${r.kind.toUpperCase()} IF EXISTS ${q(name)}`;
    // TARGET 을 파싱하지 못하면 다시 만들 수 없으므로 삭제도 실행하지 않는다
    routine(r, r.op === 'modify' && r.to!.parseError ? manualBody(`${name}: 바뀐 루틴을 파싱할 수 없어 삭제·재생성하지 않습니다. 원문을 확인하세요`, drop) : sqlBody(drop));
  }
  // 3. 테이블 rename (이름이 얽힌 rename 은 한 문장으로 묶는다)
  // 변경 없는 테이블·뷰 이름도 임시 이름 후보에서 뺀다 (RENAME 실패 1050 방지)
  const taken = new Set([...diff.objectNames, ...diff.tables.flatMap((d) => [d.name, d.oldName ?? d.name])]);
  for (const g of renameGroups(diff.tables, taken)) {
    const [first] = g.tables;
    if (g.tables.length === 1) table(first, sqlBody(renameTableSql(g.clauses)));
    else {
      const note = `얽힌 테이블 rename 을 한 문장으로 함께 적용합니다: ${g.tables.map((d) => `${d.oldName}→${d.name}`).join(', ')}`;
      out.push({ object: first.name, kind: 'table', op: 'rename', ...sqlBody(renameTableSql(g.clauses), [note]), related: g.tables.map((d) => d.name) });
    }
  }
  // 4. 테이블 생성 (FK는 8단계에서)
  for (const d of diff.tables) if (d.op === 'add') table(d, createTable(d.to!));
  // 5·6. 테이블 변경, 파티션
  for (const d of altered) for (const body of alterStatements(d)) table(d, body);
  // 7. 테이블 삭제
  for (const d of diff.tables) if (d.op === 'drop') table(d, sqlBody(`DROP TABLE ${q(d.name)}`));
  // 8. FK 추가
  for (const d of diff.tables) {
    const adds = d.op === 'add' ? d.to!.foreignKeys
      : d.op === 'drop' ? []
      : d.foreignKeys.filter((f) => f.op === 'add' || f.op === 'modify').map((f) => f.to!);
    if (adds.length) table(d, sqlBody(alter(d.name, adds.map((f) => `ADD ${printForeignKey(f)}`))));
  }
  // 8-b. 루틴 생성 (뷰가 함수를 부를 수 있어 뷰보다 먼저)
  for (const r of diff.routines) if (r.op !== 'drop') routine(r, createRoutine(r.to!));
  // 9. 뷰 생성·교체 (뷰가 참조하는 뷰를 먼저)
  for (const v of sortViews(diff.views.filter((x) => x.op !== 'drop'))) {
    view(v, v.to!.parseError
      ? commentBody(`-- [수동 확인 필요] ${v.name}: 파싱할 수 없는 뷰입니다. 원문을 확인하세요`)
      : sqlBody(printView(v.to!, { orReplace: true }), [DEFINER_NOTE]));
  }
  return guardStatements(withDepends(out, diff), diff);
}

function withDepends(stmts: Statement[], diff: SchemaDiff): Statement[] {
  const groups = retypeGroups(diff.tables);
  if (!groups.size) return stmts;
  return stmts.map((st) => {
    const g = st.kind === 'table' ? groups.get(st.object) : undefined;
    return g ? { ...st, depends: g } : st;
  });
}

// 객체 카드에서 복사할 문장: 그 객체의 문장(여러 테이블을 함께 다루는 문장은 related 의 모든 테이블)과, 그 문장들이 depends 로
// 요구하는 다른 테이블의 묶음 문장. 순서는 전체 DDL 순서를 따른다. dependencies: 함께 들어간 다른 객체 이름 (이름순)
export function objectStatements(stmts: Statement[], kind: Statement['kind'], name: string): { statements: Statement[]; dependencies: string[] } {
  const isOwn = (st: Statement) => st.kind === kind && (st.object === name || Boolean(st.related?.includes(name)));
  const needed = new Set(stmts.filter(isOwn).flatMap((st) => st.depends ?? []));
  const statements = stmts.filter((st) => isOwn(st) || (st.kind === 'table' && st.depends !== undefined && needed.has(st.object)));
  const dependencies = [...new Set(statements.filter((st) => !isOwn(st)).map((st) => st.object))].sort();
  return { statements, dependencies };
}

// diff 의 FK 이름(rename 된 테이블의 자동 이름은 새 테이블 이름으로 바꾼 것)에 해당하는 BASE FK 이름
function baseFkName(d: TableDiff, name: string): string {
  if (!d.oldName || !d.from) return name;
  const fks = d.from.foreignKeys;
  const renamed = renamedFkNames(fks, d.oldName, d.name);
  const i = renamed.indexOf(name);
  return i < 0 ? name : fks[i].name;
}

// FK 가 자동으로 만든 인덱스는 같은 컬럼에 이름 있는 FK 를 다시 추가하면 그 FK 이름으로 바뀐다 (SHOW CREATE 로는 직접 만든
// 인덱스와 구별할 수 없다). 삭제하는 FK 의 컬럼으로 시작하는 BASE 인덱스를 같은 이름으로 RENAME 해 두면 이름이 고정된다
function pinnedIndexes(d: TableDiff, drops: TableDiff['foreignKeys']): string[] {
  const added = d.foreignKeys.filter((f) => f.op === 'add' || f.op === 'modify').map((f) => f.name);
  const startsWith = (cols: string[], prefix: string[]) => prefix.length > 0 && prefix.every((c, i) => cols[i] === c);
  // 5단계에서 삭제·재생성·rename 하는 인덱스는 그 문장이 이름을 정한다
  const changed = new Set(d.indexes.map((i) => i.oldName ?? i.name));
  return (d.from?.indexes ?? [])
    .filter((i) => (i.kind === 'INDEX' || i.kind === 'UNIQUE') && !changed.has(i.name) && added.some((n) => n !== i.name))
    .filter((i) => drops.some((f) => startsWith(i.parts.map((p) => p.column ?? ''), f.from!.columns)))
    .map((i) => i.name);
}

export function renderDdl(stmts: Statement[], partial = false): string {
  const blocks = stmts.map((s) =>
    [`-- [${MARK[s.op]}] ${s.kind.toUpperCase()} ${s.object}`, ...(s.notes ?? []).map((n) => `-- ${n}`), statementText(s)].join('\n'),
  );
  if (partial && blocks.length) {
    const renamesColumn = stmts.some((s) => !s.comment && /\b(?:RENAME|CHANGE) COLUMN\b/.test(s.sql));
    blocks.unshift(renamesColumn ? `${PARTIAL_NOTE}\n${PARTIAL_CHECK_NOTE}` : PARTIAL_NOTE);
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

// 화면·파일에 찍을 문장 본문: 주석과 DELIMITER 로 감싼 루틴은 그대로, 나머지는 ';' 를 붙인다
export const statementText = (s: StatementBody): string => (s.comment || s.delimited ? s.sql : `${s.sql};`);

// DELIMITER ;; 로 감싸 mysql 클라이언트에 그대로 붙여 넣을 수 있게 한다. SQL_MODE 를 알면 앞뒤로 설정·복원한다
function createRoutine(r: Routine): StatementBody {
  if (r.parseError) return commentBody(`-- [수동 확인 필요] ${r.name}: 파싱할 수 없는 루틴입니다. 원문을 확인하세요`);
  const lines = ['DELIMITER ;;', `${printRoutine(r)};;`, 'DELIMITER ;'];
  const sql = r.sqlMode === undefined
    ? lines
    : [`SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = ${quoteString(r.sqlMode)};`, ...lines, 'SET SQL_MODE = @OLD_SQL_MODE;'];
  return { sql: sql.join('\n'), comment: false, notes: [DEFINER_NOTE], delimited: true };
}

// partial 출처 테이블은 알 수 없는 속성을 안내하고, 생성 컬럼 표현식을 모르면 수동 확인으로 돌린다
function createTable(t: Table): StatementBody {
  if (t.parseError && t.fidelity === 'partial') return commentBody(`-- [수동 확인 필요] ${t.name}: 파싱할 수 없는 MD 정의입니다. 원문을 확인하세요`);
  const columns = t.columns.map((c) => fillColumn(c));
  const indexes = t.indexes.map((i) => fillIndex(i));
  const notes = [tableNote(t), ...columns.map(columnNote), ...indexes.map(indexNote)].filter((n): n is string => n !== undefined);
  const sql = printTable({ ...t, columns: columns.map((c) => printable(inheritCollation(c, t))), indexes }, { foreignKeys: false });
  const missing = columns.filter(hasUnknownGenerated).map((c) => c.name);
  return missing.length ? manualBody(generatedReason(t.name, missing), sql, notes) : sqlBody(sql, notes);
}

function sortViews(views: ViewDiff[]): ViewDiff[] {
  const done = new Set<string>();
  const out: ViewDiff[] = [];
  const visit = (v: ViewDiff) => {
    if (done.has(v.name)) return;
    done.add(v.name);
    for (const dep of views) if (dep !== v && v.to!.body.includes(q(dep.name))) visit(dep);
    out.push(v);
  };
  views.forEach(visit);
  return out;
}
