// DMS 전환 매핑 + As-Is/To-Be 모델 → 전환 표(테이블·컬럼 대응과 상태)와 diff 용 rename 매핑
import type { RenameMapping } from './diff';
import { compileSelection, type DmsColumnRename, type DmsMapping, type DmsRemovedColumn, type DmsTableRename } from './dms-mapping';
import type { Column, SchemaModel, Table } from './model';

export type TableFlowStatus = 'ok' | 'missing-target' | 'missing-source' | 'excluded' | 'unmapped-target';
export type ColumnFlowStatus = 'renamed' | 'same' | 'removed' | 'added' | 'dropped' | 'missing';

export interface ColumnFlow {
  asIs?: string;
  toBe?: string;
  asIsType?: string;
  toBeType?: string;
  status: ColumnFlowStatus;
}

export interface TableFlow {
  asIs?: string;
  toBe?: string;
  status: TableFlowStatus;
  renamed: boolean; // 테이블 rename 룰이 적용됨
  columns: ColumnFlow[];
}

export interface MigrationFlowTotals {
  tables: Record<TableFlowStatus, number>;
  columns: Record<ColumnFlowStatus, number>;
  inScope: number; // 전환 대상 테이블 (ok + missing-target + missing-source)
  verified: number; // ok 이면서 컬럼 missing 이 없는 테이블
}

export interface MigrationFlow {
  fromSchema: string;
  toSchema?: string;
  tables: TableFlow[];
  totals: MigrationFlowTotals;
}

const TABLE_STATUSES: TableFlowStatus[] = ['ok', 'missing-target', 'missing-source', 'excluded', 'unmapped-target'];
const COLUMN_STATUSES: ColumnFlowStatus[] = ['renamed', 'same', 'removed', 'added', 'dropped', 'missing'];

type Resolve<T> = (name: string) => T | undefined;

// 정확히 같은 이름을 먼저, 없으면 대소문자를 무시해 O(1) 로 찾는다 (같은 이름이 여럿이면 앞의 것)
function nameIndex<T extends { name: string }>(items: readonly T[]): Resolve<T> {
  const exact = new Map<string, T>();
  const folded = new Map<string, T>();
  for (const x of items) {
    if (!exact.has(x.name)) exact.set(x.name, x);
    const key = x.name.toLowerCase();
    if (!folded.has(key)) folded.set(key, x);
  }
  return (name) => exact.get(name) ?? folded.get(name.toLowerCase());
}

// 룰을 해석된 대상 객체별로 묶는다 (룰 순서 유지, 대상이 없는 룰은 빠진다)
function groupBy<R, K>(rules: readonly R[], keyOf: (r: R) => K | undefined): Map<K, R[]> {
  const out = new Map<K, R[]>();
  for (const r of rules) {
    const key = keyOf(r);
    if (key === undefined) continue;
    const group = out.get(key);
    // 이 함수 안에서 막 만든 배열이라 push 해도 밖에 드러나지 않는다 (한 테이블에 룰이 몰려도 O(R))
    if (group) group.push(r);
    else out.set(key, [r]);
  }
  return out;
}

// 한 번 만든 이름 해석·룰 묶음. 룰마다 테이블 목록을 다시 훑지 않도록 O(T+R) 로 만든다
interface FlowIndex {
  base: Resolve<Table>;
  target: Resolve<Table>;
  tableRule: Map<Table, DmsTableRename>;
  columnRules: Map<Table, DmsColumnRename[]>;
  removedRules: Map<Table, DmsRemovedColumn[]>;
  isSelected: (table: string) => boolean;
}

function flowIndex(base: SchemaModel, target: SchemaModel, mapping: DmsMapping): FlowIndex {
  const resolveBase = nameIndex(base.tables);
  const tableRule = new Map<Table, DmsTableRename>();
  for (const [t, rules] of groupBy(mapping.tables, (r) => resolveBase(r.from))) tableRule.set(t, rules[0]);
  return {
    base: resolveBase,
    target: nameIndex(target.tables),
    tableRule,
    columnRules: groupBy(mapping.columns, (r) => resolveBase(r.table)),
    removedRules: groupBy(mapping.removedColumns, (r) => resolveBase(r.table)),
    isSelected: compileSelection(mapping),
  };
}

