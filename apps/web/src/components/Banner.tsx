import type { ReactNode } from 'react';
import s from './Banner.module.css';

// className 으로 놓이는 곳의 여백을 덮어쓸 수 있다 (예: 이미 padding 이 있는 컨테이너 안)
export function Banner({ tone, label, role, className, children }: { tone: 'info' | 'warn'; label?: string; role?: 'alert' | 'status'; className?: string; children: ReactNode }) {
  return <section className={[s.banner, s[tone], className].filter(Boolean).join(' ')} aria-label={label} role={role ?? (label ? 'region' : undefined)}>{children}</section>;
}
