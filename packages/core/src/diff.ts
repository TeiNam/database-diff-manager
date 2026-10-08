// 두 스키마 모델의 차이 계산. unknown 목록의 속성은 비교하지 않고 skipped에 기록한다
import { canonicalJson } from './canonical';
import type { Check, Column, ForeignKey, Index, IndexField, Partitioning, SchemaModel, Table, View } from './model';
import { isOtherKindFamily } from './partial-fill';
import { subpartitionKey } from './partition-ddl';
import { printColumn, printTable, printView } from './print';
import { findIgnoredRenames, type IgnoredRename } from './rename-check';

export type Op = 'add' | 'drop' | 'modify' | 'rename';

export interface Change<T> {
  op: Op;
  name: string;
  oldName?: string;
  from?: T;
  to?: T;
  fields: string[];
}

export interface OptionChange {
  key: string;
  from?: string;
  to?: string;
}

export interface TableDiff {
  op: Op;
  name: string;
  oldName?: string;
  from?: Table;
  to?: Table;
  columns: Change<Column>[];
  moved: string[]; // 위치가 바뀐 컬럼 (TARGET 이름)
  indexes: Change<Index>[];
  foreignKeys: Change<ForeignKey>[];
  checks: Change<Check>[];
  options: OptionChange[];
  partition?: { from?: Partitioning; to?: Partitioning };
  skipped: string[]; // partial 출처라 비교하지 못한 속성 ('column.charset' 등)
  unparsed: boolean; // 파싱 실패 객체의 원문이 달라졌음
}

export interface ViewDiff {
  op: 'add' | 'drop' | 'modify';
  name: string;
  from?: View;
  to?: View;
  fields: string[];
}

export interface RenameMapping {
  kind: 'table' | 'column' | 'index';
  table?: string; // column/index: TARGET 테이블명
  from: string;
  to: string;
  // column 전용: 겹치는 같은 이름 컬럼이 따로 삭제·추가됨이 확인된 rename (전환 매핑의 remove-column·To-Be 신규 컬럼).
  // 이름이 겹쳐도 먼저 짝지어, 겹친 컬럼은 DROP·ADD 로 처리한다
  allowOverlap?: boolean;
}

export interface SchemaDiff {
  tables: TableDiff[];
  views: ViewDiff[];
  renameCandidates: RenameMapping[];
  ignoredRenames: IgnoredRename[]; // 적용하지 못한 rename 매핑과 이유
  partial: boolean;
}

const COLUMN_FIELDS = ['type', 'charset', 'collation', 'generated', 'nullable', 'srid', 'invisible', 'default', 'onUpdate', 'autoIncrement', 'comment'] as const;
const INDEX_FIELDS = ['kind', 'using', 'parser', 'comment', 'invisible'] as const;
const FK_FIELDS = ['columns', 'refSchema', 'refTable', 'refColumns', 'onDelete', 'onUpdate'] as const;
const CHECK_FIELDS = ['expr', 'enforced'] as const;
const VIEW_FIELDS = ['algorithm', 'security', 'checkOption', 'columnList', 'body'] as const;

type Equal = (field: string, a: unknown, b: unknown) => boolean;
const sameJson: Equal = (_, a, b) => canonicalJson(a) === canonicalJson(b);
// InnoDB에서 RESTRICT, NO ACTION, 미지정은 같은 동작이다
const fkAction = (v: unknown) => (v === undefined || v === 'RESTRICT' || v === 'NO ACTION' ? 'RESTRICT' : v);
const fkEqual: Equal = (f, a, b) => (f === 'onDelete' || f === 'onUpdate' ? fkAction(a) === fkAction(b) : sameJson(f, a, b));

export function diffSchemas(base: SchemaModel, target: SchemaModel, renames: RenameMapping[] = []): SchemaDiff {
  const tables = diffTables(base.tables, target.tables, renames);
  const all = [...base.tables, ...target.tables, ...base.views, ...target.views];
  return {
    tables,
    views: diffViews(base.views, target.views),
    renameCandidates: findRenameCandidates(tables),
    ignoredRenames: findIgnoredRenames(base, target, tables, renames),
    partial: all.some((o) => o.fidelity === 'partial'),
  };
}

