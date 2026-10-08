import type { ColumnFlowStatus, MigrationFlow, TableFlow } from '@tdm/core';
import { Fragment, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { FLOW_FILTERS, filterFlowTables, type FlowFilter } from '../../lib/migration-filter';
import { handleRadioKeys } from '../../lib/radio-group';
import { StatusBadge, statusLabel } from './StatusBadge';
import s from './migration.module.css';

const SUMMARY_ORDER: ColumnFlowStatus[] = ['renamed', 'removed', 'added', 'dropped', 'missing'];
const rowKey = (t: TableFlow) => `${t.status}:${t.asIs ?? ''}>${t.toBe ?? ''}`;
const tableName = (t: TableFlow) => t.asIs ?? t.toBe ?? '';

function Name({ value }: { value?: string }) {
  return value ? <span className={s.name}>{value}</span> : <span className={s.dim}>—</span>;
}

// 컬럼 행이 있는 테이블만 펼칠 수 있다. 없으면(제외·To-Be 전용 등) 화살표 없이 이름만 보여 준다
function TableCell({ table, isOpen, onToggle }: { table: TableFlow; isOpen: boolean; onToggle: () => void }) {
  if (table.columns.length === 0) return <span className={s.plain}><Name value={table.asIs} /></span>;
  return (
    <button type="button" className={s.expand} aria-expanded={isOpen} aria-label={`${tableName(table)} 컬럼 ${isOpen ? '접기' : '펼치기'}`} onClick={onToggle}>
      <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} />{tableName(table)}
    </button>
  );
}

// "이름변경 3 · 컬럼삭제 1" (동일 컬럼은 세지 않는다)
function columnSummary(t: TableFlow): string {
  if (t.columns.length === 0) return '';
  const parts = SUMMARY_ORDER
    .map((status) => [status, t.columns.filter((c) => c.status === status).length] as const)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${statusLabel(status)} ${n}`);
  return parts.join(' · ') || '변경 없음';
}

function ColumnTable({ table }: { table: TableFlow }) {
  return (
    <table className={s.inner} aria-label={`${tableName(table)} 컬럼 매핑`}>
      <thead><tr><th>As-Is 컬럼</th><th>타입</th><th>To-Be 컬럼</th><th>타입</th><th>상태</th></tr></thead>
      <tbody>
        {table.columns.map((c, i) => (
          <tr key={`${c.asIs ?? ''}>${c.toBe ?? ''}:${i}`}>
            <td><Name value={c.asIs} /></td>
            <td><Name value={c.asIsType} /></td>
            <td><Name value={c.toBe} /></td>
            <td><Name value={c.toBeType} /></td>
            <td><StatusBadge status={c.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const FILTER_IDS = FLOW_FILTERS.map(([id]) => id);

function Toolbar({ filter, query, shown, total, onFilter, onQuery }: {
  filter: FlowFilter; query: string; shown: number; total: number; onFilter: (f: FlowFilter) => void; onQuery: (q: string) => void;
}) {
  return (
    <div className={s.toolbar}>
      <input type="search" className={s.search} placeholder="As-Is·To-Be 테이블·컬럼 검색" aria-label="전환 표 검색"
        value={query} onChange={(e) => onQuery(e.target.value)} />
      <div className={s.seg} role="radiogroup" aria-label="전환 표 필터" onKeyDown={(e) => handleRadioKeys(e, FILTER_IDS, filter, onFilter)}>
        {FLOW_FILTERS.map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={filter === id} tabIndex={filter === id ? 0 : -1}
            className={filter === id ? s.on : undefined} onClick={() => onFilter(id)}>{label}</button>
        ))}
      </div>
      <span className={s.meta} role="status">{shown} / {total} 테이블</span>
    </div>
  );
}

export function MigrationTable({ flow }: { flow: MigrationFlow }) {
  const [filter, setFilter] = useState<FlowFilter>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => filterFlowTables(flow.tables, filter, query), [flow.tables, filter, query]);
  const toggle = (key: string) => setOpen((prev) => new Set(prev.has(key) ? [...prev].filter((k) => k !== key) : [...prev, key]));
  return (
    <>
      <Toolbar filter={filter} query={query} shown={rows.length} total={flow.tables.length} onFilter={setFilter} onQuery={setQuery} />
      {rows.length === 0 ? <p className={s.emptyText}>조건에 맞는 테이블이 없습니다</p> : (
        <table className={s.table} aria-label="전환 표">
          <thead><tr><th>As-Is 테이블</th><th>To-Be 테이블</th><th>상태</th><th>컬럼</th></tr></thead>
          <tbody>
            {rows.map((t) => {
              const key = rowKey(t);
              const isOpen = open.has(key);
              return (
                <Fragment key={key}>
                  <tr>
                    <td><TableCell table={t} isOpen={isOpen} onToggle={() => toggle(key)} /></td>
                    <td><Name value={t.toBe} /></td>
                    <td><StatusBadge status={t.status} /></td>
                    <td className={s.meta}>{columnSummary(t)}</td>
                  </tr>
                  {isOpen && <tr className={s.columns}><td colSpan={4}><ColumnTable table={t} /></td></tr>}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
