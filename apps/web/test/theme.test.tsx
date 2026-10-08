import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useTheme } from '../src/theme';

describe('useTheme', () => {
  it('저장값이 없으면 시스템 설정(없으면 dark), 토글하면 저장하고 html에 반영', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    act(() => result.current.toggle());
    expect(result.current.theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('tdm-theme')).toBe('light');
  });

  it('저장값을 우선한다', () => {
    localStorage.setItem('tdm-theme', 'light');
    expect(renderHook(() => useTheme()).result.current.theme).toBe('light');
  });

  it('localStorage 가 막혀 있어도 시스템 기본값으로 시작하고 토글된다', () => {
    const blocked = () => { throw new DOMException('blocked', 'SecurityError'); };
    const spies = (['getItem', 'setItem'] as const).map((m) => vi.spyOn(Storage.prototype, m).mockImplementation(blocked));
    try {
      const { result } = renderHook(() => useTheme());
      expect(result.current.theme).toBe('dark');
      act(() => result.current.toggle());
      expect(result.current.theme).toBe('light');
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
