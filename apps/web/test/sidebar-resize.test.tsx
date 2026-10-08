import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarResizer } from '../src/layout/SidebarResizer';
import { clampSidebar, SIDEBAR_DEFAULT, SIDEBAR_MIN, sidebarMax, useSidebarWidth } from '../src/layout/useSidebarWidth';

function Harness() {
  const { width, setWidth, saveWidth, reset } = useSidebarWidth();
  return <SidebarResizer width={width} onChange={setWidth} onCommit={saveWidth} onReset={reset} />;
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
    // 드래그 중에는 화면만 바꾸고 저장하지 않는다
    expect(valueOf()).toBe(352);
    expect(localStorage.getItem('tdm-sidebar-width')).toBeNull();
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
    expect(localStorage.getItem('tdm-sidebar-width')).toBe(String(SIDEBAR_DEFAULT + 16));
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

  it('창 크기가 줄면 다시 범위를 맞춘다', () => {
    const original = window.innerWidth;
    try {
      localStorage.setItem('tdm-sidebar-width', '500');
      window.innerWidth = 1440;
      render(<Harness />);
      expect(valueOf()).toBe(500);
      window.innerWidth = 1000;
      act(() => { window.dispatchEvent(new Event('resize')); });
      expect(valueOf()).toBe(400);
    } finally {
      window.innerWidth = original;
    }
  });

  it('localStorage 가 막힌 환경에서도 기본값으로 동작한다', async () => {
    const blocked = () => { throw new DOMException('blocked', 'SecurityError'); };
    const spies = (['getItem', 'setItem', 'removeItem'] as const).map((m) => vi.spyOn(Storage.prototype, m).mockImplementation(blocked));
    try {
      const user = userEvent.setup();
      render(<Harness />);
      expect(valueOf()).toBe(SIDEBAR_DEFAULT);
      handle().focus();
      await user.keyboard('{ArrowRight}');
      expect(valueOf()).toBe(SIDEBAR_DEFAULT + 16);
      await user.dblClick(handle());
      expect(valueOf()).toBe(SIDEBAR_DEFAULT);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