export function buildMigrationFlow(base: SchemaModel, target: SchemaModel, mapping: DmsMapping): MigrationFlow {
  const consumed = new Set<Table>();
  const index = flowIndex(base, target, mapping);
  const rows: TableFlow[] = base.tables.map((asIs) => tableRow(asIs, index, consumed));
  rows.push(...missingSourceRows(index, mapping, consumed));
  for (const t of target.tables) {
    if (!consumed.has(t)) rows.push({ toBe: t.name, status: 'unmapped-target', renamed: false, columns: [] });
  }
  return { fromSchema: mapping.fromSchema, ...(mapping.toSchema ? { toSchema: mapping.toSchema } : {}), tables: rows, totals: totalsOf(rows) };
}

// 전환 표에서 짝이 맞은(ok) 테이블과 그 안의 짝이 맞은 컬럼만 모은다. 표기가 같아도 넘긴다 (호출 쪽이 거른다)
interface PairedTable {
  asIs: string;
  toBe: string;
  columns: Array<{ asIs: string; toBe: string }>;
}

const pairedTables = (flow: MigrationFlow): PairedTable[] =>
  flow.tables.filter((row) => row.status === 'ok').map((row) => ({
    asIs: row.asIs!,
    toBe: row.toBe!,
    columns: row.columns.filter((c) => c.status === 'renamed' || c.status === 'same').map((c) => ({ asIs: c.asIs!, toBe: c.toBe! })),
  }));

export type RenameDirection = 'forward' | 'reverse';

// 전환 표 → diff 용 rename 매핑. 이름은 모델의 실제 표기로 맞춘다.
// forward(BASE = As-Is): As-Is → To-Be, 컬럼 매핑의 table 은 TARGET 인 To-Be 테이블명.
// reverse(BASE = To-Be): To-Be → As-Is 로 뒤집고, 컬럼 매핑의 table 은 TARGET 인 As-Is 테이블명.
// remove-column 은 역방향에선 ADD COLUMN 이 되므로 따로 넘기지 않고 diff 에 맡긴다.
// 전환 표는 대소문자를 무시해 같다고 보지만 diffSchemas 는 구분하므로, 표기만 달라도 rename 으로 넘겨 DROP+ADD 를 막는다
export function flowRenameMappings(flow: MigrationFlow, direction: RenameDirection = 'forward'): RenameMapping[] {
  const isReverse = direction === 'reverse';
  return pairedTables(flow).flatMap((t) => {
    const [from, to] = isReverse ? [t.toBe, t.asIs] : [t.asIs, t.toBe];
    const columns = t.columns.filter((c) => c.asIs !== c.toBe)
      .map((c) => ({ kind: 'column' as const, table: to, from: isReverse ? c.toBe : c.asIs, to: isReverse ? c.asIs : c.toBe }));
    return from !== to ? [{ kind: 'table' as const, from, to }, ...columns] : columns;
  });
}

export const toRenameMappings = (mapping: DmsMapping, base: SchemaModel, target: SchemaModel): RenameMapping[] =>
  flowRenameMappings(buildMigrationFlow(base, target, mapping), 'forward');

// 역방향 비교(BASE = To-Be 모델, TARGET = As-Is 모델)용. 인자는 정방향과 같은 순서(As-Is, To-Be)로 받는다
export const toReverseRenameMappings = (mapping: DmsMapping, asIs: SchemaModel, toBe: SchemaModel): RenameMapping[] =>
  flowRenameMappings(buildMigrationFlow(asIs, toBe, mapping), 'reverse');

