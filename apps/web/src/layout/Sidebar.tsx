import type { Op, SchemaModel } from '@tdm/core';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { useDiff, useTree } from '../api/hooks';
import type { DiffResponse, TreeDatabase } from '../api/types';
import { Icon, type IconName } from '../components/Icon';
import { Mark } from '../components/Mark';
import { useSchemaContext, type ObjectKind } from '../hooks/useSchemaContext';
import { objectsOf, opOf } from '../lib/object-diff';
import s from './Sidebar.module.css';

interface Node {
  id: string;
  label: string;
  depth: number;
  icon?: IconName;
  mark?: Op;
  meta?: string;
  struck?: boolean;
  selected?: boolean;
  expanded?: boolean;
  parentId?: string;
  note?: boolean; // 선택할 수 없는 안내 줄
  onSelect: () => void;
}

type Filter = 'all' | 'changed';

// 트리 그룹: Tables, Views, Routines(함수·프로시저)
const GROUPS: { id: string; label: string; kinds: ObjectKind[] }[] = [
  { id: 'table', label: 'Tables', kinds: ['table'] },
  { id: 'view', label: 'Views', kinds: ['view'] },
  { id: 'routine', label: 'Routines', kinds: ['function', 'procedure'] },
];
const ROUTINES_UNKNOWN = 'MD 출처라 루틴은 비교하지 않음';