function diffTables(base: Table[], target: Table[], renames: RenameMapping[]): TableDiff[] {
  const details = new Map<string, TableDiff>();
  const { changes } = matchByName(base, target, mappingOf(renames, 'table'), (b, t) => {
    const d = diffTable(b, t, renames);
    details.set(t.name, d);
    return hasChanges(d) ? ['definition'] : [];
  });
  return changes.map((c) => {
    if (c.op === 'drop') return emptyDiff('drop', c.name, c.from, undefined);
    if (c.op === 'add') return emptyDiff('add', c.name, undefined, c.to);
    return { ...details.get(c.name)!, op: c.op, oldName: c.oldName };
  });
}

export function diffTable(b: Table, t: Table, renames: RenameMapping[] = []): TableDiff {
  const base = emptyDiff('modify', t.name, b, t);
  if (b.parseError || t.parseError) return { ...base, unparsed: printTable(b) !== printTable(t) };
  const skipped = new Set<string>();
  const columns = matchByName(b.columns, t.columns, mappingOf(renames, 'column', t.name), (x, y) =>
    fieldDiff(x, y, COLUMN_FIELDS, skipped, 'column.'), overlapOf(renames, t.name),
  );
  const baseOrder = columns.pairs.map(([, y]) => y.name);
  const targetOrder = t.columns.map((c) => c.name).filter((n) => baseOrder.includes(n));
  const keep = lcs(baseOrder, targetOrder);
  // RENAME/CHANGE COLUMN은 인덱스·FK의 컬럼 참조를 자동 갱신하므로, 적용된 rename을 BASE 사본에 반영해 비교한다
  const applied = new Map(columns.changes.filter((c) => c.op === 'rename').map((c) => [c.oldName!, c.name]));
  const renameCol = (n: string) => applied.get(n) ?? n;
  const indexes = matchByName(b.indexes, t.indexes, mappingOf(renames, 'index', t.name), (x, y) =>
    indexFields({ ...x, parts: x.parts.map((p) => (p.column === undefined ? p : { ...p, column: renameCol(p.column) })) }, y, skipped),
  );
  const foreignKeys = matchByName(b.foreignKeys, t.foreignKeys, new Map(), (x, y) =>
    fieldDiff({ ...x, columns: x.columns.map(renameCol) }, y, FK_FIELDS, skipped, 'fk.', fkEqual),
  );
  return {
    ...base,
    columns: columns.changes,
    moved: targetOrder.filter((n) => !keep.has(n)),
    indexes: indexes.changes,
    foreignKeys: foreignKeys.changes,
    checks: checkChanges(b, t, skipped),
    options: optionChanges(b, t, skipped),
    partition: partitionChange(b, t, skipped),
    skipped: [...skipped].sort(),
  };
}

function emptyDiff(op: Op, name: string, from: Table | undefined, to: Table | undefined): TableDiff {
  return { op, name, from, to, columns: [], moved: [], indexes: [], foreignKeys: [], checks: [], options: [], skipped: [], unparsed: false };
}

function hasChanges(d: TableDiff): boolean {
  return d.unparsed || d.columns.length > 0 || d.moved.length > 0 || d.indexes.length > 0 || d.foreignKeys.length > 0
    || d.checks.length > 0 || d.options.length > 0 || d.partition !== undefined;
}

// 같은 원본의 매핑이 여러 개면 처음 것만 쓴다 (나머지는 ignoredRenames에 '중복 매핑')
function mappingOf(renames: RenameMapping[], kind: RenameMapping['kind'], table?: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of renames) if (r.kind === kind && (table === undefined || r.table === table) && !out.has(r.from)) out.set(r.from, r.to);
  return out;
}

