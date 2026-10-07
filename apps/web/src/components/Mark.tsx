import type { Op } from '@tdm/core';
import s from './Mark.module.css';

const SYMBOL: Record<Op | 'same', string> = { add: '+', drop: '−', modify: '~', rename: '>', same: '' };
const LABEL: Record<Op | 'same', string> = { add: '추가', drop: '삭제', modify: '변경', rename: '이름 변경', same: '변경 없음' };

// 색과 기호를 함께 쓴다 (색각 이상 대응)
export function Mark({ op }: { op: Op | 'same' }) {
  return (
    <span className={`${s.mark} ${s[op]}`} role="img" aria-label={LABEL[op]}>
      {SYMBOL[op]}
    </span>
  );
}
