import type { KeyboardEvent } from 'react';

// WAI-ARIA radiogroup 키보드 동작: ←/↑ 는 이전, →/↓ 는 다음(끝에서 처음으로 돈다). 방향키가 아니면 undefined
export function nextRadioValue<T>(key: string, values: readonly T[], current: T): T | undefined {
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  if (step === 0 || values.length === 0) return undefined;
  const index = Math.max(0, values.indexOf(current));
  return values[(index + step + values.length) % values.length];
}

// radiogroup 의 onKeyDown. 다음 값을 고르고, moveFocus 면 그 라디오로 포커스를 옮긴다.
// 고른 뒤 버튼 순서가 바뀌는 그룹(DDL 방향처럼 선택이 항상 앞에 오는 경우)은 moveFocus=false 로 둔다
export function handleRadioKeys<T>(e: KeyboardEvent<HTMLElement>, values: readonly T[], current: T, select: (v: T) => void, moveFocus = true): void {
  const next = nextRadioValue(e.key, values, current);
  if (next === undefined) return;
  e.preventDefault();
  select(next);
  if (moveFocus) e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[values.indexOf(next)]?.focus();
}
