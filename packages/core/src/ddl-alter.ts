// 변경 테이블 하나의 ALTER TABLE 문장들 (스펙 4.6의 5·6단계)
import { baseColumns, charsetOptions, charsetPlan, type CharsetPlan } from './charset-ddl';
import type { Change, OptionChange, TableDiff } from './diff';
import { quoteIdent as q, quoteString } from './lexer';
import type { Column, Index, IndexKind, Table } from './model';
import { columnNote, fillColumn, fillIndex, generatedReason, hasUnknownGenerated, indexNote, printable } from './partial-fill';
import { partitionStatements } from './partition-ddl';
import { printCheck, printColumn, printIndexParts } from './print';

// 문장 본문: sql은 ';' 없음. comment=true면 '-- ' 주석 줄로만 이루어진다
export interface StatementBody {
  sql: string;
  comment: boolean;
  notes?: string[];
}

const ADD_KEYWORD: Record<IndexKind, string> = {
  PRIMARY: 'PRIMARY KEY', UNIQUE: 'UNIQUE INDEX', INDEX: 'INDEX', FULLTEXT: 'FULLTEXT INDEX', SPATIAL: 'SPATIAL INDEX',
};
// 옵션을 지울 때 기본값으로 되돌리는 구문
const OPTION_RESET: Record<string, string> = {
  COMMENT: "COMMENT=''",
  ROW_FORMAT: 'ROW_FORMAT=DEFAULT',
  KEY_BLOCK_SIZE: 'KEY_BLOCK_SIZE=0',
  STATS_PERSISTENT: 'STATS_PERSISTENT=DEFAULT',
  STATS_AUTO_RECALC: 'STATS_AUTO_RECALC=DEFAULT',
  STATS_SAMPLE_PAGES: 'STATS_SAMPLE_PAGES=DEFAULT',
  COMPRESSION: "COMPRESSION='None'",
};

export const sqlBody = (sql: string, notes: string[] = []): StatementBody => (notes.length ? { sql, comment: false, notes } : { sql, comment: false });
export const commentBody = (text: string): StatementBody => ({ sql: text, comment: true });

// 실행하면 안 되는 문장: 사유와 함께 SQL을 주석 처리해 보여 준다
export function manualBody(reason: string, sql: string, notes: string[] = []): StatementBody {
  const text = [`-- [수동 확인 필요] ${reason}`, ...sql.split('\n').map((l) => `-- ${l}`)].join('\n');
  return notes.length ? { sql: text, comment: true, notes } : { sql: text, comment: true };
}

export function alter(name: string, clauses: string[]): string {
  return `ALTER TABLE ${q(name)}\n${clauses.map((c) => `  ${c}`).join(',\n')}`;
}

interface Collected {
  clauses: string[];
  notes: string[];
  missing: string[]; // 표현식을 모르는 생성 컬럼
}

export function alterStatements(d: TableDiff): StatementBody[] {
  if (d.unparsed) return [commentBody(`-- [수동 확인 필요] ${d.name}: 파싱할 수 없는 DDL이 변경되었습니다. 원문을 비교하세요`)];
  const plan = charsetPlan(d);
  const options = charsetOptions(d.options, plan);
  const main = alterClauses(d, options, plan?.columns ?? new Set());
  const out: StatementBody[] = plan?.convert ? [convertBody(d.name, plan.convert, plan.notes, main.missing)] : [];
  if (main.clauses.length) {
    const sql = alter(d.name, main.clauses);
    const notes = [...(plan && !plan.convert ? plan.notes : []), ...main.notes];
    out.push(main.missing.length ? manualBody(generatedReason(d.name, main.missing), sql, notes) : sqlBody(sql, notes));
  }
  out.push(...optionNotes(options).map(commentBody));
  for (const sql of partitionStatements(d)) out.push(sql.startsWith('--') ? commentBody(sql) : sqlBody(sql));
  return out;
}

// 본 ALTER가 수동 확인 문장이면 앞선 CONVERT TO도 실행하지 않도록 함께 수동 확인으로 돌린다
function convertBody(table: string, sql: string, notes: string[], missing: string[]): StatementBody {
  if (!missing.length) return sqlBody(sql, notes);
  return manualBody(`${table}: 이어지는 ALTER가 수동 확인 문장이므로 함께 확인한 뒤 실행하세요`, sql, notes);
}

