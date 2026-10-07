import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime } from '../src/lib/format';

// 표시 시간대를 고정해 UTC 저장값이 로컬(KST)로 바뀌는지 확인한다
process.env.TZ = 'Asia/Seoul';

describe('시각 표시', () => {
  it('UTC ISO 문자열을 로컬 시간대로 표시한다 (날짜가 넘어가는 경우 포함)', () => {
    expect(formatDateTime('2026-10-07T17:34:56.000Z')).toBe('2026-10-08 02:34');
    expect(formatDate('2026-10-07T17:34:56.000Z')).toBe('2026-10-08');
  });

  it('두 자리로 채우고, 해석할 수 없는 값은 원문을 그대로 돌려준다', () => {
    expect(formatDateTime('2026-01-02T00:05:00Z')).toBe('2026-01-02 09:05');
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});
