import type { DiffResponse } from '../../api/types';

// 리포트를 만드는 데 쓰는 화면 밖 정보 (설계 §4)
export interface ReportOptions {
  mode: 'sql' | 'grid';
  layout: 'split' | 'unified';
  generatedAt: Date;
  generatedBy: string;
  appVersion: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
// 파일 이름에 쓸 수 없는 글자: / \ : * ? " < > | 와 제어 문자 (설계 §5)
const UNSAFE_FILE_CHARS = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;
const safePart = (value: string) => value.replace(UNSAFE_FILE_CHARS, '_');
const localDate = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
const localTime = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`;

export const reportTitle = (data: DiffResponse): string => `${data.target.databaseName} › ${data.target.schemaName} 비교 리포트`;

export function viewLabel(mode: ReportOptions['mode'], layout: ReportOptions['layout']): string {
  if (mode === 'grid') return '표';
  return layout === 'split' ? 'SQL Split' : 'SQL Unified';
}

// {DB}_{스키마}_v{BASE}-v{TARGET}_{YYYYMMDD-HHmm}.html (로컬 시간)
export function reportFileName(data: DiffResponse, at: Date): string {
  const stamp = `${localDate(at).replaceAll('-', '')}-${localTime(at).replace(':', '')}`;
  return `${safePart(data.target.databaseName)}_${safePart(data.target.schemaName)}_v${data.base.versionNo}-v${data.target.versionNo}_${stamp}.html`;
}

// 만든 시각: 로컬 시간과 시간대 — 예: 2026-10-16 14:05 (Asia/Seoul, UTC+09:00)
export function formatGeneratedAt(at: Date): string {
  const offset = -at.getTimezoneOffset();
  const abs = Math.abs(offset);
  const utc = `UTC${offset >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${localDate(at)} ${localTime(at)} (${zone}, ${utc})`;
}