// 절 순서: 삭제(CHECK·인덱스·컬럼) → 컬럼 추가·변경(TARGET 순서) → 인덱스 추가·rename·가시성 → CHECK 추가 → 옵션
function alterClauses(d: TableDiff, options: OptionChange[], forced: CharsetPlan['columns']): Collected {
  const out: Collected = { clauses: [], notes: [], missing: [] };
  for (const c of d.checks) if (c.op === 'drop' || c.op === 'modify') out.clauses.push(`DROP CHECK ${q(c.name)}`);
  for (const i of d.indexes) if (rebuildsIndex(i) || i.op === 'drop') out.clauses.push(dropIndex(i.oldName ?? i.name, i.from!.kind));
  for (const c of d.columns) if (c.op === 'drop') out.clauses.push(`DROP COLUMN ${q(c.name)}`);
  columnClauses(d, forced, out);
  for (const i of d.indexes) {
    if (i.op === 'add' || rebuildsIndex(i)) {
      const idx = fillIndex(i.to!, i.op === 'add' ? undefined : i.from);
      out.clauses.push(addIndex(idx));
      pushNote(out.notes, indexNote(idx));
    } else if (i.op === 'rename') out.clauses.push(`RENAME INDEX ${q(i.oldName!)} TO ${q(i.name)}`);
    else if (i.op === 'modify') out.clauses.push(`ALTER INDEX ${q(i.name)} ${i.to!.invisible ? 'INVISIBLE' : 'VISIBLE'}`);
  }
  for (const c of d.checks) if (c.op === 'add' || c.op === 'modify') out.clauses.push(`ADD ${printCheck(c.to!, false)}`);
  out.clauses.push(...optionClauses(options));
  return out;
}

const pushNote = (notes: string[], note: string | undefined) => {
  if (note) notes.push(note);
};

// 테이블 콜레이션과 같은 COLLATE만 있는 컬럼은 상속한 값이다. COLLATE를 쓰면 명시 지정이 되어
// SHOW CREATE 출력이 'CHARACTER SET … COLLATE …'로 바뀌므로 빼고 출력한다
export function inheritCollation(c: Column, t: Table): Column {
  if (c.charset || c.collation === undefined) return c;
  return c.collation === t.options.find((o) => o.key === 'COLLATE')?.value ? { ...c, collation: undefined } : c;
}

function columnClauses(d: TableDiff, forced: ReadonlySet<string>, out: Collected): void {
  const to = d.to!;
  const changes = new Map(d.columns.map((c) => [c.name, c]));
  const moved = new Set(d.moved);
  const bases = baseColumns(d);
  to.columns.forEach((raw, idx) => {
    const ch = changes.get(raw.name);
    const isMoved = moved.has(raw.name);
    if (!isMoved && !forced.has(raw.name) && (!ch || ch.op === 'drop')) return;
    const col = fillColumn(raw, ch?.op === 'add' ? undefined : bases.get(raw.name));
    pushNote(out.notes, columnNote(col));
    if (hasUnknownGenerated(col)) out.missing.push(col.name);
    const pos = idx === 0 ? ' FIRST' : ` AFTER ${q(to.columns[idx - 1].name)}`;
    const def = printColumn(printable(inheritCollation(col, to)), false);
    if (ch?.op === 'add') out.clauses.push(`ADD COLUMN ${def}${idx === to.columns.length - 1 ? '' : pos}`);
    else if (ch?.op === 'rename' && !ch.fields.length && !isMoved && !forced.has(raw.name)) {
      out.clauses.push(`RENAME COLUMN ${q(ch.oldName!)} TO ${q(col.name)}`);
    } else if (ch?.op === 'rename') out.clauses.push(`CHANGE COLUMN ${q(ch.oldName!)} ${def}${isMoved ? pos : ''}`);
    else out.clauses.push(`MODIFY COLUMN ${def}${isMoved ? pos : ''}`);
  });
}

// 가시성만 바뀐 인덱스는 ALTER INDEX로 처리, 그 외 변경은 DROP 후 ADD
function rebuildsIndex(i: Change<Index>): boolean {
  if (i.op === 'rename') return i.fields.length > 0;
  if (i.op !== 'modify') return false;
  return !(i.fields.length === 1 && i.fields[0] === 'invisible' && i.to!.kind !== 'PRIMARY');
}

function dropIndex(name: string, kind: IndexKind): string {
  return kind === 'PRIMARY' ? 'DROP PRIMARY KEY' : `DROP INDEX ${q(name)}`;
}

function addIndex(i: Index): string {
  let s = `ADD ${ADD_KEYWORD[i.kind]}${i.kind === 'PRIMARY' ? '' : ` ${q(i.name)}`} ${printIndexParts(i.parts)}`;
  if (i.using) s += ` USING ${i.using}`;
  if (i.parser) s += ` WITH PARSER ${q(i.parser)}`;
  if (i.comment !== undefined) s += ` COMMENT ${quoteString(i.comment)}`;
  if (i.invisible) s += ' INVISIBLE';
  return s;
}

function optionClauses(changes: OptionChange[]): string[] {
  return changes.flatMap((o) => (o.to !== undefined ? [`${o.key}=${o.to}`] : OPTION_RESET[o.key] ? [OPTION_RESET[o.key]] : []));
}

function optionNotes(changes: OptionChange[]): string[] {
  return changes
    .filter((o) => o.to === undefined && !OPTION_RESET[o.key])
    .map((o) => `-- [수동 확인 필요] ${o.key} 옵션 제거: 기본값으로 되돌리는 구문이 없습니다`);
}
