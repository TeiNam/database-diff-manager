import type { ReactNode } from 'react';
import s from './Banner.module.css';

export function Banner({ tone, label, role, children }: { tone: 'info' | 'warn'; label?: string; role?: 'alert' | 'status'; children: ReactNode }) {
  return <section className={`${s.banner} ${s[tone]}`} aria-label={label} role={role ?? (label ? 'region' : undefined)}>{children}</section>;
}
