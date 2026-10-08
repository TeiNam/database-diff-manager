import { useCallback, useEffect, useState } from 'react';
import { readStorage, writeStorage } from '../lib/storage';

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
  const saved = Number(readStorage(STORAGE_KEY));
  return Number.isFinite(saved) && saved > 0 ? clampSidebar(saved) : SIDEBAR_DEFAULT;
}

// 사이드바 너비 상태. setWidth 는 화면만 바꾸고(드래그 중), saveWidth 는 범위를 맞춰 저장까지 한다(드래그 끝·키보드).
// 창 크기가 바뀌면 최대 너비가 달라지므로 다시 범위를 맞춘다 (저장값은 사용자가 고른 값 그대로 둔다)
export function useSidebarWidth() {
  const [width, setState] = useState(initialWidth);
  const setWidth = useCallback((next: number) => setState(clampSidebar(next)), []);
  const saveWidth = useCallback((next: number) => {
    const clamped = clampSidebar(next);
    writeStorage(STORAGE_KEY, String(clamped));
    setState(clamped);
  }, []);
  const reset = useCallback(() => {
    writeStorage(STORAGE_KEY, null);
    setState(SIDEBAR_DEFAULT);
  }, []);
  useEffect(() => {
    const onResize = () => setState((current) => clampSidebar(current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return { width, setWidth, saveWidth, reset };
}
