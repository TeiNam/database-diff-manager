import { useEffect, useRef, useState } from 'react';
import { useDiff, useTree, useVersions } from '../api/hooks';
import type { VersionMeta, VersionSummary } from '../api/types';
import { Icon } from '../components/Icon';
import { useSchemaContext } from '../hooks/useSchemaContext';
import { formatDate } from '../lib/format';
import s from './Topbar.module.css';

const OTHER = 'other';
const label = (v: VersionSummary) => `v${v.versionNo} · ${formatDate(v.uploadedAt)} · ${v.uploadedBy}${v.note ? ` · ${v.note}` : ''}`;
// 이 Schema 목록에 없는 버전: diff 응답의 base/target 메타로 "legacy v3 · 2026-09-30", 아직 모르면 id 로 표시한다
const otherLabel = (id: number, metas: (VersionMeta | undefined)[]) => {
  const meta = metas.find((m) => m?.id === id);
  return meta ? `${meta.schemaName} v${meta.versionNo} · ${formatDate(meta.uploadedAt)}` : `다른 스키마의 버전 #${id}`;
};

// BASE/TARGET 버전 선택. BASE는 "다른 Database/Schema와 비교…"로 다른 스키마의 버전도 고를 수 있다
export function VersionPicker({ schemaId }: { schemaId: number }) {
  const ctx = useSchemaContext();
  const versions = useVersions(schemaId);
  const diff = useDiff(ctx.base, ctx.target); // 페이지와 같은 쿼리라 추가 요청은 없다
  const metas = [diff.data?.base, diff.data?.target];
  const [otherOpen, setOtherOpen] = useState(false);
  const baseRef = useRef<HTMLSelectElement>(null);
  const closeOther = () => {
    setOtherOpen(false);
    baseRef.current?.focus();
  };
  if (!versions.data?.length) return null;
  const known = new Set(versions.data.map((v) => v.id));
  return (
    <div className={s.picker}>
      <label>
        <span className={s.tag}>BASE</span>
        <select ref={baseRef} className={s.select} aria-label="BASE 버전" value={ctx.base ?? ''}
          onChange={(e) => (e.target.value === OTHER ? setOtherOpen(true) : ctx.set({ base: e.target.value }))}>
          {ctx.base === undefined && <option value="" disabled>버전 선택…</option>}
          {ctx.base && !known.has(ctx.base) && <option value={ctx.base}>{otherLabel(ctx.base, metas)}</option>}
          {versions.data.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}
          <option value={OTHER}>다른 Database/Schema와 비교…</option>
        </select>
      </label>
      <button type="button" className={s.iconBtn} aria-label="BASE와 TARGET 바꾸기" title="방향 바꾸기"
        onClick={() => ctx.set({ base: ctx.target, target: ctx.base })}>
        <Icon name="swap" />
      </button>
      <label>
        <span className={s.tag}>TARGET</span>
        <select className={s.select} aria-label="TARGET 버전" value={ctx.target ?? ''} onChange={(e) => ctx.set({ target: e.target.value })}>
          {ctx.target === undefined && <option value="" disabled>버전 선택…</option>}
          {ctx.target && !known.has(ctx.target) && <option value={ctx.target}>{otherLabel(ctx.target, metas)}</option>}
          {versions.data.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}
        </select>
      </label>
      {otherOpen && <OtherVersionDialog onPick={(id) => { ctx.set({ base: id }); closeOther(); }} onClose={closeOther} />}
    </div>
  );
}

function OtherVersionDialog({ onPick, onClose }: { onPick: (versionId: number) => void; onClose: () => void }) {
  const tree = useTree();
  const [schemaId, setSchemaId] = useState<number>();
  const versions = useVersions(schemaId);
  const firstRef = useRef<HTMLSelectElement>(null);
  useEffect(() => firstRef.current?.focus(), []);
  return (
    <dialog open className={s.dialog} aria-label="다른 스키마의 버전 선택" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <label>Schema
        <select ref={firstRef} className={s.select} value={schemaId ?? ''} onChange={(e) => setSchemaId(Number(e.target.value) || undefined)}>
          <option value="">선택…</option>
          {tree.data?.flatMap((d) => d.schemas.map((sc) => <option key={sc.id} value={sc.id}>{d.name} › {sc.name}</option>))}
        </select>
      </label>
      <label>버전
        <select className={s.select} disabled={!versions.data} defaultValue="" onChange={(e) => e.target.value && onPick(Number(e.target.value))}>
          <option value="">선택…</option>
          {versions.data?.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}
        </select>
      </label>
      <button type="button" className={s.btn} onClick={onClose}>닫기</button>
    </dialog>
  );
}
