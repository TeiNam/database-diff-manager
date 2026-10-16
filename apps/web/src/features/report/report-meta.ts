import type { DiffResponse } from '../../api/types';

// 리포트를 만드는 데 쓰는 화면 밖 정보 (설계 §4)
export interface ReportOptions {
  mode: 'sql' | 'grid';
  layout: 'split' | 'unified';
  generatedAt: Date;
  generatedBy: string;
  appVersion: string;
  excludeAdded?: boolean; // BASE 에 없는(추가된) 객체를 뺀다
  excludeDropped?: boolean; // TARGET 에 없는(삭제된) 객체를 뺀다
}

// 뺀 객체 종류 — 머리말에 적는다. 빼지 않았으면 빈 문자열
export function excludedLabel(opts: Pick<ReportOptions, 'excludeAdded' | 'excludeDropped'>): string {
  return [opts.excludeAdded && '추가된 객체', opts.excludeDropped && '삭제된 객체'].filter(Boolean).join(', ');
}

// 추가·삭제 객체를 뺀 비교 결과. 요약 통계·목록·객체 diff 가 모두 같은 목록을 쓰도록 diff 자체를 거른다
export function filterReportData(data: DiffResponse, opts: Pick<ReportOptions, 'excludeAdded' | 'excludeDropped'>): DiffResponse {
  if (!opts.excludeAdded && !opts.excludeDropped) return data;
  const keep = ({ op }: { op: string }) => !(opts.excludeAdded && op === 'add') && !(opts.excludeDropped && op === 'drop');
  const { diff } = data;
  return { ...data, diff: { ...diff, tables: diff.tables.filter(keep), views: diff.views.filter(keep), routines: (diff.routines ?? []).filter(keep) } };
}

const pad = (n: number) => String(n).padStart(2, '0');
// 파일 이름에 쓸 수 없는 글자: / \ : * ? " < > | 와 제어 문자 (설계 §5)
const UNSAFE_FILE_CHARS = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;
const safePart = (value: string) => value.replace(UNSAFE_FILE_CHARS, '_');
const localDate = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
const localTime = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`;

const sameSchema = (data: DiffResponse) => data.base.databaseName === data.target.databaseName && data.base.schemaName === data.target.schemaName;

// 다른 DB·스키마끼리 비교하면 양쪽 이름을 모두 적는다
export const reportTitle = (data: DiffResponse): string =>
  sameSchema(data)
    ? `${data.target.databaseName} › ${data.target.schemaName} 비교 리포트`
    : `${data.base.databaseName} › ${data.base.schemaName} ↔ ${data.target.databaseName} › ${data.target.schemaName} 비교 리포트`;

export function viewLabel(mode: ReportOptions['mode'], layout: ReportOptions['layout']): string {
  if (mode === 'grid') return '표';
  return layout === 'split' ? 'SQL Split' : 'SQL Unified';
}

// {DB}_{스키마}_v{BASE}-v{TARGET}_{YYYYMMDD-HHmm}.html (로컬 시간). 다른 DB·스키마끼리면 {DB}_{스키마}_v{BASE}-{DB}_{스키마}_v{TARGET}_…
export function reportFileName(data: DiffResponse, at: Date): string {
  const stamp = `${localDate(at).replaceAll('-', '')}-${localTime(at).replace(':', '')}`;
  const side = (v: DiffResponse['base']) => `${safePart(v.databaseName)}_${safePart(v.schemaName)}`;
  const pair = sameSchema(data)
    ? `${side(data.target)}_v${data.base.versionNo}-v${data.target.versionNo}`
    : `${side(data.base)}_v${data.base.versionNo}-${side(data.target)}_v${data.target.versionNo}`;
  return `${pair}_${stamp}.html`;
}

// 만든 시각: 로컬 시간과 시간대 — 예: 2026-10-16 14:05 (Asia/Seoul, UTC+09:00)
export function formatGeneratedAt(at: Date): string {
  const offset = -at.getTimezoneOffset();
  const abs = Math.abs(offset);
  const utc = `UTC${offset >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${localDate(at)} ${localTime(at)} (${zone}, ${utc})`;
}
