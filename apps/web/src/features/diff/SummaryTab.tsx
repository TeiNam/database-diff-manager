import type { RoutineDiff, TableDiff } from '@tdm/core';
import type { DiffResponse } from '../../api/types';
import { Mark } from '../../components/Mark';
import type { ObjectKind } from '../../hooks/useSchemaContext';
import { changedObjects, type ObjectEntry } from '../../lib/object-diff';
import s from './diff.module.css';

function detail(t?: TableDiff): string {
  if (!t) return '정의 변경';
  if (t.op === 'add') return '신규';
  if (t.op === 'drop') return '삭제';
  const parts = [
    t.op === 'rename' ? `이름 ${t.oldName} → ${t.name}` : '',
    t.columns.length ? `col ${t.columns.length}` : '',
    t.moved.length ? `순서 ${t.moved.length}` : '',
    t.indexes.length ? `idx ${t.indexes.length}` : '',
    t.foreignKeys.length ? `fk ${t.foreignKeys.length}` : '',
    t.checks.length ? `check ${t.checks.length}` : '',
    t.options.length ? '옵션' : '',
    t.partition ? '파티션' : '',
    t.unparsed ? '원문' : '',
  ].filter(Boolean);
  return parts.join(' · ') || '변경';
}

// 루틴 변경 필드 → 화면 이름 (characteristics.* 는 '특성' 하나로 묶는다)
const ROUTINE_FIELD: Record<string, string> = { params: '파라미터', returns: 'RETURNS', body: '본문', sqlMode: 'SQL_MODE' };

function routineDetail(r: RoutineDiff): string {
  if (r.op === 'add') return '신규';
  if (r.op === 'drop') return '삭제';
  const labels = r.fields.map((f) => (f.startsWith('characteristics.') ? '특성' : ROUTINE_FIELD[f] ?? f));
  return [...new Set(labels)].join(' · ') || '변경';
}

function entryDetail(e: ObjectEntry): string {
  if (e.kind === 'table') return detail(e.table);
  if (e.routine) return routineDetail(e.routine);
  return e.op === 'modify' ? '정의 변경' : e.op === 'add' ? '신규' : '삭제';
}

export function SummaryTab({ data, onOpen }: { data: DiffResponse; onOpen: (kind: ObjectKind, name: string) => void }) {
  const { tables, views } = data.diff;
  const routines = data.diff.routines ?? [];
  const routinesUnknown = Boolean(data.diff.routinesUnknown);
  const hasRoutines = routines.length > 0 || (data.baseModel.routines ?? []).length > 0 || (data.targetModel.routines ?? []).length > 0;
  const routineCount = (op: RoutineDiff['op']) => routines.filter((r) => r.op === op).length;
  const count = (op: string) => tables.filter((t) => t.op === op).length;
  const fieldChanges = tables.reduce((n, t) => n + t.columns.length + t.indexes.length + t.foreignKeys.length + t.checks.length, 0);
  const entries = changedObjects(data.diff);
  const stats = [
    { value: `+${count('add')}`, label: '테이블 추가', tone: s.add },
    { value: `−${count('drop')}`, label: '테이블 삭제', tone: s.del },
    { value: `~${count('modify') + count('rename') + views.length}`, label: '테이블/뷰 변경', tone: s.mod },
    { value: String(fieldChanges), label: '컬럼·인덱스·제약 변경', tone: '' },
    ...(hasRoutines && !routinesUnknown
      ? [{ value: `+${routineCount('add')} −${routineCount('drop')} ~${routineCount('modify')}`, label: '루틴 추가/삭제/변경', tone: '' }]
      : []),
  ];
  return (
    <>
      <ul className={s.stats} aria-label="변경 통계">
        {stats.map((st) => (
          <li key={st.label} className={s.stat}>
            <div className={`${s.statValue} ${st.tone}`}>{st.value}</div>
            <div className={s.statLabel}>{st.label}</div>
          </li>
        ))}
      </ul>
      {routinesUnknown && <p className={s.notice} role="note">MD 출처라 루틴은 비교하지 않음 — td-export MD 에는 함수·프로시저가 없습니다</p>}
      {entries.length === 0 ? (
        <p className={s.empty}>두 버전 사이에 변경 사항이 없습니다</p>
      ) : (
        <div className={s.summary} role="group" aria-label="변경 객체">
          <div className={`${s.summaryRow} ${s.summaryHead}`} aria-hidden="true"><span /><span>객체</span><span>종류</span><span>세부 변경</span></div>
          {entries.map((e) => (
            <button key={e.key} type="button" className={s.summaryRow} onClick={() => onOpen(e.kind, e.name)}>
              <Mark op={e.op} />
              <span className={s.code}>{e.oldName && e.op === 'rename' ? `${e.oldName} → ${e.name}` : e.name}</span>
              <span>{e.kind}</span>
              <span>{entryDetail(e)}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
