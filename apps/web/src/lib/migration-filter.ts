// 전환 표의 필터·검색 (순수 함수)
import type { ColumnFlowStatus, TableFlow } from '@tdm/core';

export type FlowFilter = 'all' | 'renamed' | 'removed' | 'problem' | 'new';

export const FLOW_FILTERS: [FlowFilter, string][] = [
  ['all', '전체'], ['renamed', '이름변경'], ['removed', '컬럼삭제'], ['problem', '문제'], ['new', '신규'],
];

const hasColumn = (t: TableFlow, statuses: ColumnFlowStatus[]) => t.columns.some((c) => statuses.includes(c.status));

function matchesFilter(t: TableFlow, filter: FlowFilter): boolean {
  if (filter === 'renamed') return t.renamed || hasColumn(t, ['renamed']);
  if (filter === 'removed') return hasColumn(t, ['removed']);
  if (filter === 'problem') return t.status === 'missing-target' || t.status === 'missing-source' || hasColumn(t, ['missing', 'dropped']);
  if (filter === 'new') return t.status === 'unmapped-target' || hasColumn(t, ['added']);
  return true;
}

function matchesQuery(t: TableFlow, query: string): boolean {
  if (!query) return true;
  const names = [t.asIs, t.toBe, ...t.columns.flatMap((c) => [c.asIs, c.toBe])];
  return names.some((n) => n !== undefined && n.toLowerCase().includes(query));
}

export function filterFlowTables(tables: readonly TableFlow[], filter: FlowFilter, query: string): TableFlow[] {
  const q = query.trim().toLowerCase();
  return tables.filter((t) => matchesFilter(t, filter) && matchesQuery(t, q));
}
