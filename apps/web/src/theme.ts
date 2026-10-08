import { useCallback, useEffect, useState } from 'react';
import { readStorage, writeStorage } from './lib/storage';

export type Theme = 'dark' | 'light';
const STORAGE_KEY = 'tdm-theme';

export function initialTheme(): Theme {
  const saved = readStorage(STORAGE_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// 사용자가 직접 고른 경우에만 저장한다 (그 전에는 시스템 설정을 따른다)
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      writeStorage(STORAGE_KEY, next);
      return next;
    });
  }, []);
  return { theme, toggle };
}
