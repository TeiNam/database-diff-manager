// SchemaDiff → BASE를 TARGET으로 바꾸는 DDL. 순서는 FK·뷰 의존성 때문에 고정 (스펙 4.6)
import type { Op, SchemaDiff, TableDiff, ViewDiff } from './diff';
import { alter, alterStatements, commentBody, inheritCollation, manualBody, sqlBody, type StatementBody } from './ddl-alter';
import { quoteIdent as q } from './lexer';
import type { Table } from './model';
import { columnNote, fillColumn, fillIndex, generatedReason, hasUnknownGenerated, indexNote, printable, tableNote } from './partial-fill';
import { printForeignKey, printTable, printView } from './print';

export interface Statement extends StatementBody {
  object: string;
  kind: 'table' | 'view';
  op: Op;
  // sql: ';' 없음. comment=true(실행할 SQL 없는 안내 문장)면 '-- ' 주석 줄로만 이루어진다
  // notes: 문장 위에 '-- '로 붙는 안내 (MD 기반 미확인 속성 등)
}

const MARK: Record<Op, string> = { add: '+', drop: '-', modify: '~', rename: '>' };
const PARTIAL_NOTE = '-- [MD 기반] 일부 속성(Normal 인덱스 종류, 기본값, 생성 컬럼, 문자셋·콜레이션, CHECK, 파티션)은 비교하지 않았습니다';

export function generateDdl(diff: SchemaDiff): Statement[] {
  const out: Statement[] = [];
  const table = (d: TableDiff, body: StatementBody) => out.push({ object: d.name, kind: 'table', op: d.op, ...body });
  const view = (v: ViewDiff, body: StatementBody) => out.push({ object: v.name, kind: 'view', op: v.op, ...body });
  const altered = diff.tables.filter((d) => d.op === 'modify' || d.op === 'rename');

  // 1. FK 삭제 (rename 전 이름 사용)
  for (const d of altered) {
    const drops = d.foreignKeys.filter((f) => f.op === 'drop' || f.op === 'modify');
    if (drops.length) table(d, sqlBody(alter(d.oldName ?? d.name, drops.map((f) => `DROP FOREIGN KEY ${q(f.name)}`))));
  }
  // 1-b. 삭제될 테이블의 FK도 먼저 제거 (부모/자식 DROP 순서 무관하게, error 3730 방지)
  for (const d of diff.tables) {
    const fks = d.op === 'drop' ? d.from?.foreignKeys ?? [] : [];
    if (fks.length) table(d, sqlBody(alter(d.name, fks.map((f) => `DROP FOREIGN KEY ${q(f.name)}`))));
  }
  // 2. 뷰 삭제
  for (const v of diff.views) if (v.op === 'drop') view(v, sqlBody(`DROP VIEW ${q(v.name)}`));
  // 3. 테이블 rename
  for (const d of altered) if (d.op === 'rename') table(d, sqlBody(`RENAME TABLE ${q(d.oldName!)} TO ${q(d.name)}`));
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
  // 9. 뷰 생성·교체 (뷰가 참조하는 뷰를 먼저)
  for (const v of sortViews(diff.views.filter((x) => x.op !== 'drop'))) {
    view(v, v.to!.parseError
      ? commentBody(`-- [수동 확인 필요] ${v.name}: 파싱할 수 없는 뷰입니다. 원문을 확인하세요`)
      : sqlBody(printView(v.to!, { orReplace: true })));
  }
  return out;
}

export function renderDdl(stmts: Statement[], partial = false): string {
  const blocks = stmts.map((s) =>
    [`-- [${MARK[s.op]}] ${s.kind.toUpperCase()} ${s.object}`, ...(s.notes ?? []).map((n) => `-- ${n}`), s.comment ? s.sql : `${s.sql};`].join('\n'),
  );
  if (partial && blocks.length) blocks.unshift(PARTIAL_NOTE);
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
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
