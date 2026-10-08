import type { ColumnFlowStatus, TableFlowStatus } from '@tdm/core';
import s from './migration.module.css';

type Status = TableFlowStatus | ColumnFlowStatus;
type Tone = 'ok' | 'rename' | 'del' | 'warn' | 'muted';

const LABEL: Record<Status, string> = {
  ok: '대응', 'missing-target': 'To-Be 없음', 'missing-source': 'As-Is 없음', excluded: '제외', 'unmapped-target': '신규',
  renamed: '이름변경', same: '동일', removed: '컬럼삭제', added: '신규', dropped: '대응 없음', missing: '룰 대상 없음',
};

// 정상(add)·이름변경(accent)·삭제(del)·확인 필요(mod)·중립(muted). 색만으로 구분하지 않도록 문구를 항상 함께 쓴다
const TONE: Record<Status, Tone> = {
  ok: 'ok', 'missing-target': 'warn', 'missing-source': 'warn', excluded: 'muted', 'unmapped-target': 'ok',
  renamed: 'rename', same: 'muted', removed: 'del', added: 'ok', dropped: 'warn', missing: 'warn',
};

export const statusLabel = (status: Status): string => LABEL[status];

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`${s.badge} ${s[TONE[status]]}`}>{LABEL[status]}</span>;
}
