import { useCallback, useState } from 'react';

const STORAGE_KEY = 'tdm-sidebar-width';
export const SIDEBAR_DEFAULT = 272;
export const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 600;
const MAX_VIEWPORT_RATIO = 0.4;

// 화면이 좁으면 최대 너비도 줄인다 (본문 영역이 너무 좁아지지 않게)
export const sidebarMax = (viewport: number = window.innerWidth): number =>
  Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(viewport * MAX_VIEWPORT_RATIO)));

export const clampSidebar = (width: number, viewport?: number): number =>
  Math.round(Math.min(sidebarMax(viewport), Math.max(SIDEBAR_MIN, width)));

function initialWidth(): number {
  const saved = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(saved) && saved > 0 ? clampSidebar(saved) : SIDEBAR_DEFAULT;
}

// 사이드바 너비 상태. 바꿀 때마다 범위를 맞추고 localStorage 에 저장한다
export function useSidebarWidth() {
  const [width, setState] = useState(initialWidth);
  const setWidth = useCallback((next: number) => {
    const clamped = clampSidebar(next);
    localStorage.setItem(STORAGE_KEY, String(clamped));
    setState(clamped);
  }, []);
  const reset = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setState(SIDEBAR_DEFAULT);
  }, []);
  return { width, setWidth, reset };
}
