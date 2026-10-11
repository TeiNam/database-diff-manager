// 변경 테이블 하나의 ALTER TABLE 문장들 (스펙 4.6의 5·6단계)
import { baseColumns, charsetOptions, charsetPlan, type CharsetPlan } from './charset-ddl';
import type { Change, OptionChange, TableDiff } from './diff';
import { quoteIdent as q, quoteString, tokenize } from './lexer';
import type { Column, Index, IndexKind, Table } from './model';
import { columnNote, fillColumn, fillIndex, generatedReason, hasUnknownGenerated, indexNote, printable } from './partial-fill';
import { partitionBodies, partitionRedefinition } from './partition-ddl';
import { printCheck, printColumn, printIndexParts } from './print';

// 문장 본문: sql은 ';' 없음(delimited 제외). comment=true면 '-- ' 주석 줄로만 이루어진다
export interface StatementBody {
  sql: string;
  comment: boolean;
  notes?: string[];
  delimited?: boolean; // sql 이 스스로 문장 끝(DELIMITER … ;;)을 갖고 있어 ';' 를 덧붙이지 않는다 (루틴 CREATE)
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
  storage: string[]; // VIRTUAL↔STORED 가 바뀐 생성 컬럼 (MySQL 은 MODIFY 로 바꿀 수 없다: error 3106)
  virtual: string[]; // 일반 ↔ VIRTUAL 생성 컬럼으로 바뀐 컬럼 (error 3106. 일반 ↔ STORED 는 MODIFY 로 된다 — 8.0/8.4 실측)
}

const storageReason = (table: string, storage: string[], virtual: string[]): string => {
  const kinds = [...(storage.length ? [`(${storage.map(q).join(', ')})의 VIRTUAL↔STORED`] : []), ...(virtual.length ? [`(${virtual.map(q).join(', ')})의 일반↔VIRTUAL`] : [])];
  return `${table}: 생성 컬럼${kinds.join(', ')} 변경은 MODIFY 로 할 수 없습니다. 컬럼을 삭제한 뒤 다시 추가하세요`;
};

// MODIFY 로 바꿀 수 없는 생성 방식 변경: VIRTUAL↔STORED, 일반↔VIRTUAL
const storageOf = (c: Column) => (c.generated ? (c.generated.stored ? 'STORED' : 'VIRTUAL') : 'NONE');

export function alterStatements(d: TableDiff): StatementBody[] {
  if (d.unparsed) return [commentBody(`-- [수동 확인 필요] ${d.name}: 파싱할 수 없는 DDL이 변경되었습니다. 원문을 비교하세요`)];
  const plan = charsetPlan(d);
  const options = charsetOptions(d.options, plan);
  const main = alterClauses(d, options, plan?.columns ?? new Set());
  return alterBodies(d, plan, options, main);
}

// 본 ALTER 가 수동 확인 문장이 되는지 (파싱 실패, 생성식 미상, VIRTUAL↔STORED·일반↔VIRTUAL). 그 ALTER 가 만들 컬럼·인덱스를
// 다른 테이블의 FK·뷰가 쓸 수 있으므로 ddl-guard 가 전파 시드로 쓴다
export function isAlterBlocked(d: TableDiff): boolean {
  if (d.unparsed) return true;
  const plan = charsetPlan(d);
  const main = alterClauses(d, charsetOptions(d.options, plan), plan?.columns ?? new Set());
  return main.clauses.length > 0 && main.missing.length + main.storage.length + main.virtual.length > 0;
}

