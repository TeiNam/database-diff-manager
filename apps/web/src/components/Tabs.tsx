import s from './Tabs.module.css';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  badge?: number;
}

export function Tabs<T extends string>({ value, items, onChange }: { value: T; items: TabItem<T>[]; onChange: (id: T) => void }) {
  return (
    <div className={s.tabs} role="tablist">
      {items.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} className={value === t.id ? s.on : undefined} onClick={() => onChange(t.id)}>
          {t.label}
          {t.badge !== undefined && <span className={s.pill}>{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}
