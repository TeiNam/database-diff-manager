import type { Change, Check, Column, ForeignKey, Index, Table, TableDiff, View } from '@tdm/core';
import { alignByKey } from '../../lib/align';
import type { ObjectEntry } from '../../lib/object-diff';
import s from './GridDiff.module.css';

type Status = 'same' | 'add' | 'del' | 'mod';

interface Section {
  title: string;
  headers: string[];
  pick: (t: Table) => unknown[];
  key: (x: unknown) => string;
  cells: (x: unknown) => string[];
  changes: (d: TableDiff) => Change<unknown>[];
}

const columnExtra = (c: Column) =>
  [
    c.autoIncrement ? 'auto_increment' : '',
    c.onUpdate ? `on update ${c.onUpdate}` : '',
    c.generated ? `GENERATED (${c.generated.expr}) ${c.generated.stored ? 'STORED' : 'VIRTUAL'}` : '',
    c.srid !== undefined ? `SRID ${c.srid}` : '',
    c.invisible ? 'INVISIBLE' : '',
  ].filter(Boolean).join(' ');

const indexType = (i: Index) =>
  [i.kind, i.using ? `USING ${i.using}` : '', i.parser ? `WITH PARSER ${i.parser}` : '', i.invisible ? 'INVISIBLE' : ''].filter(Boolean).join(' ');

const SECTIONS: Section[] = [
  { title: 'Columns', headers: ['Name', 'Type', 'Charset/Collation', 'Null', 'Default', 'Extra', 'Comment'], pick: (t) => t.columns, key: (c) => (c as Column).name,
    changes: (d) => d.columns,
    cells: (x) => { const c = x as Column; return [c.name, c.type, [c.charset, c.collation].filter(Boolean).join(' / '), c.nullable ? 'YES' : 'NO', c.default ?? '', columnExtra(c), c.comment ?? '']; } },
  { title: 'Index', headers: ['Name', 'Type', 'Columns', 'Details'], pick: (t) => t.indexes, key: (i) => (i as Index).name,
    changes: (d) => d.indexes,
    cells: (x) => { const i = x as Index; return [i.name, indexType(i), i.parts.map((p) => (p.expr ? `(${p.expr})` : `${p.column}${p.length ? `(${p.length})` : ''}`) + (p.desc ? ' DESC' : '')).join(', '), i.comment ?? '']; } },
  { title: 'Foreign keys', headers: ['Name', 'Columns', 'Reference', 'Actions'], pick: (t) => t.foreignKeys, key: (f) => (f as ForeignKey).name,
    changes: (d) => d.foreignKeys,
    cells: (x) => { const f = x as ForeignKey; return [f.name, f.columns.join(', '), `${f.refTable}(${f.refColumns.join(', ')})`, `ON DELETE ${f.onDelete ?? 'RESTRICT'} · ON UPDATE ${f.onUpdate ?? 'RESTRICT'}`]; } },
  { title: 'Checks', headers: ['Name', 'Expression'], pick: (t) => t.checks, key: (c) => (c as Check).name,
    changes: (d) => d.checks,
    cells: (x) => { const c = x as Check; return [c.name, c.expr + (c.enforced ? '' : ' NOT ENFORCED')]; } },
];

// 서술형 열만 줄바꿈하고, 식별자·타입 같은 열은 한 줄로 두어 글자 중간에서 끊기지 않게 한다
const WRAP_HEADERS = new Set(['Comment', 'Details', 'Expression']);

const asTable = (o?: Table | View) => (o?.kind === 'table' ? o : undefined);

interface GridRow {
  a?: string[];
  b?: string[];
  status: Status;
  moved: boolean;
}