function alterBodies(d: TableDiff, plan: CharsetPlan | undefined, options: OptionChange[], main: Collected): StatementBody[] {
  const blocked = [...main.missing, ...main.storage, ...main.virtual];
  const out: StatementBody[] = plan?.convert ? [convertBody(d.name, plan.convert, plan.notes, blocked)] : [];
  // 파티션 함수가 쓰는 컬럼을 rename·삭제하면 파티션 재정의를 같은 ALTER 에 넣어야 한다 (따로 실행하면 error 3855)
  const keyColumns = main.clauses.length ? partitionKeyChanges(d) : [];
  const redefinition = keyColumns.length ? partitionRedefinition(d) : undefined;
  if (main.clauses.length) {
    const sql = alter(d.name, main.clauses) + (redefinition ? `\n  ${redefinition}` : '');
    const notes = [...(plan && !plan.convert ? plan.notes : []), ...(redefinition ? [partitionKeyNote(keyColumns)] : []), ...main.notes];
    const reason = main.missing.length ? generatedReason(d.name, main.missing) : main.storage.length || main.virtual.length ? storageReason(d.name, main.storage, main.virtual) : undefined;
    out.push(reason ? manualBody(reason, sql, notes) : sqlBody(sql, notes));
  }
  out.push(...optionNotes(options).map(commentBody));
  if (redefinition) return out;
  for (const p of partitionBodies(d)) out.push(p.sql.startsWith('--') ? commentBody(p.sql) : sqlBody(p.sql, p.notes));
  return out;
}

const partitionKeyNote = (columns: string[]): string =>
  `파티션 함수가 쓰는 컬럼(${columns.join(', ')})을 바꾸므로 파티션 재정의를 같은 ALTER 에 넣습니다 (따로 실행하면 error 3855)`;

// BASE 파티션 식이 쓰는 컬럼 중 rename·삭제되는 컬럼 (BASE 이름). RANGE COLUMNS(d) 처럼 따옴표 없는 이름도 본다
function partitionKeyChanges(d: TableDiff): string[] {
  const expr = d.partition?.from?.expr;
  if (expr === undefined) return [];
  const used = new Set(tokenize(expr).filter((t) => t.t === 'ident' || t.t === 'word').map((t) => t.v.toLowerCase()));
  const changed = d.columns.flatMap((c) => (c.op === 'rename' ? [c.oldName!] : c.op === 'drop' ? [c.name] : []));
  return changed.filter((n) => used.has(n.toLowerCase()));
}

// 본 ALTER가 수동 확인 문장이면 앞선 CONVERT TO도 실행하지 않도록 함께 수동 확인으로 돌린다
function convertBody(table: string, sql: string, notes: string[], missing: string[]): StatementBody {
  if (!missing.length) return sqlBody(sql, notes);
  return manualBody(`${table}: 이어지는 ALTER가 수동 확인 문장이므로 함께 확인한 뒤 실행하세요`, sql, notes);
}

// 절 순서: 삭제(CHECK·인덱스·컬럼) → 컬럼 추가·변경(TARGET 순서) → 인덱스 추가·rename·가시성 → CHECK 추가 → 옵션
function alterClauses(d: TableDiff, options: OptionChange[], forced: CharsetPlan['columns']): Collected {
  const out: Collected = { clauses: [], notes: [], missing: [], storage: [], virtual: [] };
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
  // 삭제는 앞에서 DROP 으로 처리했다. 같은 이름으로 들어오는 rename(x→y, 기존 y 삭제)을 덮지 않도록 뺀다
  const changes = new Map(d.columns.filter((c) => c.op !== 'drop').map((c) => [c.name, c]));
  const moved = new Set(d.moved);
  const bases = baseColumns(d);
  to.columns.forEach((raw, idx) => {
    const ch = changes.get(raw.name);
    const isMoved = moved.has(raw.name);
    if (!isMoved && !forced.has(raw.name) && (!ch || ch.op === 'drop')) return;
    const col = fillColumn(raw, ch?.op === 'add' ? undefined : bases.get(raw.name));
    pushNote(out.notes, columnNote(col));
    if (hasUnknownGenerated(col)) out.missing.push(col.name);
    const before = ch?.op === 'add' ? undefined : bases.get(raw.name);
    const kinds = before ? [storageOf(before), storageOf(col)] : [];
    if (kinds.includes('VIRTUAL') && kinds.includes('STORED')) out.storage.push(col.name);
    else if (kinds.includes('VIRTUAL') && kinds.includes('NONE')) out.virtual.push(col.name);
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
