import { printTable, printView, type Op, type SchemaDiff, type SchemaModel, type Table, type TableDiff, type View, type ViewDiff } from '@tdm/core';

export interface ObjectEntry {
  key: string;
  kind: 'table' | 'view';
  name: string;
  oldName?: string;
  op: Op | 'same';
  baseText: string;
  targetText: string;
  table?: TableDiff;
  view?: ViewDiff;
  from?: Table | View;
  to?: Table | View;
}

const print = (obj?: Table | View) => (!obj ? '' : obj.kind === 'table' ? printTable(obj) : printView(obj));

export const objectAnchor = (kind: 'table' | 'view', name: string) => `obj-${kind}-${encodeURIComponent(name)}`;

const fromTable = (d: TableDiff): ObjectEntry => ({
  key: `table:${d.name}`, kind: 'table', name: d.name, oldName: d.oldName, op: d.op,
  baseText: print(d.from), targetText: print(d.to), table: d, from: d.from, to: d.to,
});

const fromView = (d: ViewDiff): ObjectEntry => ({
  key: `view:${d.name}`, kind: 'view', name: d.name, op: d.op,
  baseText: print(d.from), targetText: print(d.to), view: d, from: d.from, to: d.to,
});

// 변경 객체 목록 (core diff 순서: 테이블 → 뷰)
export function changedObjects(diff: SchemaDiff): ObjectEntry[] {
  return [...diff.tables.map(fromTable), ...diff.views.map(fromView)];
}

export function opOf(diff: SchemaDiff, kind: 'table' | 'view', name: string): Op | undefined {
  const list = kind === 'table' ? diff.tables : diff.views;
  return list.find((d) => d.name === name || (kind === 'table' && (d as TableDiff).oldName === name && d.op === 'rename'))?.op;
}

// 변경 여부와 관계없이 한 객체를 보여 줄 때 (트리에서 변경 없는 객체를 선택한 경우)
export function objectEntry(kind: 'table' | 'view', name: string, base: SchemaModel, target: SchemaModel, diff: SchemaDiff): ObjectEntry | undefined {
  const changed = changedObjects(diff).find((e) => e.kind === kind && e.name === name);
  if (changed) return changed;
  const pick = (m: SchemaModel) => (kind === 'table' ? m.tables : m.views).find((o: Table | View) => o.name === name);
  const from = pick(base);
  const to = pick(target);
  if (!from && !to) return undefined;
  return { key: `${kind}:${name}`, kind, name, op: 'same', baseText: print(from), targetText: print(to ?? from), from, to: to ?? from };
}