// 루틴은 이름 대소문자를 구분하지 않으므로 TARGET 표기를 우선해 한 번만 보여 준다
function objectNames(data: DiffResponse, kind: ObjectKind): string[] {
  const all = [...objectsOf(data.targetModel, kind), ...objectsOf(data.baseModel, kind)].map((o) => o.name);
  if (kind === 'table' || kind === 'view') return [...new Set(all)];
  const byKey = new Map<string, string>();
  for (const name of all) if (!byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  return [...byKey.values()];
}

function objectNodes(data: DiffResponse, kind: ObjectKind, parentId: string, query: string, filter: Filter, selected: string | undefined, select: (name: string) => void): Node[] {
  return objectNames(data, kind).sort().flatMap((name) => {
    const op = opOf(data.diff, kind, name);
    const renamedAway = kind === 'table' && data.diff.tables.some((t) => t.op === 'rename' && t.oldName === name);
    if (renamedAway) return [];
    if (filter === 'changed' && !op) return [];
    if (query && !name.toLowerCase().includes(query.toLowerCase())) return [];
    return [{ id: `${kind}:${name}`, label: name, depth: 3, icon: kind, mark: op, struck: op === 'drop', selected: selected === name, parentId, onSelect: () => select(name) }];
  });
}

function buildNodes(tree: TreeDatabase[], ctx: Pick<ReturnType<typeof useSchemaContext>, 'schemaId' | 'obj' | 'objKind' | 'set'>, data: DiffResponse | undefined, ui: { collapsed: Set<string>; query: string; filter: Filter }, navigate: (to: string) => void): Node[] {
  const out: Node[] = [];
  for (const d of tree) {
    const dbId = `db:${d.id}`;
    const dbOpen = !ui.collapsed.has(dbId);
    out.push({ id: dbId, label: d.name, depth: 0, icon: 'database', expanded: dbOpen, onSelect: () => undefined });
    if (!dbOpen) continue;
    for (const sc of d.schemas) {
      const scId = `schema:${sc.id}`;
      const current = ctx.schemaId === sc.id;
      // 펼침은 현재 보고 있는 스키마만 가능하다(객체 목록이 그 스키마의 diff 에서 나오므로)
      const scOpen = current && !ui.collapsed.has(scId);
      out.push({ id: scId, label: sc.name, depth: 1, icon: 'schema', meta: sc.latestVersion ? `v${sc.latestVersion.versionNo}` : '—', selected: current && !ctx.obj, expanded: scOpen, parentId: dbId,
        // 이미 보고 있는 스키마면 base/target 을 유지한 채 객체 선택만 해제한다
        onSelect: () => (current ? ctx.set({ obj: undefined, kind: undefined }) : navigate(`/db/${d.id}/schema/${sc.id}`)) });
      if (!scOpen || !data) continue;
      for (const group of GROUPS) out.push(...groupNodes(data, group, scId, ctx, ui));
    }
  }
  return out;
}

// 그룹 노드와 그 아래 객체 노드. 루틴이 없는 스키마에는 Routines 그룹을 두지 않는다
function groupNodes(data: DiffResponse, group: (typeof GROUPS)[number], scId: string, ctx: Pick<ReturnType<typeof useSchemaContext>, 'obj' | 'objKind' | 'set'>, ui: { collapsed: Set<string>; query: string; filter: Filter }): Node[] {
  const groupId = `${scId}:${group.id}`;
  const open = !ui.collapsed.has(groupId);
  const isRoutines = group.id === 'routine';
  const unknown = isRoutines && Boolean(data.diff.routinesUnknown);
  const count = (m: SchemaModel) => group.kinds.reduce((n, k) => n + objectsOf(m, k).length, 0);
  const total = count(data.targetModel);
  if (isRoutines && !unknown && total + count(data.baseModel) === 0) return [];
  const changed = isRoutines ? (data.diff.routines ?? []).length : (group.id === 'table' ? data.diff.tables : data.diff.views).length;
  const head: Node = { id: groupId, label: group.label, depth: 2, meta: unknown ? '비교 안 함' : `${changed} / ${total}`, expanded: open, parentId: scId, onSelect: () => undefined };
  if (!open) return [head];
  if (unknown) return [head, { id: `${groupId}:unknown`, label: ROUTINES_UNKNOWN, depth: 3, note: true, parentId: groupId, onSelect: () => undefined }];
  const children = group.kinds.flatMap((kind) =>
    objectNodes(data, kind, groupId, ui.query, ui.filter, ctx.objKind === kind ? ctx.obj : undefined, (name) => ctx.set({ tab: 'diff', obj: name, kind })));
  return [head, ...children];
}

export function Sidebar() {
  const ctx = useSchemaContext();
  const tree = useTree();
  const diff = useDiff(ctx.base, ctx.target);
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [focus, setFocus] = useState(0);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  // ctx 객체는 렌더마다 새로 만들어지므로 실제로 쓰는 원시값·안정된 set 만 의존성으로 둔다
  const { schemaId, obj, objKind, set } = ctx;
  const nodes = useMemo(() => buildNodes(tree.data ?? [], { schemaId, obj, objKind, set }, diff.data, { collapsed, query, filter }, navigate),
    [tree.data, schemaId, obj, objKind, set, diff.data, collapsed, query, filter, navigate]);

  useEffect(() => setFocus((f) => Math.min(f, Math.max(nodes.length - 1, 0))), [nodes.length]);

  const toggle = (id: string, open: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });

  const moveTo = (i: number) => {
    setFocus(i);
    refs.current[i]?.focus();
  };

  // 현재 스키마는 접고 펼 수 있고, 다른 스키마는 이동하면서 펼친다
  const isCurrentSchema = (node: Node) => node.depth === 1 && node.id === `schema:${schemaId}`;

  // 클릭과 같은 동작: Database·그룹·현재 스키마는 접고 펴며, 다른 스키마·객체는 선택한다
  // 현재 스키마에 선택된 객체가 있으면 선택 해제만 한다 (접지 않는다)
  const activate = (node: Node) => {
    if (isCurrentSchema(node) && obj) {
      node.onSelect();
      return;
    }
    if (node.depth === 1 && !isCurrentSchema(node)) toggle(node.id, true);
    else if (node.expanded !== undefined) toggle(node.id, !node.expanded);
    node.onSelect();
  };

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const node = nodes[i];
    if (e.key === 'ArrowDown') moveTo(Math.min(i + 1, nodes.length - 1));
    else if (e.key === 'ArrowUp') moveTo(Math.max(i - 1, 0));
    else if (e.key === 'ArrowRight' && node.depth === 1 && !isCurrentSchema(node)) activate(node);
    else if (e.key === 'ArrowRight' && node.expanded === false) toggle(node.id, true);
    else if (e.key === 'ArrowRight' && node.expanded) moveTo(Math.min(i + 1, nodes.length - 1));
    else if (e.key === 'ArrowLeft' && node.expanded) toggle(node.id, false);
    else if (e.key === 'ArrowLeft' && node.parentId) moveTo(nodes.findIndex((n) => n.id === node.parentId));
    else if (e.key === 'Enter' || e.key === ' ') activate(node);
    else return;
    e.preventDefault();
  };

  return (
    <aside className={s.side}>
      <div className={s.head}>
        <label className={s.search}>
          <Icon name="search" />
          <input type="search" aria-label="객체 검색" placeholder="객체 검색…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className={s.seg} role="radiogroup" aria-label="표시 범위">
          {(['all', 'changed'] as const).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={filter === f} className={filter === f ? s.on : undefined} onClick={() => setFilter(f)}>
              {f === 'all' ? '전체' : `변경 ${diff.data ? diff.data.diff.tables.length + diff.data.diff.views.length + (diff.data.diff.routines ?? []).length : ''}`}
            </button>
          ))}
        </div>
      </div>
      {tree.error ? <p className={s.empty} role="alert">{tree.error.message}</p> : tree.isPending ? <p className={s.empty} role="status">불러오는 중…</p> : (
      <div className={s.tree} role="tree" aria-label="스키마 트리">
        {nodes.map((n, i) => (
          <div key={n.id} ref={(el) => { refs.current[i] = el; }} role="treeitem" aria-level={n.depth + 1} aria-selected={n.selected ?? false}
            aria-expanded={n.expanded} tabIndex={i === focus ? 0 : -1} className={`${s.node} ${n.selected ? s.sel : ''}`}
            style={{ paddingLeft: 10 + n.depth * 16 }}
            onClick={() => { setFocus(i); activate(n); }}
            onKeyDown={(e) => onKeyDown(e, i)}>
            {n.expanded !== undefined ? <span className={s.chev}><Icon name={n.expanded ? 'chevronDown' : 'chevronRight'} /></span> : <span className={s.chev} />}
            {n.depth === 3 && !n.note && <Mark op={n.mark ?? 'same'} />}
            {n.icon && <Icon name={n.icon} />}
            <span className={`${s.name} ${n.depth === 3 && !n.note ? s.mono : ''} ${n.note ? s.note : ''} ${n.struck ? 'struck' : ''}`}>{n.label}</span>
            {n.meta && <span className={s.meta}>{n.meta}</span>}
          </div>
        ))}
        {tree.data?.length === 0 && <p className={s.empty}>아직 Database가 없습니다</p>}
      </div>
      )}
    </aside>
  );
}
