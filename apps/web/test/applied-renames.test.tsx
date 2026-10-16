import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppliedRenames } from '../src/features/diff/AppliedRenames';

const MANUAL = { kind: 'column', table: 'orders', from: 'x', to: 'y', source: 'manual' };
const REVERSED = { kind: 'column', table: 'orders', from: 'a', to: 'b', source: 'manual', reversed: true };
const DMS = { kind: 'table', from: 'members', to: 'member', source: 'dms' };
const data = (renames: unknown[], ignoredRenames: unknown[] = []) => ({ diff: { ignoredRenames }, renames }) as never;
const dmsDetails = () => screen.getByRole('region', { name: 'DMS 매핑에서 적용된 이름 변경' }).querySelector('details');

describe('AppliedRenames', () => {
  it('해제 렌더러가 없으면 읽기 전용으로 출처와 함께 보이고, DMS 목록은 접혀 있다', () => {
    render(<AppliedRenames data={data([MANUAL, REVERSED, DMS])} />);
    const applied = screen.getByRole('region', { name: '적용된 이름 변경' });
    expect(applied).toHaveTextContent(/수동\s*orders\.x → y/);
    expect(applied).toHaveTextContent(/수동 · 역방향\s*orders\.a → b/);
    expect(within(applied).queryByRole('button')).not.toBeInTheDocument();
    expect(dmsDetails()).not.toHaveAttribute('open');
    expect(dmsDetails()).toHaveTextContent('이름 변경 1건');
  });

  it('dmsOpen 이면 DMS 목록을 펼치고, 해제 렌더러는 이 쌍에 저장된 수동 매핑에만 붙는다', () => {
    render(<AppliedRenames data={data([MANUAL, REVERSED, DMS])} dmsOpen renderRelease={(r) => <button type="button">해제 {r.from}</button>} />);
    expect(dmsDetails()).toHaveAttribute('open');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['해제 x']);
  });

  it('적용하지 못한 rename 을 이유와 함께 보인다', () => {
    render(<AppliedRenames data={data([], [{ mapping: { kind: 'table', from: 'a', to: 'b' }, reason: 'BASE 에 a 가 없습니다' }])} />);
    expect(screen.getByRole('region', { name: '적용하지 못한 이름 변경' })).toHaveTextContent('a → b: BASE 에 a 가 없습니다');
    expect(screen.queryByRole('region', { name: '적용된 이름 변경' })).not.toBeInTheDocument();
  });
});