// 이름 겹침을 허용한 컬럼 rename 의 원본 이름 (TARGET 테이블 기준)
function overlapOf(renames: RenameMapping[], table: string): Set<string> {
  return new Set(renames.filter((r) => r.kind === 'column' && r.table === table && r.allowOverlap).map((r) => r.from));
}

// 이름으로 짝을 맞춘다. rename 매핑을 먼저 짝짓고 나머지를 같은 이름끼리 맞춘다.
// rename 은 BASE에 새 이름이 없고 TARGET에 옛 이름이 없으며(겹침 허용 매핑은 예외) 같은 대상이 아직 짝지어지지 않았을 때만 적용한다
function matchByName<T extends { name: string }>(
  base: T[], target: T[], renames: Map<string, string>, fields: (a: T, b: T) => string[], overlap: ReadonlySet<string> = new Set(),
): { changes: Change<T>[]; pairs: [T, T][] } {
  const baseNames = new Set(base.map((x) => x.name));
  const targetByName = new Map(target.map((x) => [x.name, x]));
  const consumed = new Set<string>();
  const renamedTo = new Map<T, string>();
  for (const b of base) {
    const renamed = renames.get(b.name);
    if (renamed === undefined || !targetByName.has(renamed) || consumed.has(renamed)) continue;
    if (!overlap.has(b.name) && (baseNames.has(renamed) || targetByName.has(b.name))) continue;
    consumed.add(renamed);
    renamedTo.set(b, renamed);
  }
  const renameTargets = new Set(consumed);
  const changes: Change<T>[] = [];
  const pairs: [T, T][] = [];
  for (const b of base) {
    const renamed = renamedTo.get(b);
    const useRename = renamed !== undefined;
    const t = useRename ? targetByName.get(renamed) : renameTargets.has(b.name) ? undefined : targetByName.get(b.name);
    if (!t) {
      changes.push({ op: 'drop', name: b.name, from: b, fields: [] });
      continue;
    }
    consumed.add(t.name);
    pairs.push([b, t]);
    const f = fields(b, t);
    if (useRename) changes.push({ op: 'rename', name: t.name, oldName: b.name, from: b, to: t, fields: f });
    else if (f.length) changes.push({ op: 'modify', name: t.name, from: b, to: t, fields: f });
  }
  for (const t of target) if (!consumed.has(t.name)) changes.push({ op: 'add', name: t.name, to: t, fields: [] });
  return { changes, pairs };
}

function fieldDiff<T extends object>(
  a: T, b: T, fields: readonly (keyof T & string)[], skipped: Set<string>, prefix: string, eq: Equal = sameJson,
): string[] {
  const unknownOf = (x: T) => (x as { unknown?: readonly string[] }).unknown ?? [];
  return fields.filter((f) => {
    if (unknownOf(a).includes(f) || unknownOf(b).includes(f)) {
      skipped.add(prefix + f);
      return false;
    }
    return !eq(f, a[f], b[f]);
  });
}

function indexFields(a: Index, b: Index, skipped: Set<string>): string[] {
  const has = (f: IndexField) => Boolean(a.unknown?.includes(f) || b.unknown?.includes(f));
  const known = fieldDiff(a, b, INDEX_FIELDS, skipped, 'index.');
  // 종류 미상(Normal)이어도 계열이 다르면(INDEX/UNIQUE ↔ FULLTEXT/SPATIAL) 종류 차이로 본다
  const fields = has('kind') && isOtherKindFamily(a, b) ? ['kind', ...known] : known;
  if (has('partDetails')) skipped.add('index.partDetails');
  if (has('partOrder')) skipped.add('index.partOrder');
  const key = (i: Index): string => {
    if (!has('partDetails') && !has('partOrder')) return canonicalJson(i.parts);
    const names = i.parts.map((p) => p.column ?? p.expr ?? '');
    return canonicalJson(has('partOrder') ? [...names].sort() : names);
  };
  return key(a) === key(b) ? fields : [...fields, 'parts'];
}

