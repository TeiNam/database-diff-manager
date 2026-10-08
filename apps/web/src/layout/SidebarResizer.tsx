import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import s from './AppShell.module.css';
import { SIDEBAR_MIN, sidebarMax } from './useSidebarWidth';

const KEY_STEP = 16;

interface Props {
  width: number;
  onChange: (width: number) => void; // 드래그 중: 화면만 바꾼다
  onCommit: (width: number) => void; // 드래그 끝·키보드: 저장까지 한다
  onReset: () => void;
}

// 사이드바 오른쪽 경계의 너비 조절 핸들: 드래그, ←/→·Home/End, 더블클릭으로 기본값
export function SidebarResizer({ width, onChange, onCommit, onReset }: Props) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const last = useRef(width); // 드래그 중 마지막으로 계산한 너비 (pointerup 에서 저장한다)
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    start.current = { x: e.clientX, width };
    last.current = width;
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    last.current = start.current.width + e.clientX - start.current.x;
    onChange(last.current);
  };
  const stop = () => {
    if (start.current) onCommit(last.current);
    start.current = null;
    setDragging(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') onCommit(width - KEY_STEP);
    else if (e.key === 'ArrowRight') onCommit(width + KEY_STEP);
    else if (e.key === 'Home') onCommit(SIDEBAR_MIN);
    else if (e.key === 'End') onCommit(sidebarMax());
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
