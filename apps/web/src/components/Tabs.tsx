import type { ReactNode } from 'react';
import s from './Tabs.module.css';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  badge?: number;
}

// actions: 탭 줄 오른쪽에 두는 조작 (tablist 밖에 둔다)
export function Tabs<T extends string>({ value, items, onChange, actions }: { value: T; items: TabItem<T>[]; onChange: (id: T) => void; actions?: ReactNode }) {
  return (
    <div className={s.tabs}>
      <div className={s.list} role="tablist">
        {items.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={value === t.id} className={value === t.id ? s.on : undefined} onClick={() => onChange(t.id)}>
            {t.label}
            {t.badge !== undefined && <span className={s.pill}>{t.badge}</span>}
          </button>
        ))}
      </div>
      {actions && <div className={s.actions}>{actions}</div>}
    </div>
  );
}
