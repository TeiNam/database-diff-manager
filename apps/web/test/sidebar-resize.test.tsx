import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { SidebarResizer } from '../src/layout/SidebarResizer';
import { clampSidebar, SIDEBAR_DEFAULT, SIDEBAR_MIN, sidebarMax, useSidebarWidth } from '../src/layout/useSidebarWidth';

function Harness() {
  const { width, setWidth, reset } = useSidebarWidth();
  return <SidebarResizer width={width} onChange={setWidth} onReset={reset} />;
}

const handle = () => screen.getByRole('separator', { name: '사이드바 너비 조절' });
const valueOf = () => Number(handle().getAttribute('aria-valuenow'));

describe('사이드바 너비 조절', () => {
  afterEach(() => localStorage.clear());

  it('범위는 200px ~ min(600px, 화면의 40%)', () => {
    expect(sidebarMax(2000)).toBe(600);
    expect(sidebarMax(1000)).toBe(400);
    expect(sidebarMax(300)).toBe(SIDEBAR_MIN);
    expect(clampSidebar(100, 1440)).toBe(SIDEBAR_MIN);
    expect(clampSidebar(999, 1440)).toBe(576);
    expect(clampSidebar(300.4, 1440)).toBe(300);
  });

  it('드래그한 만큼 너비가 바뀌고 저장된다', () => {
    render(<Harness />);
    expect(valueOf()).toBe(SIDEBAR_DEFAULT);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 272, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 352, pointerId: 1 });
    fireEvent.pointerUp(handle(), { pointerId: 1 });
    expect(valueOf()).toBe(352);
    expect(localStorage.getItem('tdm-sidebar-width')).toBe('352');
    // 드래그가 끝난 뒤의 이동은 무시한다
    fireEvent.pointerMove(handle(), { clientX: 100, pointerId: 1 });
    expect(valueOf()).toBe(352);
  });

  it('←/→ 는 16px 씩, Home/End 는 최소·최대, 더블클릭은 기본값', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    handle().focus();
    await user.keyboard('{ArrowRight}');
    expect(valueOf()).toBe(SIDEBAR_DEFAULT + 16);
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(valueOf()).toBe(SIDEBAR_DEFAULT - 16);
    await user.keyboard('{Home}');
    expect(valueOf()).toBe(SIDEBAR_MIN);
    await user.keyboard('{End}');
    expect(valueOf()).toBe(sidebarMax());
    await user.dblClick(handle());
    expect(valueOf()).toBe(SIDEBAR_DEFAULT);
    expect(localStorage.getItem('tdm-sidebar-width')).toBeNull();
  });

  it('저장된 너비로 시작하고, 범위를 벗어난 값은 맞춘다', () => {
    localStorage.setItem('tdm-sidebar-width', '320');
    const { unmount } = render(<Harness />);
    expect(valueOf()).toBe(320);
    unmount();
    localStorage.setItem('tdm-sidebar-width', '5000');
    render(<Harness />);
    expect(valueOf()).toBe(sidebarMax());
  });
});
