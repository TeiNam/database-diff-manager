import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import s from './AppShell.module.css';
import { SIDEBAR_MIN, sidebarMax } from './useSidebarWidth';

const KEY_STEP = 16;

interface Props {
  width: number;
  onChange: (width: number) => void;
  onReset: () => void;
}

// 사이드바 오른쪽 경계의 너비 조절 핸들: 드래그, ←/→·Home/End, 더블클릭으로 기본값
export function SidebarResizer({ width, onChange, onReset }: Props) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    start.current = { x: e.clientX, width };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    onChange(start.current.width + e.clientX - start.current.x);
  };
  const stop = () => {
    start.current = null;
    setDragging(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') onChange(width - KEY_STEP);
    else if (e.key === 'ArrowRight') onChange(width + KEY_STEP);
    else if (e.key === 'Home') onChange(SIDEBAR_MIN);
    else if (e.key === 'End') onChange(sidebarMax());
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="사이드바 너비 조절"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={sidebarMax()}
      tabIndex={0}
      title="드래그해서 너비 조절 · 더블클릭하면 기본 너비"
      className={`${s.resizer} ${dragging ? s.dragging : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
