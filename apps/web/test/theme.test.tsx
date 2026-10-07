import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
});