function checkChanges(a: Table, b: Table, skipped: Set<string>): Change<Check>[] {
  if (a.unknown?.includes('checks') || b.unknown?.includes('checks')) {
    skipped.add('checks');
    return [];
  }
  return matchByName(a.checks, b.checks, new Map(), (x, y) => fieldDiff(x, y, CHECK_FIELDS, skipped, 'check.')).changes;
}

function optionChanges(a: Table, b: Table, skipped: Set<string>): OptionChange[] {
  const limit = a.comparableOptions && b.comparableOptions
    ? a.comparableOptions.filter((k) => b.comparableOptions!.includes(k))
    : (a.comparableOptions ?? b.comparableOptions);
  if (limit) skipped.add('options');
  const value = (t: Table, key: string) => t.options.find((o) => o.key === key)?.value;
  const keys = [...new Set([...a.options, ...b.options].map((o) => o.key))].filter((k) => !limit || limit.includes(k));
  return keys.flatMap((key) => {
    const from = value(a, key);
    const to = value(b, key);
    return from === to ? [] : [{ key, from, to }];
  });
}

function partitionChange(a: Table, b: Table, skipped: Set<string>): TableDiff['partition'] {
  if (a.unknown?.includes('partition') || b.unknown?.includes('partition')) {
    skipped.add('partition');
    return undefined;
  }
  const key = (p?: Partitioning) =>
    (p ? canonicalJson({ method: p.method, expr: p.expr, count: p.count, sub: subpartitionKey(p), partitions: p.partitions }) : '');
  return key(a.partition) === key(b.partition) ? undefined : { from: a.partition, to: b.partition };
}

function diffViews(base: View[], target: View[]): ViewDiff[] {
  const { changes } = matchByName(base, target, new Map(), (a, b) => {
    if (a.parseError || b.parseError) return printView(a) === printView(b) ? [] : ['body'];
    return fieldDiff(a, b, VIEW_FIELDS, new Set(), 'view.');
  });
  return changes.map((c) => ({ op: c.op as ViewDiff['op'], name: c.name, from: c.from, to: c.to, fields: c.fields }));
}

// 이름만 다른 drop/add 쌍을 rename 후보로 제시한다 (자동 적용하지 않음)
function findRenameCandidates(tables: TableDiff[]): RenameMapping[] {
  const out: RenameMapping[] = [];
  const tableSig = (t: Table) => t.columns.map((c) => printColumn(c, false)).join('\n');
  // 파싱 실패 테이블은 컬럼 구성을 알 수 없으므로 후보에서 뺀다
  const dropped = tables.filter((t) => t.op === 'drop' && !t.from?.parseError).map((t) => ({ op: 'drop' as const, name: t.name, from: t.from, fields: [] }));
  const added = tables.filter((t) => t.op === 'add' && !t.to?.parseError).map((t) => ({ op: 'add' as const, name: t.name, to: t.to, fields: [] }));
  pairCandidates<Table>([...dropped, ...added], tableSig, (from, to) => out.push({ kind: 'table', from, to }));
  for (const t of tables) {
    if (t.op !== 'modify' && t.op !== 'rename') continue;
    pairCandidates<Column>(t.columns, (c) => printColumn({ ...c, name: '' }, false), (from, to) => out.push({ kind: 'column', table: t.name, from, to }));
    const indexes = t.indexes.filter((i) => (i.from ?? i.to)!.kind !== 'PRIMARY');
    pairCandidates<Index>(indexes, (i) => canonicalJson({ ...i, name: '' }), (from, to) => out.push({ kind: 'index', table: t.name, from, to }));
  }
  return out;
}

function pairCandidates<T>(changes: Change<T>[], sig: (x: T) => string, emit: (from: string, to: string) => void): void {
  const adds = changes.filter((c) => c.op === 'add');
  const used = new Set<string>();
  for (const d of changes.filter((c) => c.op === 'drop')) {
    const match = adds.find((a) => !used.has(a.name) && sig(a.to!) === sig(d.from!));
    if (!match) continue;
    used.add(match.name);
    emit(d.name, match.name);
  }
}

export function lcs(a: string[], b: string[]): Set<string> {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.add(a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}