function tableRow(asIs: Table, index: FlowIndex, consumed: Set<Table>): TableFlow {
  if (!index.isSelected(asIs.name)) return { asIs: asIs.name, status: 'excluded', renamed: false, columns: [] };
  const rule = index.tableRule.get(asIs);
  const toBe = index.target(rule?.to ?? asIs.name);
  if (!toBe) return { asIs: asIs.name, toBe: rule?.to, status: 'missing-target', renamed: false, columns: [] };
  consumed.add(toBe);
  const columns = columnRows(asIs, toBe, index.columnRules.get(asIs) ?? [], index.removedRules.get(asIs) ?? []);
  return { asIs: asIs.name, toBe: toBe.name, status: 'ok', renamed: rule !== undefined, columns };
}

// 룰이 가리키는 As-Is 테이블이 모델에 없으면 missing-source 로 드러낸다 (와일드카드 selection 은 제외)
function missingSourceRows(index: FlowIndex, mapping: DmsMapping, consumed: Set<Table>): TableFlow[] {
  const names = [
    ...mapping.selection.include.filter((p) => !p.includes('%')),
    ...mapping.tables.map((r) => r.from),
    ...mapping.columns.map((r) => r.table),
    ...mapping.removedColumns.map((r) => r.table),
  ];
  const renameTo = new Map<string, string>();
  for (const r of mapping.tables) if (!renameTo.has(r.from.toLowerCase())) renameTo.set(r.from.toLowerCase(), r.to);
  const seen = new Set<string>();
  const rows: TableFlow[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key) || index.base(name)) continue;
    seen.add(key);
    const toBeName = renameTo.get(key) ?? name;
    const toBe = index.target(toBeName);
    if (toBe) consumed.add(toBe);
    rows.push({ asIs: name, toBe: toBe?.name ?? toBeName, status: 'missing-source', renamed: false, columns: [] });
  }
  return rows;
}

function columnRows(asIs: Table, toBe: Table, renames: DmsColumnRename[], removed: DmsRemovedColumn[]): ColumnFlow[] {
  const resolveAsIs = nameIndex(asIs.columns);
  const resolveToBe = nameIndex(toBe.columns);
  const renameOf = groupBy(renames, (r) => resolveAsIs(r.from));
  const removedSet = new Set(removed.map((r) => resolveAsIs(r.column)));
  const used = new Set<Column>();
  const rows: ColumnFlow[] = asIs.columns.map((c) => {
    if (removedSet.has(c)) return { asIs: c.name, asIsType: c.type, status: 'removed' };
    const rule = renameOf.get(c)?.[0];
    const match = resolveToBe(rule?.to ?? c.name);
    if (!match) return rule ? { asIs: c.name, toBe: rule.to, asIsType: c.type, status: 'missing' } : { asIs: c.name, asIsType: c.type, status: 'dropped' };
    used.add(match);
    const status = rule && match.name !== c.name ? 'renamed' : 'same';
    return { asIs: c.name, toBe: match.name, asIsType: c.type, toBeType: match.type, status };
  });
  for (const r of renames) if (!resolveAsIs(r.from)) rows.push({ asIs: r.from, toBe: r.to, status: 'missing' });
  for (const r of removed) if (!resolveAsIs(r.column)) rows.push({ asIs: r.column, status: 'missing' });
  for (const c of toBe.columns) if (!used.has(c)) rows.push({ toBe: c.name, toBeType: c.type, status: 'added' });
  return rows;
}

function totalsOf(rows: TableFlow[]): MigrationFlowTotals {
  const tables = Object.fromEntries(TABLE_STATUSES.map((s) => [s, 0])) as Record<TableFlowStatus, number>;
  const columns = Object.fromEntries(COLUMN_STATUSES.map((s) => [s, 0])) as Record<ColumnFlowStatus, number>;
  let verified = 0;
  for (const row of rows) {
    tables[row.status] += 1;
    for (const c of row.columns) columns[c.status] += 1;
    if (row.status === 'ok' && !row.columns.some((c) => c.status === 'missing')) verified += 1;
  }
  return { tables, columns, inScope: tables.ok + tables['missing-target'] + tables['missing-source'], verified };
}
