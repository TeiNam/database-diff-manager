import { useEffect, useMemo } from 'react';
import { useVersion } from '../../api/hooks';
import type { DiffResponse } from '../../api/types';
import { useSchemaContext } from '../../hooks/useSchemaContext';
import { changedObjects, objectAnchor, objectEntry } from '../../lib/object-diff';
import { ObjectCard } from './ObjectCard';
import s from './ObjectCard.module.css';

// ponytail: 가상 스크롤 대신 51번째 카드부터 본문을 접어 렌더링 비용을 줄인다. 수천 개 객체가 흔해지면 가상화로 바꾼다
const EAGER_CARDS = 50;

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className={s.seg} role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? s.on : undefined} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

export function DiffTab({ data }: { data: DiffResponse }) {
  const ctx = useSchemaContext();
  const version = useVersion(data.target.id);
  const entries = useMemo(() => changedObjects(data.diff), [data.diff]);
  const resetKey = `${data.base.id}:${data.target.id}`;
  const selected = ctx.obj ? objectEntry(ctx.objKind, ctx.obj, data.baseModel, data.targetModel, data.diff) : undefined;
  const objectIds = new Map((version.data?.objects ?? []).map((o) => [`${o.kind}:${o.name}`, o.objectId]));
  const historyHref = (kind: string, name: string) => {
    const id = objectIds.get(`${kind}:${name}`);
    return id ? `/objects/${id}` : undefined;
  };

  useEffect(() => {
    if (ctx.obj) document.getElementById(objectAnchor(ctx.objKind, ctx.obj))?.scrollIntoView?.({ block: 'start' });
  }, [ctx.obj, ctx.objKind]);

  return (
    <section aria-label="객체 diff">
      <div className={s.toolbar}>
        <Segmented label="보기 방식" value={ctx.mode} options={[['sql', 'SQL'], ['grid', '표']]} onChange={(mode) => ctx.set({ mode: mode === 'sql' ? undefined : mode })} />
        {ctx.mode === 'sql' && <Segmented label="레이아웃" value={ctx.layout} options={[['split', 'Split'], ['unified', 'Unified']]} onChange={(layout) => ctx.set({ layout: layout === 'split' ? undefined : layout })} />}
        <span className={s.hint}>변경 객체 {entries.length}개</span>
      </div>
      {selected?.op === 'same' && (
        <ObjectCard key={selected.key} entry={selected} resetKey={resetKey} selected mode={ctx.mode} layout={ctx.layout} defaultOpen statements={[]} historyHref={historyHref(selected.kind, selected.name)} />
      )}
      {entries.length === 0 && <p className={s.empty}>두 버전 사이에 변경 사항이 없습니다</p>}
      {entries.map((entry, i) => (
        <ObjectCard key={entry.key} entry={entry} mode={ctx.mode} layout={ctx.layout} defaultOpen={i < EAGER_CARDS} selected={ctx.obj === entry.name && ctx.objKind === entry.kind} resetKey={resetKey}
          statements={data.statements} historyHref={historyHref(entry.kind, entry.name)} />
      ))}
    </section>
  );
}
