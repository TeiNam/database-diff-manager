import type { DiffResponse } from '../../api/types';
import { changedObjects } from '../../lib/object-diff';

// 리포트를 만드는 데 쓰는 화면 밖 정보 (설계 §4)
export interface ReportOptions {
  mode: 'sql' | 'grid';
  layout: 'split' | 'unified';
  generatedAt: Date;
  generatedBy: string;
  appVersion: string;
  scope?: 'changes' | 'all'; // all: 변경 없는 객체도 넣는다 (기본 changes)
  excludeAdded?: boolean; // BASE 에 없는(추가된) 객체를 뺀다
  excludeDropped?: boolean; // TARGET 에 없는(삭제된) 객체를 뺀다
}

// 뺀 객체 종류 — 머리말에 적는다. 빼지 않았으면 빈 문자열
export function excludedLabel(opts: Pick<ReportOptions, 'excludeAdded' | 'excludeDropped'>): string {
  return [opts.excludeAdded && '추가된 객체', opts.excludeDropped && '삭제된 객체'].filter(Boolean).join(', ');
}

// 추가·삭제 객체를 뺀 비교 결과. 요약 통계·목록·객체 diff·안내의 문장 수가 모두 같은 목록을 쓰도록 diff 와 그 객체의 문장을 거른다
export function filterReportData(data: DiffResponse, opts: Pick<ReportOptions, 'excludeAdded' | 'excludeDropped'>): DiffResponse {
  if (!opts.excludeAdded && !opts.excludeDropped) return data;
  const isExcluded = ({ op }: { op: string }) => (opts.excludeAdded === true && op === 'add') || (opts.excludeDropped === true && op === 'drop');
  const keep = (d: { op: string }) => !isExcluded(d);
  const { diff } = data;
  const excluded = new Set(changedObjects(diff).filter(isExcluded).map((e) => `${e.kind}:${e.name}`));
  return {
    ...data,
    diff: { ...diff, tables: diff.tables.filter(keep), views: diff.views.filter(keep), routines: (diff.routines ?? []).filter(keep) },
    statements: data.statements.filter((st) => !excluded.has(`${st.kind}:${st.object}`)),
  };
}

// 실제로 뺀 객체가 있는 종류만 남긴다 — 빼려 한 종류가 비교에 없으면 머리말·빈 목록 문구에 적지 않는다
export function effectiveExclusions(data: DiffResponse, opts: ReportOptions): ReportOptions {
  const ops = new Set(changedObjects(data.diff).map((e) => e.op));
  return { ...opts, excludeAdded: opts.excludeAdded === true && ops.has('add'), excludeDropped: opts.excludeDropped === true && ops.has('drop') };
}

// 거른 뒤 남은 변경이 없을 때 요약 목록 문구 — 원래 변경이 없던 비교와 구분한다
export const filteredEmptyMessage = (opts: Pick<ReportOptions, 'excludeAdded' | 'excludeDropped'>): string | undefined =>
  excludedLabel(opts) ? `${excludedLabel(opts)}를 뺀 뒤 남은 변경 객체가 없습니다` : undefined;

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
