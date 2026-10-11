import { printRoutine, printTable, routineNameKey, printView, type Op, type Routine, type RoutineDiff, type SchemaDiff, type SchemaModel, type Table, type TableDiff, type View, type ViewDiff } from '@tdm/core';
import type { ObjectKind } from '../hooks/useSchemaContext';

export type DiffObject = Table | View | Routine;

export interface ObjectEntry {
  key: string;
  kind: ObjectKind;
  name: string;
  oldName?: string;
  op: Op | 'same';
  baseText: string;
  targetText: string;
  table?: TableDiff;
  view?: ViewDiff;
  routine?: RoutineDiff;
  from?: DiffObject;
  to?: DiffObject;
}

export const isRoutineKind = (kind: ObjectKind): kind is Routine['kind'] => kind === 'function' || kind === 'procedure';

const print = (obj?: DiffObject) => {
  if (!obj) return '';
  if (obj.kind === 'table') return printTable(obj);
  return obj.kind === 'view' ? printView(obj) : printRoutine(obj);
};

export const objectAnchor = (kind: ObjectKind, name: string) => `obj-${kind}-${encodeURIComponent(name)}`;

const fromTable = (d: TableDiff): ObjectEntry => ({
  key: `table:${d.name}`, kind: 'table', name: d.name, oldName: d.oldName, op: d.op,
  baseText: print(d.from), targetText: print(d.to), table: d, from: d.from, to: d.to,
});

const fromView = (d: ViewDiff): ObjectEntry => ({
  key: `view:${d.name}`, kind: 'view', name: d.name, op: d.op,
  baseText: print(d.from), targetText: print(d.to), view: d, from: d.from, to: d.to,
});

const fromRoutine = (d: RoutineDiff): ObjectEntry => ({
  key: `${d.kind}:${d.name}`, kind: d.kind, name: d.name, op: d.op,
  baseText: print(d.from), targetText: print(d.to), routine: d, from: d.from, to: d.to,
});

// MySQL 루틴 이름은 대소문자를 구분하지 않는다
const sameRoutineName = (a: string, b: string) => routineNameKey(a) === routineNameKey(b);

// 변경 객체 목록 (core diff 순서: 테이블 → 뷰 → 루틴). 옛 응답에 routines 가 없으면 빈 목록
export function changedObjects(diff: SchemaDiff): ObjectEntry[] {
  return [...diff.tables.map(fromTable), ...diff.views.map(fromView), ...(diff.routines ?? []).map(fromRoutine)];
}

// 변경 객체 수 (테이블·뷰·루틴). 요약 탭 배지와 사이드바 [변경] 이 같은 값을 쓴다
export const changeCount = (diff: SchemaDiff): number => diff.tables.length + diff.views.length + (diff.routines ?? []).length;

export function opOf(diff: SchemaDiff, kind: ObjectKind, name: string): Op | undefined {
  if (isRoutineKind(kind)) return (diff.routines ?? []).find((d) => d.kind === kind && sameRoutineName(d.name, name))?.op;
  const list = kind === 'table' ? diff.tables : diff.views;
  return list.find((d) => d.name === name || (kind === 'table' && (d as TableDiff).oldName === name && d.op === 'rename'))?.op;
}

// 모델에서 한 종류의 객체 목록
export function objectsOf(model: SchemaModel, kind: ObjectKind): DiffObject[] {
  if (kind === 'table') return model.tables;
  if (kind === 'view') return model.views;
  return (model.routines ?? []).filter((r) => r.kind === kind);
}

// 변경 여부와 관계없이 한 객체를 보여 줄 때 (트리에서 변경 없는 객체를 선택한 경우)
export function objectEntry(kind: ObjectKind, name: string, base: SchemaModel, target: SchemaModel, diff: SchemaDiff): ObjectEntry | undefined {
  const matches = (n: string) => (isRoutineKind(kind) ? sameRoutineName(n, name) : n === name);
  const changed = changedObjects(diff).find((e) => e.kind === kind && matches(e.name));
  if (changed) return changed;
  const pick = (m: SchemaModel) => objectsOf(m, kind).find((o) => matches(o.name));
  const from = pick(base);
  const to = pick(target);
  if (!from && !to) return undefined;
  return { key: `${kind}:${name}`, kind, name, op: 'same', baseText: print(from), targetText: print(to ?? from), from, to: to ?? from };
}