// 한 섹션을 표 하나로 그린다: BASE 절반 | 간격 | TARGET 절반이 같은 <tr> 에 있어 행 높이가 항상 같다
function GridTable({ title, headers, rows }: { title: string; headers: string[]; rows: GridRow[] }) {
  const half = (cells: string[] | undefined, other: string[] | undefined, side: 'base' | 'target', row: GridRow) =>
    headers.map((_, k) => {
      const value = cells?.[k] ?? '';
      const changed = row.status === 'mod' && cells && other && other[k] !== value;
      const tone = !cells ? 'pad' : row.status === 'add' && side === 'target' ? 'add' : row.status === 'del' && side === 'base' ? 'del' : undefined;
      const className = [tone ? s[tone] : '', WRAP_HEADERS.has(headers[k]) ? s.wrapText : '', changed ? (side === 'base' ? 'cellDel' : 'cellAdd') : ''].filter(Boolean).join(' ') || undefined;
      return (
        <td key={`${side}${k}`} className={className} title={value || undefined}>
          {value}
          {k === 0 && side === 'target' && row.moved && <small className={s.moved}>위치 변경</small>}
        </td>
      );
    });
  return (
    <div className={s.scroll}>
    <table className={s.grid} aria-label={title}>
      <thead>
        <tr>
          <th scope="colgroup" colSpan={headers.length}>BASE</th>
          <th className={s.gap} aria-hidden="true" />
          <th scope="colgroup" colSpan={headers.length}>TARGET</th>
        </tr>
        <tr>
          {headers.map((h) => <th key={`a${h}`} scope="col">{h}</th>)}
          <th className={s.gap} aria-hidden="true" />
          {headers.map((h) => <th key={`b${h}`} scope="col">{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={s[r.status]}>
            {half(r.a, r.b, 'base', r)}
            <td className={s.gap} aria-hidden="true" />
            {half(r.b, r.a, 'target', r)}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

// 보이는 셀이 같아도 diff 가 변경으로 본 행(charset·위치 등 일부 속성)은 mod 로 표시한다
function rowStatus(a: string[] | undefined, b: string[] | undefined, flagged: boolean): Status {
  if (!a) return 'add';
  if (!b) return 'del';
  return flagged || a.join('\u0000') !== b.join('\u0000') ? 'mod' : 'same';
}

// 표 모드: 섹션마다 BASE 표 | TARGET 표를 좌우로 놓고 같은 행 높이를 맞춘다
export function GridDiff({ entry }: { entry: ObjectEntry }) {
  const from = asTable(entry.from);
  const to = asTable(entry.to);
  const renamed = new Map((entry.table?.columns ?? []).filter((c) => c.op === 'rename').map((c) => [c.name, c.oldName!]));
  const options = [...new Set([...(from?.options ?? []), ...(to?.options ?? [])].map((o) => o.key))];
  return (
    <div className={s.wrap}>
      {options.length > 0 && (
        <p className={s.options}>
          {options.map((key) => {
            const a = from?.options.find((o) => o.key === key)?.value;
            const b = to?.options.find((o) => o.key === key)?.value;
            return <span key={key} className={a !== b ? s.optChanged : undefined}>{key}={a === b ? b : `${a ?? '∅'} → ${b ?? '∅'}`}</span>;
          })}
        </p>
      )}
      {SECTIONS.map((sec) => {
        const aligned = alignByKey(from ? sec.pick(from) : [], to ? sec.pick(to) : [], sec.key, sec.title === 'Columns' ? renamed : undefined);
        if (aligned.length === 0) return null;
        const flaggedNames = new Set((entry.table ? sec.changes(entry.table) : []).filter((c) => c.op === 'modify' || c.op === 'rename').map((c) => c.name));
        const moved = new Set(sec.title === 'Columns' ? entry.table?.moved ?? [] : []);
        const rows: GridRow[] = aligned.map((r) => {
          const a = r.base === undefined ? undefined : sec.cells(r.base);
          const b = r.target === undefined ? undefined : sec.cells(r.target);
          const name = r.target === undefined ? undefined : sec.key(r.target);
          const isMoved = name !== undefined && moved.has(name);
          return { a, b, moved: isMoved, status: rowStatus(a, b, isMoved || (name !== undefined && flaggedNames.has(name))) };
        });
        return (
          <section key={sec.title} className={s.section}>
            <h4 className={s.title}>{sec.title}</h4>
            <GridTable title={sec.title} headers={sec.headers} rows={rows} />
          </section>
        );
      })}
    </div>
  );
}
