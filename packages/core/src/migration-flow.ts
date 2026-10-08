// DMS 전환 매핑 + As-Is/To-Be 모델 → 전환 표(테이블·컬럼 대응과 상태)와 diff 용 rename 매핑
import type { RenameMapping } from './diff';
import { compileSelection, type DmsMapping } from './dms-mapping';
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
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// 정확히 같은 이름을 먼저, 없으면 대소문자를 무시하고 찾는다
export function findByName<T extends { name: string }>(items: readonly T[], name: string): T | undefined {
  return items.find((x) => x.name === name) ?? items.find((x) => eq(x.name, name));
}

export function buildMigrationFlow(base: SchemaModel, target: SchemaModel, mapping: DmsMapping): MigrationFlow {
  const consumed = new Set<Table>();
  const isSelected = compileSelection(mapping);
  const rows: TableFlow[] = base.tables.map((asIs) => tableRow(asIs, base, target, mapping, isSelected, consumed));
  rows.push(...missingSourceRows(base, target, mapping, consumed));
  for (const t of target.tables) {
    if (!consumed.has(t)) rows.push({ toBe: t.name, status: 'unmapped-target', renamed: false, columns: [] });
  }
  return { fromSchema: mapping.fromSchema, ...(mapping.toSchema ? { toSchema: mapping.toSchema } : {}), tables: rows, totals: totalsOf(rows) };
}

// diff 에 넘길 rename 매핑. 이름은 모델의 실제 표기로 맞추고, 컬럼 매핑의 table 은 To-Be 테이블명이다
export function toRenameMappings(mapping: DmsMapping, base: SchemaModel, target: SchemaModel): RenameMapping[] {
  const out: RenameMapping[] = [];
  for (const row of buildMigrationFlow(base, target, mapping).tables) {
    if (row.status !== 'ok') continue;
    if (row.renamed && row.asIs !== row.toBe) out.push({ kind: 'table', from: row.asIs!, to: row.toBe! });
    for (const c of row.columns) {
      if (c.status === 'renamed') out.push({ kind: 'column', table: row.toBe!, from: c.asIs!, to: c.toBe! });
    }
  }
  return out;
}

// 룰의 As-Is 이름이 이 객체를 가리키는지 (정확히 같은 이름 우선)
const pointsTo = <T extends { name: string }>(items: readonly T[], ruleName: string, item: T) => findByName(items, ruleName) === item;

function tableRow(asIs: Table, base: SchemaModel, target: SchemaModel, mapping: DmsMapping, isSelected: (table: string) => boolean, consumed: Set<Table>): TableFlow {
  if (!isSelected(asIs.name)) return { asIs: asIs.name, status: 'excluded', renamed: false, columns: [] };
  const rule = mapping.tables.find((r) => pointsTo(base.tables, r.from, asIs));
  const toBe = findByName(target.tables, rule?.to ?? asIs.name);
  if (!toBe) return { asIs: asIs.name, toBe: rule?.to, status: 'missing-target', renamed: false, columns: [] };
  consumed.add(toBe);
  return { asIs: asIs.name, toBe: toBe.name, status: 'ok', renamed: rule !== undefined, columns: columnRows(asIs, toBe, base, mapping) };
}

// 룰이 가리키는 As-Is 테이블이 모델에 없으면 missing-source 로 드러낸다 (와일드카드 selection 은 제외)
function missingSourceRows(base: SchemaModel, target: SchemaModel, mapping: DmsMapping, consumed: Set<Table>): TableFlow[] {
  const names = [
    ...mapping.selection.include.filter((p) => !p.includes('%')),
    ...mapping.tables.map((r) => r.from),
    ...mapping.columns.map((r) => r.table),
    ...mapping.removedColumns.map((r) => r.table),
  ];
  const seen = new Set<string>();
  const rows: TableFlow[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key) || findByName(base.tables, name)) continue;
    seen.add(key);
    const toBeName = mapping.tables.find((r) => eq(r.from, name))?.to ?? name;
    const toBe = findByName(target.tables, toBeName);
    if (toBe) consumed.add(toBe);
    rows.push({ asIs: name, toBe: toBe?.name ?? toBeName, status: 'missing-source', renamed: false, columns: [] });
  }
  return rows;
}

function columnRows(asIs: Table, toBe: Table, base: SchemaModel, mapping: DmsMapping): ColumnFlow[] {
  const renames = mapping.columns.filter((r) => pointsTo(base.tables, r.table, asIs));
  const removed = mapping.removedColumns.filter((r) => pointsTo(base.tables, r.table, asIs));
  const used = new Set<Column>();
  const rows: ColumnFlow[] = asIs.columns.map((c) => {
    if (removed.some((r) => pointsTo(asIs.columns, r.column, c))) return { asIs: c.name, asIsType: c.type, status: 'removed' };
    const rule = renames.find((r) => pointsTo(asIs.columns, r.from, c));
    const match = findByName(toBe.columns, rule?.to ?? c.name);
    if (!match) return rule ? { asIs: c.name, toBe: rule.to, asIsType: c.type, status: 'missing' } : { asIs: c.name, asIsType: c.type, status: 'dropped' };
    used.add(match);
    const status = rule && match.name !== c.name ? 'renamed' : 'same';
    return { asIs: c.name, toBe: match.name, asIsType: c.type, toBeType: match.type, status };
  });
  for (const r of renames) if (!findByName(asIs.columns, r.from)) rows.push({ asIs: r.from, toBe: r.to, status: 'missing' });
  for (const r of removed) if (!findByName(asIs.columns, r.column)) rows.push({ asIs: r.column, status: 'missing' });
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
