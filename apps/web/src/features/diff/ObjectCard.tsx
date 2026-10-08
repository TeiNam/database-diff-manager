import type { Statement } from '@tdm/core';
import { renderDdl } from '@tdm/core';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { DiffResponse } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Mark } from '../../components/Mark';
import { copyText } from '../../lib/clipboard';
import { buildRows, countChanges } from '../../lib/hunks';
import { objectAnchor, type ObjectEntry } from '../../lib/object-diff';
import { GridDiff } from './GridDiff';
import s from './ObjectCard.module.css';
import { SqlDiff } from './SqlDiff';

const LONG_OBJECT_LINES = 300;
const BAR_SLOTS = 5;
const COPY_FEEDBACK_MS = 2000;

type CopyState = 'idle' | 'done' | 'failed' | 'stale';
const COPY_LABEL: Record<CopyState, string> = { idle: 'DDL 복사', done: '복사됨', failed: '복사 실패', stale: 'DDL이 바뀜' };

// 복사 직전에 받은 최신 diff 에 이 객체의 문장이 없으면 옛 내용을 복사하지 않는다
class StaleObjectError extends Error {}

const ownStatements = (statements: Statement[], entry: ObjectEntry) => statements.filter((st) => st.kind === entry.kind && st.object === entry.name);

function ChangeBar({ added, removed }: { added: number; removed: number }) {
  const total = added + removed || 1;
  const adds = Math.round((added / total) * BAR_SLOTS);
  return (
    <span className={s.bar} aria-hidden="true">
      {Array.from({ length: BAR_SLOTS }, (_, i) => <i key={i} className={i < adds ? s.barAdd : added + removed ? s.barDel : undefined} />)}
    </span>
  );
}

// refresh: 복사 직전에 최신 diff 를 다시 받는다 (다른 사용자가 매핑·rename 을 바꿨을 수 있다)
export function ObjectCard({ entry, mode, layout, defaultOpen, selected = false, resetKey, statements, refresh, historyHref }: {
  entry: ObjectEntry; mode: 'sql' | 'grid'; layout: 'split' | 'unified'; defaultOpen: boolean; selected?: boolean; resetKey?: string; statements: Statement[];
  refresh: () => Promise<DiffResponse>; historyHref?: string;
}) {
  const rows = useMemo(() => buildRows(entry.baseText, entry.targetText), [entry.baseText, entry.targetText]);
  const counts = useMemo(() => countChanges(rows), [rows]);
  const long = Math.max(entry.baseText.split('\n').length, entry.targetText.split('\n').length) > LONG_OBJECT_LINES;
  const [open, setOpen] = useState(selected || (defaultOpen && !long));
  const [copy, setCopy] = useState<CopyState>('idle');
  // 처음 렌더 뒤에 선택된 카드(트리 클릭)도 길이와 상관없이 펼친다
  useEffect(() => {
    if (selected) setOpen(true);
  }, [selected]);
  useEffect(() => {
    if (copy === 'idle') return;
    const timer = setTimeout(() => setCopy('idle'), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copy]);
  const own = ownStatements(statements, entry);
  const copyFresh = () => {
    const text = refresh().then((fresh) => {
      const latest = ownStatements(fresh.statements, entry);
      if (!latest.length) throw new StaleObjectError();
      return renderDdl(latest);
    });
    copyText(text).then(() => setCopy('done'), (e: unknown) => setCopy(e instanceof StaleObjectError ? 'stale' : 'failed'));
  };
  const label = `${entry.kind} ${entry.name}`;
  return (
    <section className={s.card} id={objectAnchor(entry.kind, entry.name)} aria-label={label}>
      <header className={s.head}>
        <button type="button" className={s.toggle} aria-expanded={open} aria-label={`${label} 본문`} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} />
        </button>
        <Mark op={entry.op} />
        <Icon name={entry.kind} />
        <span className={`${s.path} ${entry.op === 'drop' ? 'struck' : ''}`}>{entry.oldName && entry.op === 'rename' ? `${entry.oldName} → ${entry.name}` : entry.name}</span>
        {entry.op === 'same' ? <span className={s.same}>변경 없음</span> : (
          <>
            <span className={s.numAdd}>+{counts.added}</span>
            <span className={s.numDel}>−{counts.removed}</span>
            <ChangeBar added={counts.added} removed={counts.removed} />
          </>
        )}
        <span className={s.spacer} />
        {historyHref && <Link className={s.btn} to={historyHref}>이력</Link>}
        {own.length > 0 && (
          <button type="button" className={s.btn} onClick={copyFresh}>
            <Icon name="copy" />{COPY_LABEL[copy]}
          </button>
        )}
      </header>
      {open && (mode === 'grid' && entry.kind === 'table'
        ? <GridDiff entry={entry} />
        : <SqlDiff key={resetKey} rows={rows} base={entry.baseText} target={entry.targetText} layout={entry.op === 'same' ? 'unified' : layout} expanded={entry.op === 'same'} />)}
    </section>
  );
}
